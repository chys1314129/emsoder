const fs = require("fs");
const { randomUUID } = require("crypto");
const { sessionsPath } = require("../core/config");

const SAVE_DEBOUNCE_MS = 450;
const MAX_SESSIONS = 40;
const MAX_MESSAGES_PER_SESSION = 400;

/**
 * Chat sessions with tree branching.
 * - Each message: { id, role, content, parentId, createdAt, ... }
 * - activeLeafId: tip of the currently viewed branch
 * - LLM history = path from root → activeLeafId
 * - Editing a past user message creates a sibling branch (old answers kept)
 */
class SessionStore {
  constructor() {
    this.sessions = new Map();
    this.activeId = null;
    this._saveTimer = null;
    this._dirty = false;
    this.debounceMs = SAVE_DEBOUNCE_MS;
    this.load();
  }

  /** 运行中加大防抖（agent 每轮多次写盘），空闲恢复；退出仍 flush 兜底 */
  setDebounceMs(ms) {
    const v = Number(ms);
    if (Number.isFinite(v) && v >= 100) this.debounceMs = v;
  }

  load() {
    try {
      const p = sessionsPath();
      if (!fs.existsSync(p)) return;
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      for (const s of data.sessions || []) {
        this.sessions.set(s.id, migrateSession(s));
      }
      this.activeId = data.activeId || null;
    } catch (e) {
      console.error("session load", e);
    }
  }

  saveNow() {
    this._saveTimer = null;
    this._dirty = false;
    try {
      const p = sessionsPath();
      fs.mkdirSync(require("path").dirname(p), { recursive: true });
      const list = this.list().slice(0, MAX_SESSIONS).map((s) => {
        const copy = { ...s };
        if (Array.isArray(copy.messages) && copy.messages.length > MAX_MESSAGES_PER_SESSION) {
          // keep tree roots near the end — simple cap by recency of createdAt
          const sorted = [...copy.messages].sort(
            (a, b) => (a.createdAt || 0) - (b.createdAt || 0)
          );
          copy.messages = sorted.slice(-MAX_MESSAGES_PER_SESSION);
          if (
            copy.activeLeafId &&
            !copy.messages.some((m) => m.id === copy.activeLeafId)
          ) {
            copy.activeLeafId =
              copy.messages[copy.messages.length - 1]?.id || null;
          }
        }
        return copy;
      });
      const tmp = p + ".tmp";
      // 紧凑序列化：减少主线程 stringify 耗时与写盘体积
      fs.writeFileSync(
        tmp,
        JSON.stringify({ activeId: this.activeId, sessions: list }),
        "utf8"
      );
      fs.renameSync(tmp, p);
    } catch (e) {
      console.error("session save", e);
      try {
        fs.writeFileSync(
          sessionsPath(),
          JSON.stringify(
            {
              activeId: this.activeId,
              sessions: this.list().slice(0, MAX_SESSIONS),
            },
            null,
            2
          ),
          "utf8"
        );
      } catch (e2) {
        console.error("session save fallback", e2);
      }
    }
  }

