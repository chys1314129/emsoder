/**
 * Shared Agent event bridge for Chat + branch-edit.
 * Keeps main.js free of duplicated runUserMessage wiring.
 */
const { classifyProviderError } = require("../providers/httpUtil");
const { tracker: contextStats } = require("../core/contextStats");
const { BrowserWindow } = require("electron");

function createSender(getWindow) {
  return (channel, data) => {
    // Broadcast to every live window (main + floating ball). The ball ignores
    // stream deltas and only reacts to status/session events.
    const wins = BrowserWindow.getAllWindows();
    if (wins.length) {
      for (const win of wins) {
        if (win && !win.isDestroyed()) win.webContents.send(channel, data);
      }
      return;
    }
    const win = typeof getWindow === "function" ? getWindow() : getWindow;
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  };
}

/**
 * @param {object} opts
 * @param {function} opts.getWindow
 * @param {object} opts.sessions SessionStore
 * @param {function} opts.publicSession
 * @param {function} opts.confirm
 * @param {object|null} opts.ptyBridge
 * @param {function} [opts.onTurnComplete]  async hook fired after a turn ends (fire-and-forget)
 */
function buildRunnerEvents(opts) {
  const rawSend = createSender(opts.getWindow);
  const sessions = opts.sessions;
  const publicSession = opts.publicSession;
  // Session this turn is pinned to. Tag every event so the renderer can tell
  // whether a streamed chunk belongs to the session currently on screen.
  const turnSessionId = opts.sessionId || null;
  const turnTaskId = opts.taskId || null;
  const turnWorkspaceRoot = opts.workspaceRoot || "";
  const send = (channel, data) => {
    if (channel === "agent:event" && data && typeof data === "object") {
      rawSend(channel, { sessionId: turnSessionId, taskId: turnTaskId, workspaceRoot: turnWorkspaceRoot, ...data });
    } else {
      rawSend(channel, data);
    }
  };

  /**
   * 流式 delta 批处理：80ms / 4KB 合并后再推送，
   * 避免每 token 一次 IPC（渲染端 rAF 节流保留）。
   */
  let deltaBuf = "";
  let reasoningBuf = "";
  let deltaTimer = null;
  let reasoningTimer = null;
  function pushDelta(text) {
    deltaBuf += text;
    if (deltaBuf.length >= 4096) {
      flushDelta();
      return;
    }
    if (!deltaTimer) {
      deltaTimer = setTimeout(flushDelta, 80);
    }
  }
  function pushReasoning(text) {
    reasoningBuf += text;
    if (reasoningBuf.length >= 4096) {
      flushReasoning();
      return;
    }
    if (!reasoningTimer) {
      reasoningTimer = setTimeout(flushReasoning, 80);
    }
  }
  function flushDelta() {
    if (deltaTimer) {
      clearTimeout(deltaTimer);
      deltaTimer = null;
    }
    if (!deltaBuf) return;
    const text = deltaBuf;
    deltaBuf = "";
    send("agent:event", { type: "assistant_delta", text });
  }
  function flushReasoning() {
    if (reasoningTimer) {
      clearTimeout(reasoningTimer);
      reasoningTimer = null;
    }
    if (!reasoningBuf) return;
    const text = reasoningBuf;
    reasoningBuf = "";
    send("agent:event", { type: "reasoning_delta", text });
  }

  return {
    send,
    events: {
      onText: (t) => pushDelta(t),
      onReasoning: (t) => pushReasoning(t),
      onToolStart: (name, args) =>
        send("agent:event", {
          type: "tool_start",
          name,
          args: String(args || "").slice(0, 800),
        }),
      onToolEnd: (name, result) =>
        send("agent:event", {
          type: "tool_end",
          name,
          result: String(result || "").slice(0, 3000),
        }),
      onStatus: (s) => send("agent:event", { type: "status", text: s }),
      onPlanReady: (planText, note) =>
        send("agent:event", { type: "plan_ready", planText, note }),
      onContextStats: (snap) =>
        send("agent:event", { type: "context_stats", stats: snap }),
      onError: (e) => {
        // 丢弃未送达的流式缓冲：错误后不应再推送过期文本
        if (deltaTimer) { clearTimeout(deltaTimer); deltaTimer = null; }
        if (reasoningTimer) { clearTimeout(reasoningTimer); reasoningTimer = null; }
        deltaBuf = "";
        reasoningBuf = "";
        const info = classifyProviderError(e);
        send("agent:event", {
          type: "error",
          text: info.message,
          hint: info.hint,
          code: info.code,
          action: info.action,
        });
      },
      onDone: (reason) => {
        // 确保流式末尾文本送达
        flushDelta();
        flushReasoning();
        // Report the session this turn belonged to, not whatever is active now
        // (the user may have switched sessions while the turn was running).
        const turnSession =
          (turnSessionId && sessions.getById?.(turnSessionId)) ||
          sessions.getActive();
        send("agent:event", {
          type: "assistant_done",
          reason: reason || "done",
        });
        send("agent:event", {
          type: "context_stats",
          stats: contextStats.getSnapshot(),
        });
        send("agent:event", {
          type: "session",
          session: publicSession(turnSession),
          sessions: sessions.list().map((s) => ({
            id: s.id,
            title: s.title,
            updatedAt: s.updatedAt,
            runStatus: s.runStatus || "idle",
          })),
        });
        // Fire-and-forget: extract long-term memories from this turn (non-blocking)
        if (typeof opts.onTurnComplete === "function") {
          try { opts.onTurnComplete(turnSession); } catch { /* ignore */ }
        }
      },
      confirm: (message) => opts.confirm(message, {
        sessionId: turnSessionId,
        taskId: turnTaskId,
        workspaceRoot: turnWorkspaceRoot,
      }),
      onFsChange: (filePath, kind) =>
        send("agent:event", { type: "fs_change", path: filePath, kind }),
      onFileChanges: (fileChanges, sessionId) =>
        send("agent:event", {
          type: "file_changes",
          fileChanges: Array.isArray(fileChanges) ? fileChanges : [],
          sessionId: sessionId || turnSessionId || sessions.getActive()?.id || null,
        }),
      ptyBridge: opts.ptyBridge || null,
    },
  };
}

