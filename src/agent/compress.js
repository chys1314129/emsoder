/**
 * Session context compression (manual button + auto mid-run).
 * Summarizes older visible messages, keeps the first user goal + recent tail.
 */

const { chatOnce } = require("../providers");
const { getActiveModel } = require("../core/config");
const {
  tracker: contextStats,
  formatContextLabel,
  formatCacheLabel,
} = require("../core/contextStats");

const DEFAULT_KEEP_RECENT = 8;
const DEFAULT_AUTO_COMPRESS_AT = 80;

function isVisibleMessage(m) {
  if (!m) return false;
  if (m.role !== "user" && m.role !== "assistant") return false;
  if (
    m.role === "assistant" &&
    /^调用工具\s*[:：]/.test(String(m.content || "").trim())
  ) {
    return false;
  }
  return true;
}

function clip(s, n) {
  const t = String(s || "");
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function selectKeepAndOlder(pathMsgs, keepRecent = DEFAULT_KEEP_RECENT) {
  const path = Array.isArray(pathMsgs) ? pathMsgs : [];
  const visible = path.filter(isVisibleMessage);
  const keepRecentN = Math.max(2, Math.min(40, Number(keepRecent) || DEFAULT_KEEP_RECENT));
  if (visible.length <= keepRecentN + 1) {
    return { ok: false, visible, keep: visible, older: [] };
  }
  const firstUser = visible.find((m) => m.role === "user");
  const tailVisible = visible.slice(-keepRecentN);
  const start = tailVisible[0];
  const startIdx = path.indexOf(start);
  let keep = startIdx >= 0 ? path.slice(startIdx) : tailVisible;
  if (firstUser && !keep.includes(firstUser)) {
    keep = [firstUser, ...keep.filter((m) => m !== firstUser)];
  }
  const keepSet = new Set(keep);
  const older = visible.filter((m) => !keepSet.has(m));
  return { ok: older.length > 0, visible, keep, older };
}

function localFallbackSummary(older) {
  return (
    "（自动摘要失败，已用本地截断）\n" +
    older
      .slice(-12)
      .map((m) => {
        const role = m.role === "user" ? "用户" : "助手";
        return `${role}: ${clip(m.content, 280)}`;
      })
      .join("\n")
  );
}

async function summarizeOlder(cfg, older, chat = chatOnce) {
  let budget = 14000;
  const parts = [];
  for (const m of older) {
    const role = m.role === "user" ? "用户" : "助手";
    const body = clip(m.content, 1200);
    const block = `${role}: ${body}`;
    if (budget - block.length < 0) break;
    parts.push(block);
    budget -= block.length + 2;
  }
  const digestSrc = parts.join("\n\n");
  let summary = "";
  try {
    const raw = await chat(cfg, {
      messages: [
        {
          role: "system",
          content:
            "你是对话上下文压缩助手。把给定的较早对话压缩成简洁中文摘要，保留：用户目标、关键决策、已改文件/路径、未完成事项、重要约束与结论。不要代码大段粘贴，路径可保留。输出纯文本摘要，不要标题装饰。",
        },
        {
          role: "user",
          content: `请压缩以下较早对话（共约 ${older.length} 条可见消息）：\n\n${digestSrc}`,
        },
      ],
      maxTokens: 1200,
      temperature: 0.2,
      reasoningEffort: cfg?.reasoningEffort || "medium",
      timeoutMs: 60000,
      maxRetries: 1,
    });
    summary =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object" && raw.content != null
          ? String(raw.content)
          : String(raw ?? "");
    summary = String(summary || "").trim();
  } catch {
    summary = localFallbackSummary(older);
  }
  if (!summary) summary = `已折叠较早 ${older.length} 条可见消息。`;
  return summary;
}

function refreshStatsAfterCompact(sessions, cfg, sessionId = null) {
  try {
    const target =
      (sessionId && sessions.getById?.(sessionId)) || sessions.getActive();
    const msgs = (sessions.getContextPath?.(target) || sessions.getActivePath(target)).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    contextStats.beginRequest({
      model: getActiveModel(cfg),
      cfg,
      messages: msgs,
      tools: [],
    });
  } catch {
    /* ignore */
  }
  const snap = contextStats.getSnapshot();
  return {
    ...snap,
    labelContext: formatContextLabel(snap),
    labelCache: formatCacheLabel(snap),
  };
}

/**
 * Compress a session branch (active by default, or an explicit sessionId).
 * @param {{ sessionId?: string|null, keepFileChanges?: boolean }} [opts]
 */
async function compressActiveSession({
  sessions,
  cfg,
  sessionId = null,
  keepRecent = DEFAULT_KEEP_RECENT,
  keepFileChanges = true,
  chat = chatOnce,
} = {}) {
  const session =
    (sessionId && sessions?.getById?.(sessionId)) || sessions?.getActive?.();
  if (!session) return { ok: false, error: "无活动会话" };
  const pathMsgs = sessions.getContextPath?.(session) || sessions.getActivePath(session);
  const picked = selectKeepAndOlder(pathMsgs, keepRecent);
  if (!picked.ok) {
    return {
      ok: false,
      skipped: true,
      error: `消息较少（可见 ${picked.visible.length} 条），无需压缩`,
      session,
    };
  }
  const summary = await summarizeOlder(cfg, picked.older, chat);
  const result = sessions.compactActive(summary, picked.keep, {
    keepFileChanges,
    sessionId: session.id,
  });
  const stats = refreshStatsAfterCompact(sessions, cfg, session.id);
  return {
    ok: true,
    beforeCount: result.beforeCount,
    pathCount: result.pathCount,
    afterCount: result.afterCount,
    keptCount: result.keptCount,
    olderCount: picked.older.length,
    summaryPreview: clip(summary, 240),
    session: result.session,
    stats,
  };
}

function autoCompressThreshold(cfg) {
  const n = Number(cfg?.autoCompressAt);
  if (Number.isFinite(n) && n >= 40 && n <= 99) return n;
  return DEFAULT_AUTO_COMPRESS_AT;
}

function shouldAutoCompress(cfg, stats) {
  const snap = stats || contextStats.getSnapshot();
  return (Number(snap?.fillPercent) || 0) >= autoCompressThreshold(cfg);
}

module.exports = {
  DEFAULT_KEEP_RECENT,
  DEFAULT_AUTO_COMPRESS_AT,
  isVisibleMessage,
  selectKeepAndOlder,
  compressActiveSession,
  shouldAutoCompress,
  autoCompressThreshold,
};
