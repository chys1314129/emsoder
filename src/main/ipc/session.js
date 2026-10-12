/** Session IPC handlers (list / get / new / compress / branch-edit / switch-branch / etc). */
const { runAgentTurn } = require("../agentBridge");

function register(ipcMain, ctx) {
  const {
    cfg,
    sessions,
    runner,
    publicSession,
    chatQueue,
    getWindow,
    ptyBridge,
    memoryStore,
    askConfirm,
  } = ctx;

  function sessionListItems() {
    return sessions.list().map((s) => ({
      id: s.id,
      title: s.title,
      workspaceRoot: s.workspaceRoot || "",
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      mode: s.mode || "agent",
      runStatus: s.runStatus || "idle",
      messageCount: sessions.visibleMessageCount(s),
    }));
  }

  ipcMain.handle("session:list", () => sessionListItems());
  ipcMain.handle("session:rename", (_e, { id, title } = {}) => {
    const s = sessions.rename(id, title);
    if (!s) return { ok: false, error: "会话不存在" };
    return {
      ok: true,
      session: publicSession(s),
      sessions: sessionListItems(),
    };
  });
  ipcMain.handle("session:remove", (_e, id) => {
    const r = sessions.remove(id);
    return {
      ...r,
      session: publicSession(sessions.getActive()),
      sessions: sessionListItems(),
    };
  });
  ipcMain.handle("session:remove-many", (_e, ids) => {
    const r = sessions.removeMany(ids);
    return {
      ...r,
      session: publicSession(sessions.getActive()),
      sessions: sessionListItems(),
    };
  });
  ipcMain.handle("session:get", () => publicSession(sessions.getActive()));
  ipcMain.handle("session:new", (_e, { workspaceRoot } = {}) => {
    const root = workspaceRoot || sessions.getActive()?.workspaceRoot || cfg.lastWorkspace || "";
    const s = sessions.create("agent", root);
    return publicSession(s);
  });
  ipcMain.handle("session:set-active", (_e, id) =>
    publicSession(sessions.setActive(id))
  );
  ipcMain.handle("session:clear", () => {
    sessions.clearActive();
    return publicSession(sessions.getActive());
  });

  /**
   * 压缩当前会话上下文：
   * - 保留最近 keepRecent 条「可见」消息 + 最初用户目标
   * - 更早内容交给模型生成摘要，再写回一条压缩消息
   * - 手动压缩不在 agent 运行中执行；自动压缩走 runner 内部
   */
  ipcMain.handle("session:compress", async (_e, opts = {}) => {
    const targetId = opts.sessionId || sessions.getActive()?.id || null;
    if (chatQueue.isSessionBusy?.(targetId) || runner?.isSessionRunning?.(targetId)) {
      return {
        ok: false,
        error: "该会话正在生成或排队，无法压缩；请先停止当前任务",
      };
    }
    const { compressActiveSession } = require("../../agent/compress");
    const result = await compressActiveSession({
      sessions,
      cfg,
      sessionId: targetId,
      keepRecent: opts.keepRecent,
      keepFileChanges: true,
    });
    if (!result.ok) {
      return {
        ...result,
        session: publicSession(result.session || sessions.getActive()),
      };
    }
    return {
      ...result,
      session: publicSession(result.session),
    };
  });

  function assertContextMutable(sessionId) {
    const session = sessionId && sessions.getById?.(sessionId);
    if (!session) throw new Error("会话不存在");
    if (chatQueue.isSessionBusy?.(sessionId) || runner?.isSessionRunning?.(sessionId)) {
      throw new Error("该会话正在生成或排队，请先停止当前任务");
    }
    if ((session.fileChanges || []).some((f) => f && !f.rejected)) {
      throw new Error("该会话有待审文件改动，请先接受或撤销本轮改动");
    }
    return session;
  }

  function mutationResult(result) {
    return {
      ok: true,
      session: publicSession(result.session),
      ids: result.ids || [],
      activeLeafId: result.activeLeafId || result.session?.activeLeafId || null,
      sessions: sessionListItems(),
    };
  }

  ipcMain.handle("session:exclude-message", (_e, { sessionId, messageId } = {}) => {
    assertContextMutable(sessionId);
    return mutationResult(sessions.excludeMessageBranch(messageId, sessionId));
  });
  ipcMain.handle("session:restore-message", (_e, { sessionId, messageId } = {}) => {
    assertContextMutable(sessionId);
    return mutationResult(sessions.restoreMessageBranch(messageId, sessionId));
  });
  ipcMain.handle("session:delete-message", (_e, { sessionId, messageId, confirmed } = {}) => {
    if (!confirmed) return { ok: false, error: "永久删除需要确认" };
    assertContextMutable(sessionId);
    return mutationResult(sessions.deleteMessageBranch(messageId, sessionId));
  });
  ipcMain.handle("session:edit-assistant-message", (_e, { sessionId, messageId, content } = {}) => {
    assertContextMutable(sessionId);
    const result = sessions.editAssistantMessage(messageId, content, sessionId);
    return mutationResult({ ...result, activeLeafId: result.session?.activeLeafId });
  });

  /** Edit past user message -> new branch, keep old answers, then run agent */
  ipcMain.handle("session:branch-edit", async (_event, payload) => {
    const messageId = payload?.messageId;
    const text = String(payload?.text || "").trim();
    if (!messageId || !text) throw new Error("缺少 messageId 或 text");

    const sessionId = payload?.sessionId || sessions.getActive()?.id || null;
    const session = sessionId && sessions.getById?.(sessionId);
    if (!session) throw new Error("会话不存在");
    const workspaceRoot = payload?.workspaceRoot || session.workspaceRoot || cfg.lastWorkspace || "";
    return chatQueue.enqueue(
      { sessionId, workspaceRoot },
      ({ taskId, setCancel }) => {
        setCancel(() => runner.stop(sessionId));
        const { userMsg } = sessions.branchFromUserEdit(messageId, text, sessionId);
        return runAgentTurn({
          runner, cfg, text,
          payload: { ...payload, sessionId, workspaceRoot },
          getWindow: () => getWindow(), sessions, publicSession,
          confirm: askConfirm, ptyBridge, memoryStore,
          sessionId, workspaceRoot, taskId,
          skipUserAppend: true,
          preEvents: (send) => {
            send("agent:event", { type: "branch", session: publicSession(session) });
            send("agent:event", { type: "user", text, messageId: userMsg.id });
            send("agent:event", { type: "assistant_start" });
          },
        });
      }
    );
  });

  ipcMain.handle("session:switch-branch", (_e, payload) => {
    const messageId = payload?.messageId;
    const dir = payload?.direction || "next";
    if (!messageId) throw new Error("缺少 messageId");
    sessions.switchBranch(messageId, dir);
    return publicSession(sessions.getActive());
  });
}

module.exports = { register };