/**
 * Normalize editor context payload from renderer / defaults.
 */
function editorCtxFrom(payload, cfg, extra = {}) {
  return {
    // Agent root is frozen by the queued job/session. cfg.lastWorkspace is only legacy fallback.
    workspaceRoot: payload?.workspaceRoot || extra.workspaceRoot || cfg.lastWorkspace || "",
    activeFile: payload?.activeFile || "",
    selection: payload?.selection || "",
    openTabs: payload?.openTabs || [],
    language: payload?.language || "",
    cursorLine: payload?.cursorLine,
    attachments: Array.isArray(payload?.attachments)
      ? payload.attachments
      : [],
    // Pi plan/goal 模式：payload 透传；默认从配置取
    runMode:
      payload?.runMode === "plan" || payload?.runMode === "goal"
        ? payload.runMode
        : cfg.runMode === "plan" || cfg.runMode === "goal"
          ? cfg.runMode
          : "auto",
    planApproved: payload?.planApproved === true,
    ...extra,
  };
}

/**
 * Run agent for a normal user send or branch-edit.
 */
async function runAgentTurn({
  runner,
  cfg,
  text,
  payload,
  getWindow,
  sessions,
  publicSession,
  confirm,
  ptyBridge,
  memoryStore = null,
  skipUserAppend = false,
  preEvents = null,
  sessionId = null,
  workspaceRoot = "",
  taskId = null,
}) {
  // Capture ownership at enqueue time. Never infer it from mutable active session.
  const pinnedSessionId = sessionId || sessions.getActive()?.id || null;
  const pinnedSession = (pinnedSessionId && sessions.getById?.(pinnedSessionId)) || sessions.getActive();
  if (!pinnedSession) throw new Error("会话不存在");
  const { send, events } = buildRunnerEvents({
    getWindow,
    sessions,
    publicSession,
    confirm,
    ptyBridge,
    sessionId: pinnedSessionId,
    taskId,
    workspaceRoot: workspaceRoot || pinnedSession.workspaceRoot || payload?.workspaceRoot || cfg.lastWorkspace || "",
    onTurnComplete:
      memoryStore && cfg.memoriesEnabled === true
        ? (session) => {
            // Fire-and-forget extraction; never blocks the UI
            memoryStore.extractFromSession(session, cfg).catch(() => { /* ignore */ });
          }
        : null,
  });

  if (typeof preEvents === "function") {
    preEvents(send);
  } else {
    // UI shows summary only; full file/image payload goes via attachments
    send("agent:event", {
      type: "user",
      text: payload?.displayText != null ? payload.displayText : text,
    });
    send("agent:event", { type: "assistant_start" });
  }

  await runner.runUserMessage(
    cfg,
    text,
    events,
    editorCtxFrom(payload, cfg, {
      skipUserAppend: !!skipUserAppend,
      sessionId: pinnedSessionId,
      workspaceRoot: workspaceRoot || pinnedSession.workspaceRoot || "",
      taskId,
    })
  );

  return publicSession((pinnedSessionId && sessions.getById?.(pinnedSessionId)) || pinnedSession);
}

module.exports = {
  createSender,
  buildRunnerEvents,
  editorCtxFrom,
  runAgentTurn,
};
