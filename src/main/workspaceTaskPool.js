const path = require("path");
const { randomUUID } = require("crypto");

const NO_WORKSPACE = "__emsoder_no_workspace__";

function canonicalWorkspace(root) {
  const value = String(root || "").trim();
  if (!value) return NO_WORKSPACE;
  return path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}
function overlaps(a, b) {
  if (a === NO_WORKSPACE || b === NO_WORKSPACE) return a === b;
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}

/** FIFO per workspace conflict domain, max N concurrently running domains. */
class WorkspaceTaskPool {
  constructor({ maxConcurrent = 3, onChange = () => {} } = {}) {
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || 3);
    this.onChange = onChange;
    this.queues = new Map();
    this.running = new Map();
  }
  _notify(extra = {}) { try { this.onChange(this.snapshot(extra)); } catch { /* ignore */ } }
  enqueue({ workspaceRoot, sessionId, run }) {
    const rootKey = canonicalWorkspace(workspaceRoot);
    const task = { taskId: randomUUID(), workspaceRoot: String(workspaceRoot || ""), rootKey, sessionId, run, state: "queued", queuedAt: Date.now(), cancel: null };
    const promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
    const q = this.queues.get(rootKey) || [];
    q.push(task); this.queues.set(rootKey, q);
    this._notify(); void this._pump();
    return { taskId: task.taskId, promise };
  }
  _canStart(task) {
    if (this.running.size >= this.maxConcurrent) return false;
    return ![...this.running.values()].some((r) => overlaps(r.rootKey, task.rootKey));
  }
  async _pump() {
    let next;
    while ((next = [...this.queues.values()].map((q) => q[0]).find((t) => t && this._canStart(t)))) {
      const task = next;
      const q = this.queues.get(task.rootKey); q.shift();
      if (!q.length) this.queues.delete(task.rootKey);
      this.running.set(task.taskId, task); task.state = "running";
      this._notify();
      void (async () => {
        try {
          const result = await task.run?.({
            taskId: task.taskId,
            sessionId: task.sessionId,
            workspaceRoot: task.workspaceRoot,
            setCancel: (cancel) => { task.cancel = typeof cancel === "function" ? cancel : null; },
          });
          task.resolve?.(result);
        } catch (e) { task.state = "error"; task.reject?.(e); }
        finally { this.running.delete(task.taskId); this._notify(); void this._pump(); }
      })();
    }
  }
  cancelSession(sessionId, reason = "已停止当前任务") {
    for (const [key, q] of this.queues) {
      const keep = q.filter((t) => {
        if (t.sessionId !== sessionId) return true;
        t.state = "stopped"; t.reject?.(new Error(reason)); return false;
      });
      if (keep.length) this.queues.set(key, keep); else this.queues.delete(key);
    }
    for (const task of this.running.values()) {
      if (task.sessionId === sessionId) { task.state = "stopped"; try { task.cancel?.(); } catch { /* ignore */ } }
    }
    this._notify();
  }
  stopAll(reason = "已停止并清空队列") {
    for (const task of this.running.values()) { task.state = "stopped"; try { task.cancel?.(); } catch { /* ignore */ } }
    for (const q of this.queues.values()) for (const t of q) t.reject?.(new Error(reason));
    this.queues.clear(); this._notify({ cleared: true });
  }
  get length() { return [...this.queues.values()].reduce((n, q) => n + q.length, 0); }
  get isBusy() { return this.running.size > 0; }
  isSessionBusy(sessionId) { return [...this.running.values()].some((t) => t.sessionId === sessionId) || [...this.queues.values()].some((q) => q.some((t) => t.sessionId === sessionId)); }
  snapshot(extra = {}) {
    const tasks = [
      ...[...this.running.values()].map((t) => ({ taskId: t.taskId, sessionId: t.sessionId, workspaceRoot: t.workspaceRoot, state: "running", position: 0 })),
      ...[...this.queues.values()].flatMap((q) => q.map((t, i) => ({ taskId: t.taskId, sessionId: t.sessionId, workspaceRoot: t.workspaceRoot, state: "queued", position: i + 1 }))),
    ];
    return { depth: this.length, running: this.running.size > 0, runningCount: this.running.size, maxConcurrent: this.maxConcurrent, tasks, ...extra };
  }
}
module.exports = { WorkspaceTaskPool, canonicalWorkspace, overlaps, NO_WORKSPACE };
