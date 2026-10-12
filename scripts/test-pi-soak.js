#!/usr/bin/env node
/*
 * 多 Pi 会话并行 soak：
 *  A) 同一 sidecar 内 4 个会话交错并行跑工具回合，验证会话隔离 + 事件路由。
 *  B) 子代理（agent.subagentRun）独立上下文 + 结果回收 + 清理。
 *  C) plan 模式：第一轮只出计划并停（plan_ready），批准后才放行工具。
 *  D) 崩溃恢复（客户端级）：kill 子进程 → onExit 通知 → 重建后 health 恢复。
 */
const assert = require("assert");
const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");
const { METHODS, parseLine, encode, request } = require("../src/pi/protocol");
const { PiSidecarClient } = require("../src/pi/sidecarClient");

const SIDECAR = process.env.PI_SIDECAR || path.join(__dirname, "..", "src", "pi", "sidecar.mjs");

function zeroMsg(stopReason, content) {
  return {
    role: "assistant", content, api: "openai-completions", provider: "test", model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
    stopReason, timestamp: Date.now(),
  };
}

function makeHost(child) {
  const pending = new Map();
  const events = [];          // agentEvent 记录
  const toolInvokes = [];     // {sessionId, subSessionId, name}
  const providerStreams = []; // {sessionId, subSessionId, messages}
  const rl = readline.createInterface({ input: child.stdout });
  const reply = (id, result) => {
    const p = pending.get(String(id));
    if (p) { clearTimeout(p.t); pending.delete(String(id)); }
    child.stdin.write(encode({ jsonrpc: "2.0", id, result }));
  };
  rl.on("line", (raw) => {
    const m = parseLine(raw); if (!m) return;
    if (m.id != null && !m.method) {
      const p = pending.get(String(m.id));
      if (p) { clearTimeout(p.t); pending.delete(String(m.id)); p.r(m); }
      return;
    }
    if (m.method === METHODS.agentEvent) {
      events.push({ sessionId: m.params?.sessionId, subSessionId: m.params?.subSessionId, type: m.params?.event?.type, planText: m.params?.event?.planText });
      return;
    }
    if (m.method === METHODS.oauthToken) { reply(m.id, { ok: false, error: "none" }); return; }
    if (m.method === METHODS.compactHost) { reply(m.id, { compacted: false }); return; }
    if (m.method === METHODS.providerStream) {
      const p = m.params || {};
      providerStreams.push({ sessionId: p.sessionId, subSessionId: p.subSessionId, messages: p.context?.messages || [] });
      // 计划会话第二轮（planApproved）给工具调用；其余一律直接文本完成
      const toolCall = hostMode.toolForPlanApproved && p.sessionId === "s-plan" && providerStreams.length % 2 === 0
        ? [{ type: "toolCall", id: "plan-call", name: "noop", arguments: {} }]
        : [];
      if (toolCall.length) {
        reply(m.id, {
          events: [{ type: "tool_call", call: { id: "plan-call", index: 0, name: "noop", arguments: "{}" } }],
          final: zeroMsg("toolUse", toolCall),
        });
      } else {
        reply(m.id, {
          events: [{ type: "text", text: p.subSessionId ? "子代理完成" : "完成" }],
          final: zeroMsg("stop", [{ type: "text", text: p.subSessionId ? "子代理完成" : "完成" }]),
        });
      }
      return;
    }
    if (m.method === METHODS.toolInvoke) {
      const p = m.params || {};
      toolInvokes.push({ sessionId: p.sessionId, subSessionId: p.subSessionId, name: p.name });
      reply(m.id, { ok: true, content: "tool ok" });
      return;
    }
  });
  const hostMode = { toolForPlanApproved: false };
  const req = (method, params, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const id = `t-${Math.random().toString(36).slice(2)}`;
    pending.set(id, { r: resolve, t: setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, timeoutMs) });
    child.stdin.write(encode(request(id, method, params)));
  });
  return { rl, req, events, toolInvokes, providerStreams, hostMode };
}

function promptParams(sessionId, extra = {}) {
  return {
    sessionId, turnId: `turn-${sessionId}`, content: "任务",
    provider: { id: "t", type: "openai", baseUrl: "http://x", model: "test-model" },
    model: "test-model", systemPrompt: "sys", history: [],
    tools: [{ name: "noop", label: "noop", description: "noop", parameters: {} }],
    ...extra,
  };
}

