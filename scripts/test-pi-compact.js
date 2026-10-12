#!/usr/bin/env node
/*
 * Regression for Pi full compaction takeover:
 *  1) host side (_proxyCompactHost): performs real session compaction and returns
 *     a shorter replacement history when asked by Pi.
 *  2) sidecar side: Pi estimates its own context (tiny contextWindow forces the
 *     decision) and calls agent.compactHost; the replacement transcript must
 *     reach the next provider request.
 */
const assert = require("assert");
const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Stub Electron before requiring any app module.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emsoder-pi-compact-"));
const fakeApp = { getPath: () => tmpDir, isReady: () => true };
require.cache[require.resolve("electron")] = {
  id: "electron", filename: "electron", loaded: true,
  exports: { app: fakeApp },
};

const { SessionStore } = require("../src/agent/session");
const { PiRunnerAdapter } = require("../src/pi/runnerAdapter");
const { METHODS, parseLine, encode, request } = require("../src/pi/protocol");

const SIDECAR = process.env.PI_SIDECAR || path.join(__dirname, "..", "src", "pi", "sidecar.mjs");

// ---------- 1) host-side compaction executor ----------
async function hostCompaction() {
  const store = new SessionStore();
  const s = store.create("agent");
  for (let i = 0; i < 60; i++) {
    store.append({ role: "user", content: `第${i}轮：请继续处理登录页面，补充第 ${i} 个细节，写文件 src/a${i}.js。`.repeat(3) });
    store.append({ role: "assistant", content: `已完成第${i}轮：写入 src/a${i}.js，内容较长` + "x".repeat(200) });
  }
  const cfg = {
    contextWindow: 2000,
    autoCompressAt: 80,
    provider: { id: "t", type: "openai", baseUrl: "http://x", apiKey: "k", models: ["m"] },
    activeProviderId: "t",
    activeModel: "m",
    reasoningEffort: "medium",
  };
  const adapter = new PiRunnerAdapter(store, {}, null);
  const run = { sessionId: s.id, cfg, events: {}, abort: new AbortController() };
  adapter.active.set(s.id, run);
  const before = store.getActivePath(s).length;
  const fakeChat = async () => "压缩摘要：用户要写登录页面，已写多个文件。";
  const result = await adapter._proxyCompactHost(run, fakeChat);
  assert.strictEqual(result.compacted, true, "long transcript must compact");
  assert.ok(Array.isArray(result.history), "replacement history returned");
  assert.ok(result.history.length < before, `history shrank: ${before} → ${result.history.length}`);
  assert.ok(JSON.stringify(result.history).includes("压缩摘要"), "summary retained in history");
  console.log("OK host-side _proxyCompactHost performs real compaction");
}

// ---------- 2) sidecar decides + swaps context ----------
async function sidecarDecides() {
  const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  const providerStreams = [];
  let compactCalls = 0;

  const reply = (id, result) => {
    const p = pending.get(String(id));
    if (p) { clearTimeout(p.t); pending.delete(String(id)); }
    child.stdin.write(encode({ jsonrpc: "2.0", id, result }));
  };
  const zeroMsg = (stopReason, content) => ({
    role: "assistant", content, api: "openai-completions", provider: "test", model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
    stopReason, timestamp: Date.now(),
  });
  const compactedHistory = [
    { role: "user", content: "目标：压缩后的目标", createdAt: Date.now() },
    { role: "assistant", content: "压缩摘要：……", createdAt: Date.now() },
  ];

  rl.on("line", (raw) => {
    const m = parseLine(raw); if (!m) return;
    if (m.id != null && !m.method) {
      const p = pending.get(String(m.id));
      if (p) { clearTimeout(p.t); pending.delete(String(m.id)); p.r(m); }
      return;
    }
    if (m.method === METHODS.providerStream) {
      providerStreams.push(m.params);
      if (providerStreams.length === 1) {
        reply(m.id, {
          events: [{ type: "tool_call", call: { id: "call-x", index: 0, name: "noop", arguments: "{}" } }],
          final: zeroMsg("toolUse", [{ type: "toolCall", id: "call-x", name: "noop", arguments: {} }]),
        });
      } else {
        reply(m.id, {
          events: [{ type: "text", text: "第二轮完成" }],
          final: zeroMsg("stop", [{ type: "text", text: "第二轮完成" }]),
        });
      }
      return;
    }
    if (m.method === METHODS.toolInvoke) { reply(m.id, { ok: true, content: "ok" }); return; }
    if (m.method === METHODS.oauthToken) { reply(m.id, { ok: false, error: "no oauth token" }); return; }
    if (m.method === METHODS.compactHost) {
      compactCalls += 1;
      reply(m.id, { compacted: true, history: compactedHistory, pathCount: 60, afterCount: 10 });
      return;
    }
  });

  const agentEnd = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("agent_end timeout")), 15000);
    const onLine = (raw) => {
      const m = parseLine(raw); if (!m) return;
      if (m.method === METHODS.agentEvent && m.params?.event?.type === "agent_end") {
        clearTimeout(t); rl.removeListener("line", onLine); resolve();
      }
      if (m.method === METHODS.agentEvent && m.params?.event?.type === "error") {
        clearTimeout(t); rl.removeListener("line", onLine); reject(new Error("agent error"));
      }
    };
    rl.on("line", onLine);
  });

  const prompt = new Promise((resolve, reject) => {
    pending.set("p1", { r: resolve, t: setTimeout(() => reject(new Error("prompt timeout")), 8000) });
  });
  child.stdin.write(encode(request("p1", METHODS.prompt, {
    sessionId: "s-c", turnId: "t-c", content: "继续任务",
    // 极小的 contextWindow 迫使 Pi 自主判定需要压缩
    provider: { id: "t", type: "openai", baseUrl: "http://x", model: "test-model", contextWindow: 200 },
    model: "test-model", systemPrompt: "sys",
    history: [
      { role: "user", content: "原始用户消息很长" + "长".repeat(500), createdAt: Date.now() },
    ],
    tools: [{ name: "noop", label: "noop", description: "noop", parameters: {} }],
  })));
  await prompt;
  await agentEnd;
  child.kill(); rl.close();
  clearPending(pending);

  assert.ok(compactCalls >= 1, "Pi must decide + call agent.compactHost");
  const last = providerStreams[providerStreams.length - 1];
  const msgs = last?.context?.messages || [];
  const text = JSON.stringify(msgs);
  assert.ok(text.includes("压缩后的目标"), "replacement history must reach provider context");
  assert.ok(!text.includes("原始用户消息很长"), "old oversized history must be replaced");
  console.log("OK sidecar owns compaction decision and applies replacement context");
}

function clearPending(pending) { for (const p of pending.values()) clearTimeout(p.t); pending.clear(); }

(async () => {
  await hostCompaction();
  await sidecarDecides();
  console.log("OK Pi compaction takeover regression test");
})().catch((e) => { console.error(e); process.exit(1); });