  save() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => this.saveNow(), this.debounceMs);
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirty) this.saveNow();
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getActive() {
    if (this.activeId && this.sessions.has(this.activeId)) {
      return this.sessions.get(this.activeId);
    }
    return this.create("agent");
  }

  getById(id) {
    return id && this.sessions.has(id) ? this.sessions.get(id) : undefined;
  }

  _resolveSession(sessionOrId) {
    if (sessionOrId && typeof sessionOrId === "object") return sessionOrId;
    if (sessionOrId && this.sessions.has(sessionOrId)) return this.sessions.get(sessionOrId);
    return this.getActive();
  }

  setActive(id) {
    if (!this.sessions.has(id)) return undefined;
    this.activeId = id;
    this.save();
    return this.sessions.get(id);
  }

  create(mode = "agent") {
    const now = Date.now();
    const session = {
      id: randomUUID(),
      title: "新对话",
      mode,
      messages: [],
      activeLeafId: null,
      /** Chat 本轮 Agent 写盘快照（对齐 Quest fileChanges） */
      fileChanges: [],
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    this.activeId = session.id;
    this.save();
    return session;
  }

  /** 新一轮用户消息开始时清空本轮变更，便于「本轮摘要 / 一键撤销」 */
  beginFileChangeTurn(sessionId = null) {
    const session = this._resolveSession(sessionId);
    session.fileChanges = [];
    session.updatedAt = Date.now();
    this.save();
    return session;
  }

  recordFileChange(change, sessionId = null) {
    const session = this._resolveSession(sessionId);
    if (!Array.isArray(session.fileChanges)) session.fileChanges = [];
    const abs = change.path;
    let row = session.fileChanges.find((f) => f.path === abs);
    if (!row) {
      row = {
        path: abs,
        relative: change.relative || abs,
        kind: change.kind || "edit",
        before: change.before ?? null,
        after: change.after ?? null,
        rejected: false,
      };
      session.fileChanges.push(row);
    } else {
      if (change.before != null && row.before == null) row.before = change.before;
      if (change.after != null) row.after = change.after;
      row.kind = change.kind || row.kind;
      row.rejected = false;
    }
    session.updatedAt = Date.now();
    this.save();
    return row;
  }

  rejectChange(filePath, sessionId = null) {
    const session = this._resolveSession(sessionId);
    if (!Array.isArray(session.fileChanges)) return null;
    const row = session.fileChanges.find((f) => f.path === filePath);
    if (!row) return null;
    row.rejected = true;
    session.updatedAt = Date.now();
    this.save();
    return row;
  }

  removeFileChange(filePath, sessionId = null) {
    const session = this._resolveSession(sessionId);
    if (!Array.isArray(session.fileChanges)) return false;
    const before = session.fileChanges.length;
    session.fileChanges = session.fileChanges.filter((f) => f.path !== filePath);
    if (session.fileChanges.length === before) return false;
    session.updatedAt = Date.now();
    this.save();
    return true;
  }

  /** 确认本轮改动：清空摘要列表（不回滚文件） */
  clearFileChanges(sessionId = null) {
    const session = this._resolveSession(sessionId);
    session.fileChanges = [];
    session.updatedAt = Date.now();
    this.save();
    return session.fileChanges;
  }

  getFileChanges(sessionId = null) {
    const session = this._resolveSession(sessionId);
    return Array.isArray(session.fileChanges) ? session.fileChanges : [];
  }

  /** 给渲染进程用：不含 before/after 正文，避免 IPC 体积爆炸 */
  publicFileChanges(sessionOrId = null) {
    const s = this._resolveSession(sessionOrId);
    return (s.fileChanges || []).map((f) => ({
      path: f.path,
      relative: f.relative || f.path,
      kind: f.kind || "edit",
      rejected: !!f.rejected,
    }));
  }

  /**
   * 单文件 before/after（按需 IPC，带长度上限）。
   * @returns {null | { path, relative, kind, rejected, before, after, truncated }}
   */
  getFileChangeBodies(filePath, maxChars = 120_000, sessionId = null) {
    const session = this._resolveSession(sessionId);
    if (!Array.isArray(session.fileChanges) || !filePath) return null;
    const row = session.fileChanges.find((f) => f.path === filePath);
    if (!row) return null;
    const cap = Math.max(4_000, Number(maxChars) || 120_000);
    const half = Math.floor(cap / 2);
    const clip = (s) => {
      if (s == null) return { text: s, truncated: false };
      const t = String(s);
      if (t.length <= half) return { text: t, truncated: false };
      return {
        text: t.slice(0, half) + `\n…(截断，原长 ${t.length})`,
        truncated: true,
      };
    };
    const b = clip(row.before);
    const a = clip(row.after);
    return {
      path: row.path,
      relative: row.relative || row.path,
      kind: row.kind || "edit",
      rejected: !!row.rejected,
      before: b.text,
      after: a.text,
      truncated: !!(b.truncated || a.truncated),
    };
  }

  /**
   * Append on the active branch (parent = current leaf).
   */
  append(message) {
    const session = this.getActive();
    const parentId =
      message.parentId !== undefined
        ? message.parentId
        : session.activeLeafId || null;
    const msg = {
      id: message.id || randomUUID(),
      role: message.role,
      content: message.content,
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      // lightweight attachment meta for UI / vision re-send (no huge bodies required)
      attachments: Array.isArray(message.attachments)
        ? message.attachments
        : undefined,
      parentId,
      createdAt: Date.now(),
    };
    session.messages.push(msg);
    session.activeLeafId = msg.id;
    session.updatedAt = Date.now();
    if (session.title === "新对话" && message.role === "user") {
      session.title = makeSessionTitle(message.content);
    }
    this.save();
    return msg;
  }

  /**
   * Edit an existing user message → new sibling branch (keeps old answers).
   * @returns {{ session, userMsg, path }}
   */
  branchFromUserEdit(messageId, newContent) {
    const session = this.getActive();
    const old = session.messages.find((m) => m.id === messageId);
    if (!old) throw new Error("消息不存在");
    if (old.role !== "user") throw new Error("只能编辑用户消息以创建分支");

    const userMsg = {
      id: randomUUID(),
      role: "user",
      content: String(newContent || ""),
      parentId: old.parentId ?? null,
      createdAt: Date.now(),
      branchedFrom: old.id,
    };
    session.messages.push(userMsg);
    session.activeLeafId = userMsg.id;
    session.updatedAt = Date.now();
    if (session.title === "新对话" || !session.title) {
      session.title = makeSessionTitle(userMsg.content);
    }
    this.save();
    return {
      session,
      userMsg,
      path: getPathToLeaf(session, userMsg.id),
    };
  }

  /**
   * Switch active branch to a different sibling at a fork (by choosing a child id),
   * or jump leaf to any message id (uses that node as leaf if terminal, else deepest default child).
   */
  switchBranch(messageId, directionOrChildId) {
    const session = this.getActive();
    const node = session.messages.find((m) => m.id === messageId);
    if (!node) throw new Error("消息不存在");

    const siblings = getChildren(session, node.parentId);
    if (siblings.length < 2 && directionOrChildId !== "leaf") {
      // still allow setting leaf into this subtree
    }

    let targetId = messageId;
    if (directionOrChildId === "prev" || directionOrChildId === "next") {
      const parentId = node.parentId;
      const kids = getChildren(session, parentId);
      const idx = kids.findIndex((m) => m.id === node.id);
      if (idx < 0) throw new Error("无法定位兄弟分支");
      const nextIdx =
        directionOrChildId === "next"
          ? (idx + 1) % kids.length
          : (idx - 1 + kids.length) % kids.length;
      targetId = kids[nextIdx].id;
    } else if (
      typeof directionOrChildId === "string" &&
      directionOrChildId &&
      directionOrChildId !== "leaf"
    ) {
      // explicit child id under this node, or sibling id
      const asChild = getChildren(session, node.id).find(
        (m) => m.id === directionOrChildId
      );
      const asSibling = getChildren(session, node.parentId).find(
        (m) => m.id === directionOrChildId
      );
      targetId = asChild?.id || asSibling?.id || directionOrChildId;
    }

    // walk to deepest preferred leaf under target
    session.activeLeafId = deepestLeaf(session, targetId);
    session.updatedAt = Date.now();
    this.save();
    return {
      session,
      path: getPathToLeaf(session, session.activeLeafId),
      activeLeafId: session.activeLeafId,
    };
  }

  /** Linear path for the active branch (for UI + LLM). */
  getActivePath(session) {
    const s = session || this.getActive();
    return getPathToLeaf(s, s.activeLeafId);
  }

  /** Branch meta for UI: for each message on path, sibling index. */
  getBranchMeta(session) {
    const s = session || this.getActive();
    const path = getPathToLeaf(s, s.activeLeafId);
    return path.map((m) => {
      const siblings = getChildren(s, m.parentId);
      const index = Math.max(
        0,
        siblings.findIndex((x) => x.id === m.id)
      );
      return {
        id: m.id,
        siblingIndex: index,
        siblingCount: siblings.length,
        parentId: m.parentId,
      };
    });
  }

  clearActive() {
    const session = this.getActive();
    session.messages = [];
    session.activeLeafId = null;
    session.fileChanges = [];
    // 清空后重置标题：后续消息可重新生成标题
    session.title = "新对话";
    session.updatedAt = Date.now();
    this.save();
    return session;
  }

  /** 重命名会话。空/纯空白标题回退「新对话」。 */
  rename(id, title) {
    const session = this.sessions.get(id);
    if (!session) return null;
    const t = makeSessionTitle(title);
    session.title = t;
    session.updatedAt = Date.now();
    this.save();
    return session;
  }

  /** 可见消息数：只统计 user / assistant 且非「调用工具:」占位（排除 tool/reasoning/错误占位） */
  visibleMessageCount(session) {
    const s = session || this.getActive();
    if (!Array.isArray(s.messages)) return 0;
    let n = 0;
    for (const m of s.messages) {
      if (!m) continue;
      const role = m.role || "";
      if (role !== "user" && role !== "assistant") continue;
      if (role === "assistant" && /^调用工具\s*[:：]/.test(String(m.content || "").trim())) continue;
      n++;
    }
    return n;
  }

  remove(id) {
    if (!id || !this.sessions.has(id)) return { ok: false };
    this.sessions.delete(id);
    if (this.activeId === id) {
      const next = this.list()[0];
      this.activeId = next?.id || null;
      if (!this.activeId) this.create("agent");
    }
    this.save();
    return { ok: true, activeId: this.activeId };
  }

  removeMany(ids) {
    const set = new Set((ids || []).filter(Boolean));
    if (!set.size) return { ok: false, removed: 0 };
    let removed = 0;
    for (const id of set) {
      if (this.sessions.has(id)) {
        this.sessions.delete(id);
        removed++;
      }
    }
    if (this.activeId && set.has(this.activeId)) {
      const next = this.list()[0];
      this.activeId = next?.id || null;
      if (!this.activeId) this.create("agent");
    }
    this.save();
    return { ok: true, removed, activeId: this.activeId };
  }
}

