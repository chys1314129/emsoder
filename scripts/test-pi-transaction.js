#!/usr/bin/env node
/*
 * Pi 文件变更事务与 UI 审阅对齐：
 * - _proxyTool 对 write_file/edit_file/apply_diff 执行与旧后端完全相同的
 *   快照→执行→后写捕获事务，产出相同的 review 行（before/after/kind）。
 * - 失败的写丢弃快照；子代理（subSessionId）的写进入审阅但不污染对话记录。
 * - applyReject 回滚恢复写前内容。
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emsoder-pi-txn-"));
const fakeApp = { getPath: () => tmpDir, isReady: () => true };
require.cache[require.resolve("electron")] = {
  id: "electron", filename: "electron", loaded: true,
  exports: { app: fakeApp },
};

const { SessionStore } = require("../src/agent/session");
const { AgentRunner } = require("../src/agent/runner");
const { PiRunnerAdapter } = require("../src/pi/runnerAdapter");

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "emsoder-pi-ws-"));
  const store = new SessionStore();
  const s = store.create("agent");
  const cfg = {
    provider: { id: "t", type: "openai", baseUrl: "http://x", apiKey: "k", models: ["m"] },
    activeProviderId: "t", activeModel: "m", reasoningEffort: "medium",
  };
  const events = { onFileChanges: () => {}, confirm: async () => true };
  // 文件事务委托给真实 AgentRunner（快照/捕获/丢弃与旧后端同源）
  const legacyRunner = new AgentRunner(store, null, null);
  const adapter = new PiRunnerAdapter(store, legacyRunner, null);
  const run = {
    sessionId: s.id, cfg, events, abort: new AbortController(),
    editorCtx: { workspaceRoot: workspace, openTabs: [], activeFile: "", selection: "" },
    skillCatalog: null,
  };
  adapter.active.set(s.id, run);

  // ---- 1) write_file：真实事务（create + after），review 行与旧后端同构 ----
  const rel = path.join(workspace, "a.txt");
  const r1 = await adapter._proxyTool(run, {
    name: "write_file",
    arguments: { path: "a.txt", content: "hello pi" },
    callId: "call-1",
  });
  assert.strictEqual(r1.ok, true, "write_file ok");
  assert.strictEqual(fs.readFileSync(rel, "utf8"), "hello pi", "file written");
  const rows = store.getFileChanges(s.id);
  const row = rows.find((f) => f.path === rel);
  assert.ok(row, "review row exists");
  assert.strictEqual(row.kind, "create", "create kind");
  assert.strictEqual(row.before, null, "before null");
  assert.strictEqual(row.after, "hello pi", "after captured");

  // ---- 2) edit_file：before/after 完整 ----
  const r2 = await adapter._proxyTool(run, {
    name: "edit_file",
    arguments: { path: "a.txt", old_string: "hello pi", new_string: "hello pi v2" },
    callId: "call-2",
  });
  assert.strictEqual(r2.ok, true, "edit_file ok");
  assert.strictEqual(fs.readFileSync(rel, "utf8"), "hello pi v2", "file edited");
  const row2 = store.getFileChanges(s.id).find((f) => f.path === rel);
  assert.strictEqual(row2.before, "hello pi", "edit before captured");
  assert.strictEqual(row2.after, "hello pi v2", "edit after captured");
  assert.strictEqual(row2.kind, "edit", "edit kind");

  // ---- 3) apply_diff 同样走事务 ----
  const r3 = await adapter._proxyTool(run, {
    name: "apply_diff",
    arguments: { path: "a.txt", hunks: [{ old_string: "hello pi v2", new_string: "hello pi v3" }] },
    callId: "call-3",
  });
  assert.strictEqual(r3.ok, true, "apply_diff ok");
  assert.strictEqual(fs.readFileSync(rel, "utf8"), "hello pi v3", "diff applied");

  // ---- 4) 越界写失败：不落盘、不产生孤儿 review 行 ----
  const badRun = { ...run, events: { onFileChanges: () => {}, confirm: async () => true } };
  const escapeTarget = path.normalize(path.join(workspace, "..", "escape.txt"));
  const badResult = await adapter._proxyTool(badRun, {
    name: "write_file",
    arguments: { path: "../escape.txt", content: "x" },
    callId: "call-5",
  });
  assert.strictEqual(badResult.ok, false, "escape write rejected");
  assert.ok(!fs.existsSync(escapeTarget), "no file written outside workspace");
  const orphan = store.getFileChanges(s.id).find((f) => f.path === escapeTarget);
  assert.ok(!orphan, "no orphan review row for rejected write");

  // ---- 5) 子代理写入：进审阅、不进对话记录 ----
  const beforeCount = store.getActivePath(s).length;
  const subRel = path.join(workspace, "sub.txt");
  await adapter._proxyTool(run, {
    name: "write_file",
    subSessionId: "sub-123",
    arguments: { path: "sub.txt", content: "by subagent" },
    callId: "call-6",
  });
  assert.strictEqual(fs.readFileSync(subRel, "utf8"), "by subagent", "subagent write applied");
  const subRow = store.getFileChanges(s.id).find((f) => f.path === subRel);
  assert.ok(subRow && subRow.after === "by subagent", "subagent write in review queue");
  assert.strictEqual(store.getActivePath(s).length, beforeCount, "subagent tool result not in transcript");

  // ---- 6) applyReject 回滚到写前内容 ----
  const rollback = await adapter.applyReject(subRel, s.id);
  assert.strictEqual(rollback.ok, true, "reject ok");
  assert.ok(!fs.existsSync(subRel), "subagent file rolled back");

  console.log("OK Pi file-change transaction aligned with legacy review flow");
}

main().catch((e) => { console.error(e); process.exit(1); });
