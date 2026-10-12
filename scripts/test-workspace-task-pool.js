#!/usr/bin/env node
const assert = require("assert");
const { WorkspaceTaskPool, overlaps } = require("../src/main/workspaceTaskPool");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const log = []; const gates = new Map();
  const pool = new WorkspaceTaskPool({ maxConcurrent: 3 });
  const job = (name) => async ({ setCancel }) => {
    log.push(`start:${name}`);
    let release; const p = new Promise((r) => { release = r; }); gates.set(name, release);
    setCancel(() => { log.push(`cancel:${name}`); release(); });
    await p; log.push(`end:${name}`); return name;
  };
  const a1 = pool.enqueue({ workspaceRoot: "D:/a", sessionId: "a1", run: job("a1") });
  const b1 = pool.enqueue({ workspaceRoot: "D:/b", sessionId: "b1", run: job("b1") });
  const a2 = pool.enqueue({ workspaceRoot: "D:/a", sessionId: "a2", run: job("a2") });
  await wait(30);
  assert.deepStrictEqual(log.sort(), ["start:a1", "start:b1"].sort(), "different roots run; same root waits");
  gates.get("b1")(); await wait(20); assert.ok(!log.includes("start:a2"), "B completion does not unlock A2");
  gates.get("a1")(); await wait(20); assert.ok(log.includes("start:a2"), "A completion unlocks A2");
  gates.get("a2")(); await Promise.all([a1.promise, b1.promise, a2.promise]);
  assert.strictEqual(pool.length, 0); assert.strictEqual(pool.isBusy, false);
  assert.strictEqual(overlaps("d:\\repo", "d:\\repo\\sub"), true, "nested roots conflict");

  const c1 = pool.enqueue({ workspaceRoot: "D:/c", sessionId: "c1", run: job("c1") });
  const c2 = pool.enqueue({ workspaceRoot: "D:/c", sessionId: "c2", run: job("c2") });
  const d1 = pool.enqueue({ workspaceRoot: "D:/d", sessionId: "d1", run: job("d1") });
  await wait(20); pool.cancelSession("c1"); await wait(20);
  assert.ok(log.includes("cancel:c1"), "target running task cancelled");
  assert.ok(log.includes("start:c2"), "same-root queued task starts after c1 cleanup");
  assert.ok(pool.isSessionBusy("c2"), "other session in same root remains active/queued");
  assert.ok(pool.isSessionBusy("d1"), "other root survives cancellation");
  gates.get("c2")?.(); gates.get("d1")();
  await Promise.all([c1.promise, c2.promise, d1.promise]);

  const e1 = pool.enqueue({ workspaceRoot: "D:/e", sessionId: "e", run: job("e1") });
  const e2 = pool.enqueue({ workspaceRoot: "D:/e", sessionId: "e", run: job("e2") });
  await wait(20); pool.cancelSession("e");
  assert.ok(log.includes("cancel:e1"), "current session running task cancelled");
  await assert.rejects(e2.promise, /已停止当前任务/, "current session queued task removed");
  await e1.promise;
  console.log("OK workspace task pool parallel roots, FIFO conflicts, nested lock, scoped cancel");
})().catch((e) => { console.error(e); process.exit(1); });