function migrateSession(s) {
  if (!s || !Array.isArray(s.messages)) {
    return {
      id: s?.id || randomUUID(),
      title: s?.title || "新对话",
      mode: s?.mode || "agent",
      messages: [],
      activeLeafId: null,
      fileChanges: Array.isArray(s?.fileChanges) ? s.fileChanges : [],
      createdAt: s?.createdAt || Date.now(),
      updatedAt: s?.updatedAt || Date.now(),
    };
  }
  // Already tree?
  const hasParent = s.messages.some(
    (m) => m && (m.parentId !== undefined || m.parentId === null)
  );
  if (hasParent && s.activeLeafId) {
    return {
      ...s,
      messages: s.messages.map((m) => ({
        ...m,
        parentId: m.parentId === undefined ? null : m.parentId,
      })),
      activeLeafId:
        s.activeLeafId ||
        s.messages[s.messages.length - 1]?.id ||
        null,
      fileChanges: Array.isArray(s.fileChanges) ? s.fileChanges : [],
    };
  }
  // Linear → chain
  let prev = null;
  const messages = s.messages.map((m) => {
    const id = m.id || randomUUID();
    const node = {
      ...m,
      id,
      parentId: m.parentId !== undefined ? m.parentId : prev,
    };
    prev = id;
    return node;
  });
  return {
    ...s,
    messages,
    activeLeafId:
      s.activeLeafId || messages[messages.length - 1]?.id || null,
    fileChanges: Array.isArray(s.fileChanges) ? s.fileChanges : [],
  };
}

/**
 * 从用户消息生成会话标题：trim + 折叠空白 + 截断加省略号。
 */
function makeSessionTitle(text) {
  const t = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "新对话";
  return t.length > 22 ? t.slice(0, 22) + "…" : t;
}

function getChildren(session, parentId) {
  const pid = parentId || null;
  return (session.messages || [])
    .filter((m) => (m.parentId || null) === pid)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function getPathToLeaf(session, leafId) {
  if (!leafId) return [];
  const byId = new Map((session.messages || []).map((m) => [m.id, m]));
  const path = [];
  let cur = byId.get(leafId);
  const guard = new Set();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  path.reverse();
  return path;
}

function deepestLeaf(session, startId) {
  let cur = startId;
  const guard = new Set();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const kids = getChildren(session, cur);
    if (!kids.length) return cur;
    // prefer latest child as default branch
    cur = kids[kids.length - 1].id;
  }
  return startId;
}

module.exports = {
  SessionStore,
  getPathToLeaf,
  getChildren,
  deepestLeaf,
  migrateSession,
  makeSessionTitle,
};
