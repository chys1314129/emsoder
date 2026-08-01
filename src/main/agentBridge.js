/**
 * Shared Agent event bridge for Chat + branch-edit.
 * Keeps main.js free of duplicated runUserMessage wiring.
 */
const { classifyProviderError } = require("../providers/httpUtil");
const { tracker: contextStats } = require("../core/contextStats");

function createSender(getWindow) {
  return (channel, data) => {
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
  const send = createSender(opts.getWindow);
  const sessions = opts.sessions;
  const publicSession = opts.publicSession;

  /**
   * 流式 delta 批处理：80ms / 4KB 合并后再推送，
   * 避免每 token 一次 IPC（渲染端 rAF 节流保留）。
   */
  let deltaBuf = "";
  let deltaTimer = null;
  function pushDelta(type, text) {
    deltaBuf += text;
    if (deltaBuf.length >= 4096) {
      flushDelta();
      return;
    }
    if (!deltaTimer) {
      deltaTimer = setTimeout(flushDelta, 80);
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

  return {
    send,
    events: {
      onText: (t) => pushDelta("assistant_delta", t),
      onReasoning: (t) =>
        send("agent:event", { type: "reasoning_delta", text: t }),
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
      onContextStats: (snap) =>
        send("agent:event", { type: "context_stats", stats: snap }),
      onError: (e) => {
        const info = classifyProviderError(e);
        send("agent:event", {
          type: "error",
          text: info.message,
          hint: info.hint,
          code: info.code,
          action: info.action,
        });
      },
      onDone: () => {
        flushDelta(); // 确保流式末尾文本送达
        send("agent:event", { type: "assistant_done" });
        send("agent:event", {
          type: "context_stats",
          stats: contextStats.getSnapshot(),
        });
        send("agent:event", {
          type: "session",
          session: publicSession(sessions.getActive()),
          sessions: sessions.list().map((s) => ({
            id: s.id,
            title: s.title,
            updatedAt: s.updatedAt,
          })),
        });
        // Fire-and-forget: extract long-term memories from this turn (non-blocking)
        if (typeof opts.onTurnComplete === "function") {
          try { opts.onTurnComplete(sessions.getActive()); } catch { /* ignore */ }
        }
      },
      confirm: opts.confirm,
      onFsChange: (filePath, kind) =>
        send("agent:event", { type: "fs_change", path: filePath, kind }),
      onFileChanges: (fileChanges, sessionId) =>
        send("agent:event", {
          type: "file_changes",
          fileChanges: Array.isArray(fileChanges) ? fileChanges : [],
          sessionId: sessionId || sessions.getActive()?.id || null,
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
    workspaceRoot: cfg.lastWorkspace || payload?.workspaceRoot || "",
    activeFile: payload?.activeFile || "",
    selection: payload?.selection || "",
    openTabs: payload?.openTabs || [],
    language: payload?.language || "",
    cursorLine: payload?.cursorLine,
    attachments: Array.isArray(payload?.attachments)
      ? payload.attachments
      : [],
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
}) {
  const { send, events } = buildRunnerEvents({
    getWindow,
    sessions,
    publicSession,
    confirm,
    ptyBridge,
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
    editorCtxFrom(payload, cfg, { skipUserAppend: !!skipUserAppend })
  );

  return publicSession(sessions.getActive());
}

module.exports = {
  createSender,
  buildRunnerEvents,
  editorCtxFrom,
  runAgentTurn,
};
