#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emsoder-pin-"));
require.cache[require.resolve("electron")] = { id: "electron", filename: "electron", loaded: true, exports: { app: { getPath: () => tmp, isReady: () => true } } };
const { SessionStore } = require("../src/agent/session");
const { WorkspaceTaskPool } = require("../src/main/workspaceTaskPool");
(async () => {
  const sessions = new SessionStore();
  const rootA = path.join(tmp, "workspace-a"); const rootB = path.join(tmp, "workspace-b");
  fs.mkdirSync(rootA); fs.mkdirSync(rootB);
  const a = sessions.create("agent", rootA);
  const b = sessions.create("agent", rootB);
  sessions.setActive(a.id);
  const pool = new WorkspaceTaskPool({ maxConcurrent: 3 });
  let release; const started = new Promise((r) => { release = r; });
  const task = pool.enqueue({ workspaceRoot: a.workspaceRoot, sessionId: a.id, run: async () => {
    sessions.beginFileChangeTurn(a.id);
    sessions.append({ role: "user", content: "task A" }, a.id);
    await started;
    sessions.append({ role: "assistant", content: "done A" }, a.id);
    sessions.settleRun("done", a.id);
  } });
  // Switch active UI session while A is still queued/running: A must retain its original ownership.
  sessions.setActive(b.id);
  await new Promise((r) => setTimeout(r, 20));
  release(); await task.promise;
  assert.strictEqual(sessions.getById(a.id).workspaceRoot, rootA, "A preserves root");
  assert.strictEqual(sessions.getById(b.id).workspaceRoot, rootB, "B preserves root");
  assert.ok(sessions.getActivePath(sessions.getById(a.id)).some((m) => m.content === "done A"), "A receives result");
  assert.ok(!sessions.getActivePath(sessions.getById(b.id)).some((m) => m.content === "done A"), "B never receives A result");
  console.log("OK queued task remains pinned to submitted session and workspace");
})().catch((e) => { console.error(e); process.exit(1); });