// ---------- A) 多会话并行隔离 ----------
async function parallelSessions() {
  const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const host = makeHost(child);
  const ids = ["s-a", "s-b", "s-c", "s-d"];
  const prompts = await Promise.all(ids.map((id) => host.req(METHODS.prompt, promptParams(id))));
  assert.ok(prompts.every((p) => p.result?.accepted), "all sessions accepted");

  // 等 4 个会话都跑完 agent_end
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ended = new Set(host.events.filter((e) => e.type === "agent_end").map((e) => e.sessionId));
    if (ids.every((id) => ended.has(id))) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  const ended = new Set(host.events.filter((e) => e.type === "agent_end").map((e) => e.sessionId));
  assert.ok(ids.every((id) => ended.has(id)), "all 4 sessions reached agent_end");

  const health = await host.req(METHODS.health, {});
  assert.strictEqual(health.result.runtimes, 4, "4 runtimes in sidecar");

  // 事件/请求路由：每个 provider.stream 的 sessionId 都来自我们的 4 个会话
  assert.ok(host.providerStreams.length >= 4, "provider requests seen");
  assert.ok(host.providerStreams.every((p) => ids.includes(p.sessionId)), "provider streams tagged with own session");
  for (const e of host.events) {
    assert.ok(ids.includes(e.sessionId), "agent events tagged with own session");
  }

  // dispose 全部会话 → runtimes 归零
  for (const id of ids) await host.req(METHODS.dispose, { sessionId: id });
  const health2 = await host.req(METHODS.health, {});
  assert.strictEqual(health2.result.runtimes, 0, "runtimes cleaned after dispose");
  child.kill(); host.rl.close();
  console.log("OK A) 4 parallel sessions isolated + disposed");
}

// ---------- B) 子代理 ----------
async function subagentRun() {
  const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const host = makeHost(child);
  await host.req(METHODS.prompt, promptParams("s-main", {
    content: "主任务", tools: [
      { name: "noop", label: "noop", description: "noop", parameters: {} },
      { name: "spawn_subagent", label: "spawn_subagent", description: "spawn", parameters: {} },
    ],
  }));
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !host.events.some((e) => e.sessionId === "s-main" && e.type === "agent_end")) {
    await new Promise((r) => setTimeout(r, 60));
  }
  const sub = await host.req(METHODS.subagentRun, {
    sessionId: "s-main", subSessionId: "sub-1", task: "子任务：研究并发",
    systemPrompt: "你是子代理", maxRounds: 3,
    provider: { id: "t", type: "openai", baseUrl: "http://x", model: "test-model" },
    model: "test-model",
    tools: [{ name: "noop", label: "noop", description: "noop", parameters: {} }],
  }, 20000);
  assert.strictEqual(sub.result.ok, true, "subagent ok");
  assert.ok(String(sub.result.content).includes("子代理完成"), "subagent final text returned");
  assert.strictEqual(sub.result.subSessionId, "sub-1", "subSessionId echoed");
  // 子代理的 provider 请求带 subSessionId
  assert.ok(host.providerStreams.some((p) => p.subSessionId === "sub-1"), "sub provider tagged");
  child.kill(); host.rl.close();
  console.log("OK B) subagent isolated runtime returns result");
}

// ---------- C) plan 模式 ----------
async function planMode() {
  const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const host = makeHost(child);
  await host.req(METHODS.prompt, promptParams("s-plan", { content: "给个计划", runMode: "plan" }));
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !host.events.some((e) => e.sessionId === "s-plan" && e.type === "plan_ready")) {
    await new Promise((r) => setTimeout(r, 60));
  }
  const plan = host.events.find((e) => e.sessionId === "s-plan" && e.type === "plan_ready");
  assert.ok(plan, "plan_ready emitted");
  assert.ok(String(plan.planText || "").length > 0, "plan text present");
  assert.ok(host.toolInvokes.length === 0, "no tools executed before approval");

  // 批准后：第二轮允许工具
  host.hostMode.toolForPlanApproved = true;
  await host.req(METHODS.prompt, promptParams("s-plan", {
    content: "批准计划：按计划执行", runMode: "plan", planApproved: true,
  }));
  const deadline2 = Date.now() + 10000;
  while (Date.now() < deadline2 && !host.events.some((e) => e.sessionId === "s-plan" && e.type === "agent_end" && host.toolInvokes.length)) {
    await new Promise((r) => setTimeout(r, 60));
  }
  assert.ok(host.toolInvokes.some((t) => t.sessionId === "s-plan" && t.name === "noop"), "tools executed after approval");
  child.kill(); host.rl.close();
  console.log("OK C) plan mode gates tools until approval");
}

// ---------- D) 崩溃恢复（客户端级）----------
async function crashRecovery() {
  let exited = null;
  const client = new PiSidecarClient({
    onExit: (code, signal) => { exited = { code, signal }; },
  });
  const h1 = await client.health();
  assert.strictEqual(h1.ok, true, "health before crash");
  const child = client.child;
  client.child.kill("SIGKILL");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !exited) await new Promise((r) => setTimeout(r, 40));
  assert.ok(exited, "onExit fired after kill");
  // 崩溃期间挂起：onExit 已通知；同一 client 的下一个请求会自动重拉进程并成功（自愈）
  const r2 = await client.status({ sessionId: "x" });
  assert.ok(r2 && r2.status, "request self-heals after crash (respawn)");
  const h2 = await client.health();
  assert.strictEqual(h2.ok, true, "health after respawn");
  assert.ok(exited, "onExit fired");
  await client.close();
  console.log("OK D) crash detected + client auto-respawn recovers");
}

(async () => {
  await parallelSessions();
  await subagentRun();
  await planMode();
  await crashRecovery();
  console.log("OK Pi multi-session parallel soak test");
})().catch((e) => { console.error(e); process.exit(1); });
