/** Quest (goal-driven tasks) IPC handlers. */
const { getActiveModel } = require("../../core/config");

function register(ipcMain, ctx) {
  const { cfg, questStore, questRunner, getWindow, ptyBridge, askConfirm } = ctx;

  // ---- Quest (goal-driven tasks) ----
  /** quest 对象瘦身：fileChanges 去 before/after 正文（对齐 Chat 模式） */
  function publicQuest(q) {
    if (!q) return null;
    return { ...q, fileChanges: questStore.publicFileChanges(q) };
  }

  /**
   * quest 事件发送器：delta 流式文本 80ms 批处理合并，
   * 其他事件（status/step/done 等）立即发送。
   */
  const questDeltaBatch = new Map(); // questId -> { buf, timer }
  function makeQuestEventSender(questId) {
    return (ev) => {
      if (getWindow()?.isDestroyed()) return;
      if (ev?.type !== "delta") {
        flushQuestDelta(questId);
        getWindow().webContents.send("quest:event", ev);
        return;
      }
      let b = questDeltaBatch.get(questId);
      if (!b) {
        b = { buf: "", timer: null };
        questDeltaBatch.set(questId, b);
      }
      b.buf += ev.text || "";
      if (b.buf.length >= 4096) {
        flushQuestDelta(questId);
        return;
      }
      if (!b.timer) {
        b.timer = setTimeout(() => flushQuestDelta(questId), 80);
      }
    };
  }
  function flushQuestDelta(questId) {
    const b = questDeltaBatch.get(questId);
    if (!b) return;
    questDeltaBatch.delete(questId);
    if (b.timer) clearTimeout(b.timer);
    if (b.buf && getWindow() && !getWindow().isDestroyed()) {
      getWindow().webContents.send("quest:event", {
        type: "delta",
        questId,
        text: b.buf,
      });
    }
  }

  ipcMain.handle("quest:list", () => questStore.list().map((q) => ({
    id: q.id,
    title: q.title,
    goal: q.goal,
    mode: q.mode,
    status: q.status,
    remark: q.remark || "",
    workspace: q.workspace,
    model: q.model,
    progress: q.progress,
    error: q.error,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
    startedAt: q.startedAt,
    finishedAt: q.finishedAt,
    stepCount: (q.steps || []).length,
    changeCount: (q.fileChanges || []).filter((f) => !f.rejected).length,
  })));
  ipcMain.handle("quest:board", () => questStore.listByStatus());
  ipcMain.handle("quest:get", (_e, id) => publicQuest(questStore.get(id)));
  ipcMain.handle("quest:get-active", () => publicQuest(questStore.getActive()));
  ipcMain.handle("quest:set-active", (_e, id) => questStore.setActive(id));
  ipcMain.handle("quest:create", (_e, payload) => {
    return questStore.create({
      goal: payload?.goal || "",
      title: payload?.title,
      mode: payload?.mode || "agent",
      workspace: payload?.workspace || cfg.lastWorkspace || "",
      model: payload?.model || getActiveModel(cfg),
      providerId: payload?.providerId || cfg.activeProviderId,
    });
  });
  ipcMain.handle("quest:update", (_e, { id, patch }) =>
    publicQuest(questStore.update(id, patch || {}))
  );
  ipcMain.handle("quest:remove", (_e, id) => {
    if (questRunner.isRunning(id)) questRunner.stop(id);
    return questStore.remove(id);
  });
  ipcMain.handle("quest:start", async (_e, id) => {
    const qid = id || questStore.activeId;
    if (!qid) throw new Error("无活动 Quest");
    // fire and forget - progress via events
    setImmediate(() => {
      questStore?.setDebounceMs?.(2000);
      const restoreDebounce = () => {
        try { questStore?.setDebounceMs?.(400); } catch { /* ignore */ }
      };
      questRunner
        .start(
          cfg,
          qid,
          {
            onEvent: (ev) => {
              if (ev?.type === "done" || ev?.type === "error") restoreDebounce();
              makeQuestEventSender(qid)(ev);
            },
          },
          {
            ptyBridge,
            confirm: (message) => askConfirm(message),
          }
        )
        .catch((err) => {
          restoreDebounce();
          if (!getWindow()?.isDestroyed()) {
            getWindow().webContents.send("quest:event", {
              type: "error",
              questId: qid,
              error: err.message || String(err),
            });
          }
        });
    });
    return { ok: true, id: qid };
  });
  ipcMain.handle("quest:stop", (_e, id) => {
    questRunner.stop(id || questStore.activeId);
    return { ok: true };
  });
  ipcMain.handle("quest:reject-change", async (_e, { id, path: filePath }) => {
    return questRunner.applyReject(id, filePath);
  });
  ipcMain.handle("quest:complete", (_e, id) =>
    questRunner.markCompleted(id || questStore.activeId)
  );
  ipcMain.handle("quest:is-running", (_e, id) =>
    questRunner.isRunning(id || questStore.activeId)
  );
}

module.exports = { register };
