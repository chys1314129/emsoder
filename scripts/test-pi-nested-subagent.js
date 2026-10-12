#!/usr/bin/env node
/*
 * Exact regression for 女娲 Phase 5「双Agent精炼」:
 * parent Pi Agent calls spawn_subagent; while host is still handling that
 * tool.invoke request it dispatches TWO agent.subagentRun requests through
 * the same sidecar client. This proves nested/re-entrant RPC does not deadlock.
 */
const assert = require("assert");
const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");
const { METHODS, parseLine, encode, request } = require("../src/pi/protocol");

const SIDECAR = process.env.PI_SIDECAR || path.join(__dirname, "..", "src", "pi", "sidecar.mjs");

function message(stopReason, content) {
  return {
    role: "assistant", content, api: "openai-completions", provider: "test", model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
    stopReason, timestamp: Date.now(),
  };
}

(async () => {
  const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  const events = [];
  const subProviderSessions = new Set();
  let parentProviderTurns = 0;
  let parentSpawnInvoke = 0;

  const reply = (id, result) => {
    const p = pending.get(String(id));
    if (p) { clearTimeout(p.timer); pending.delete(String(id)); }
    child.stdin.write(encode({ jsonrpc: "2.0", id, result }));
  };
  const ask = (method, params, timeoutMs = 25000) => new Promise((resolve, reject) => {
    const id = `host-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(encode(request(id, method, params)));
  });

  rl.on("line", async (raw) => {
    const m = parseLine(raw); if (!m) return;
    if (m.id != null && !m.method) {
      const p = pending.get(String(m.id));
      if (p) { clearTimeout(p.timer); pending.delete(String(m.id)); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }
      return;
    }
    if (m.method === METHODS.agentEvent) {
      events.push(m.params || {});
      return;
    }
    if (m.method === METHODS.oauthToken) { reply(m.id, { ok: false, error: "no oauth" }); return; }
    if (m.method === METHODS.compactHost) { reply(m.id, { compacted: false }); return; }
    if (m.method === METHODS.providerStream) {
      const p = m.params || {};
      if (p.subSessionId) {
        subProviderSessions.add(p.subSessionId);
        reply(m.id, {
          events: [{ type: "text", text: `子代理 ${p.subSessionId} 审核完成` }],
          final: message("stop", [{ type: "text", text: `子代理 ${p.subSessionId} 审核完成` }]),
        });
        return;
      }
      parentProviderTurns += 1;
      if (parentProviderTurns === 1) {
        reply(m.id, {
          events: [{ type: "tool_call", call: {
            id: "spawn-1", index: 0, name: "spawn_subagent",
            arguments: JSON.stringify({
              tasks: [
                { task: "Agent A：做结构优化评审" },
                { task: "Agent B：做激活条件评审" },
              ],
              maxRounds: 3,
            }),
          } }],
          final: message("toolUse", [{ type: "toolCall", id: "spawn-1", name: "spawn_subagent", arguments: {} }]),
        });
      } else {
        reply(m.id, {
          events: [{ type: "text", text: "已综合两份双Agent评审并完成精炼。" }],
          final: message("stop", [{ type: "text", text: "已综合两份双Agent评审并完成精炼。" }]),
        });
      }
      return;
    }
    if (m.method === METHODS.toolInvoke) {
      const p = m.params || {};
      if (p.name !== "spawn_subagent") {
        reply(m.id, { ok: true, content: "tool ok" });
        return;
      }
      parentSpawnInvoke += 1;
      try {
        // Critical nested path: we are still awaiting parent tool.invoke, while
        // two child runtime requests run over the SAME NDJSON connection.
        const tasks = ["Agent A：做结构优化评审", "Agent B：做激活条件评审"];
        const results = await Promise.all(tasks.map((task, i) => ask(METHODS.subagentRun, {
          sessionId: p.sessionId,
          subSessionId: `phase5-${i + 1}`,
          turnId: p.turnId,
          task,
          systemPrompt: "你是女娲 Phase 5 独立评审子代理，完成任务后给出具体建议。",
          provider: { id: "t", type: "openai", baseUrl: "http://x", model: "test-model" },
          model: "test-model",
          tools: [{ name: "noop", label: "noop", description: "noop", parameters: {} }],
          maxRounds: 3,
        })));
        reply(m.id, {
          ok: true,
          content: results.map((r, i) => `Agent ${i + 1}: ${r.content}`).join("\n\n"),
        });
      } catch (e) {
        reply(m.id, { ok: false, content: String(e?.message || e) });
      }
      return;
    }
  });

  const parentDone = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("parent agent_end timeout (nested subagents likely deadlocked)")), 45000);
    const check = () => {
      const ended = events.some((e) => e.sessionId === "phase5-parent" && e.event?.type === "agent_end");
      if (ended) { clearTimeout(timer); resolve(); }
      else setTimeout(check, 40);
    };
    check();
  });

  const accepted = await ask(METHODS.prompt, {
    sessionId: "phase5-parent", turnId: "phase5-turn", content: "执行双Agent精炼",
    provider: { id: "t", type: "openai", baseUrl: "http://x", model: "test-model" },
    model: "test-model", systemPrompt: "sys", history: [],
    tools: [
      { name: "spawn_subagent", label: "spawn_subagent", description: "spawn", parameters: {} },
      { name: "noop", label: "noop", description: "noop", parameters: {} },
    ],
  });
  assert.strictEqual(accepted.accepted, true, "parent prompt accepted");
  await parentDone;
  assert.strictEqual(parentSpawnInvoke, 1, "one parent spawn_subagent invocation");
  assert.deepStrictEqual([...subProviderSessions].sort(), ["phase5-1", "phase5-2"], "both Phase 5 child agents ran");
  assert.ok(parentProviderTurns >= 2, "parent resumed after subagent results");

  child.kill(); rl.close();
  for (const p of pending.values()) clearTimeout(p.timer);
  console.log("OK nested dual-subagent refinement completes without deadlock");
})().catch((e) => { console.error(e); process.exit(1); });
