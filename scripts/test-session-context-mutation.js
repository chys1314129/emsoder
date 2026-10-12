#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emsoder-context-mut-"));
require.cache[require.resolve("electron")] = { id: "electron", filename: "electron", loaded: true, exports: { app: { getPath: () => tmp, isReady: () => true } } };
const { SessionStore } = require("../src/agent/session");
const { WorkspaceTaskPool } = require("../src/main/workspaceTaskPool");
(async () => {
  const sessions = new SessionStore();
  const a = sessions.create("agent", "D:/a");
  const b = sessions.create("agent", "D:/b");
  const ua = sessions.append({ role: "user", content: "A message" }, a.id);
  const ub = sessions.append({ role: "user", content: "B message" }, b.id);
  const pool = new WorkspaceTaskPool({ maxConcurrent: 3 });
  let release; const busy = pool.enqueue({ workspaceRoot: "D:/a", sessionId: a.id, run: async ({ setCancel }) => {
    await new Promise((resolve) => { release = resolve; setCancel(resolve); });
  } });
  await new Promise((r) => setTimeout(r, 10));
  const assertMutable = (id) => {
    const s = sessions.getById(id);
    if (pool.isSessionBusy(id)) throw new Error("该会话正在生成或排队，请先停止当前任务");
    if ((s.fileChanges || []).some((f) => !f.rejected)) throw new Error("该会话有待审文件改动，请先接受或撤销本轮改动");
  };
  assert.throws(() => { assertMutable(a.id); sessions.excludeMessageBranch(ua.id, a.id); }, /正在生成/);
  assert.doesNotThrow(() => { assertMutable(b.id); sessions.excludeMessageBranch(ub.id, b.id); });
  release(); await busy.promise;
  sessions.recordFileChange({ path: "/tmp/x", before: "a", after: "b" }, a.id);
  assert.throws(() => { assertMutable(a.id); sessions.deleteMessageBranch(ua.id, a.id); }, /待审文件改动/);
  sessions.clearFileChanges(a.id);
  assert.doesNotThrow(() => { assertMutable(a.id); sessions.deleteMessageBranch(ua.id, a.id); });
  console.log("OK context mutations reject busy/review sessions and allow independent idle sessions");
})().catch((e) => { console.error(e); process.exit(1); });
