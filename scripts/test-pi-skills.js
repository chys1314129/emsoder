#!/usr/bin/env node
/*
 * Verify that the Pi sidecar (1) registers list_skills / load_skill tools with the
 * Pi Agent and (2) round-trips a tool.invoke back to the host for execution.
 * This is the regression for "Pi sidecar 重启后加载不了技能".
 */
const assert = require("assert");
const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");
const { METHODS, parseLine, encode, request, notification } = require("../src/pi/protocol");
const SIDECAR = process.env.PI_SIDECAR || path.join(__dirname, "..", "src", "pi", "sidecar.mjs");

function zeroMsg(over = {}) {
  return {
    role: "assistant", content: [], api: "openai-completions", provider: "test",
    model: "test-model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(), ...over,
  };
}

async function main() {
  const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const rl = readline.createInterface({ input: child.stdout });
  const rlErr = readline.createInterface({ input: child.stderr });
  rlErr.on("line", (l) => process.stderr.write(`[sidecar] ${l}\n`));

  const pending = new Map(); // id -> {resolve,reject,timer}
  const toolInvokes = [];
  let providerCalls = 0;

  const hostReply = (id, result) => {
    // Reply to a request the sidecar sent us (provider.stream / tool.invoke).
    const p = pending.get(String(id));
    if (p) { clearTimeout(p.timer); pending.delete(String(id)); }
    child.stdin.write(encode({ jsonrpc: "2.0", id, result }));
  };

  rl.on("line", (raw) => {
    const msg = parseLine(raw); if (!msg) return;
    const dbg = (m) => process.stderr.write(`[host→] ${m}\n`);
    // Responses from the sidecar to OUR requests (health/prompt).
    if (msg.id != null && !msg.method) {
      const p = pending.get(String(msg.id)); if (p) {
        clearTimeout(p.timer); pending.delete(String(msg.id));
        if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg);
      }
      return;
    }
    if (msg.method === METHODS.providerStream) {
      dbg(`provider.stream turn=${providerCalls + 1}`);
      const params = msg.params || {};
      const callId = "call-skills-1";
      providerCalls += 1;
      hostReply(msg.id, providerCalls === 1 ? {
        events: [
          { type: "tool_call", call: { id: callId, index: 0, name: "list_skills", arguments: "{}" } },
        ],
        final: zeroMsg({ content: [{
          type: "toolCall", id: callId, name: "list_skills", arguments: {},
        }], stopReason: "toolUse" }),
      } : {
        events: [{ type: "text", text: "技能列表已加载。" }],
        final: zeroMsg({ content: [{ type: "text", text: "技能列表已加载。" }] }),
      });
      return;
    }
    if (msg.method === METHODS.toolInvoke) {
      dbg(`tool.invoke ${msg.params?.name}`);
      toolInvokes.push(msg);
      const name = msg.params?.name;
      hostReply(msg.id, { ok: true, content: name === "list_skills"
        ? "list_skills result: - find-skills [core]\n- ppt-master [core]"
        : JSON.stringify({ name, ok: true }) });
      return;
    }
    if (msg.method === METHODS.prepareTurn) {
      // 测试 host 不压缩：直接回 compacted:false
      hostReply(msg.id, { compacted: false });
      return;
    }
    if (msg.method === METHODS.oauthToken) {
      hostReply(msg.id, { ok: false, error: "no oauth token" });
      return;
    }
    if (msg.method === METHODS.agentEvent) {
      const ev = msg.params?.event;
      dbg(`agentEvent ${ev?.type}` + (ev?.type === "message_end" || ev?.type === "message_update" ? " " + JSON.stringify(ev?.message || ev).slice(0, 400) : ""));
    }
  });

  // --- scenario 1: health ---
  const health = new Promise((resolve, reject) => {
    pending.set("h1", { resolve, reject, timer: setTimeout(() => reject(new Error("health timeout")), 8000) });
  });
  child.stdin.write(encode(request("h1", METHODS.health, {})));
  assert.strictEqual((await health).result.ok, true);

  // --- scenario 2: build a runtime with prompt and a forced list_skills call ---
  const agentEnd = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("agent_end timeout (tools not registered?)")), 15000);
    const onLine = (raw) => {
      const msg = parseLine(raw); if (!msg) return;
      if (msg.method === METHODS.agentEvent) {
        const ev = msg.params?.event;
        if (ev?.type === "agent_end") { clearTimeout(timer); rl.removeListener("line", onLine); resolve(); }
        else if (ev?.type === "error") { clearTimeout(timer); rl.removeListener("line", onLine); reject(new Error("agent error: " + (ev.error ? JSON.stringify(ev.error).slice(0,300) : "unknown"))); }
      }
    };
    rl.on("line", onLine);
  });

  const promptRes = new Promise((resolve, reject) => {
    pending.set("p1", { resolve, reject, timer: setTimeout(() => reject(new Error("prompt timeout")), 8000) });
  });
  child.stdin.write(encode(request("p1", METHODS.prompt, {
    sessionId: "session-a",
    turnId: "turn-a",
    content: "列出可用技能",
    provider: { id: "test", type: "openai", baseUrl: "http://localhost", model: "test-model" },
    model: "test-model",
    systemPrompt: "你是测试用的 Pi Agent。请使用工具完成用户任务。",
    history: [],
    tools: [
      { name: "list_skills", label: "list_skills", description: "列出技能", parameters: {} },
      { name: "load_skill", label: "load_skill", description: "加载技能说明", parameters: {} },
    ],
  })));
  assert.strictEqual((await promptRes).result.accepted, true);

  await agentEnd;

  // The mock host forced list_skills; the sidecar must have executed it via tool.invoke.
  assert.ok(toolInvokes.length >= 1, "expected at least one tool.invoke round-trip");
  const invoked = toolInvokes.map((t) => t.params?.name);
  assert.ok(invoked.includes("list_skills"), `expected list_skills, got: ${JSON.stringify(invoked)}`);

  child.kill();
  rl.close();
  rlErr.close();
  clearPending(pending);
  console.log("OK Pi sidecar registers + executes skills tools (list_skills round-tripped to host)");
}

function clearPending(pending) { for (const p of pending.values()) clearTimeout(p.timer); pending.clear(); }

main().catch((error) => { console.error(error); process.exit(1); });
