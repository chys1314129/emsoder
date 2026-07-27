/**
 * Long-term memory store for EMSoder.
 *
 * Memories are short factual statements extracted from past conversations
 * (e.g. "用户用 Rust", "项目数据库是 PostgreSQL"). They are retrieved by
 * keyword + tag overlap scoring on each new user message and injected as a
 * context system message - NOT all injected at conversation start.
 *
 * Storage: userData/emsoder-memories.json (atomic write, same pattern as session.js).
 */
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { memoriesPath } = require("../core/config");

const SAVE_DEBOUNCE_MS = 450;
const DEFAULT_MAX_COUNT = 500;
const DEFAULT_TOP_K = 5;

/**
 * @typedef {Object} Memory
 * @property {string} id
 * @property {string} content
 * @property {string[]} tags
 * @property {number} importance  1-5
 * @property {number} createdAt
 * @property {string} [sessionId]
 */

class MemoryStore {
  constructor(cfg = {}) {
    /** @type {Memory[]} */
    this.memories = [];
    this._dirty = false;
    this._saveTimer = null;
    this._maxCount = Number(cfg.memoriesMaxCount) || DEFAULT_MAX_COUNT;
    this.load();
  }

  setMaxCount(n) {
    this._maxCount = Number(n) > 0 ? Math.floor(Number(n)) : DEFAULT_MAX_COUNT;
  }

  load() {
    try {
      const p = memoriesPath();
      if (!fs.existsSync(p)) return;
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      this.memories = Array.isArray(data.memories)
        ? data.memories.filter((m) => m && typeof m.content === "string")
        : [];
    } catch (e) {
      console.error("memory load", e);
      this.memories = [];
    }
  }

  saveNow() {
    this._saveTimer = null;
    this._dirty = false;
    try {
      const p = memoriesPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = p + ".tmp";
      fs.writeFileSync(
        tmp,
        JSON.stringify({ memories: this.memories }, null, 2),
        "utf8"
      );
      fs.renameSync(tmp, p);
    } catch (e) {
      console.error("memory save", e);
    }
  }

  save() {
    this._dirty = true;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), SAVE_DEBOUNCE_MS);
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirty) this.saveNow();
  }

  /**
   * List memories, optionally filtered.
   * @param {{limit?:number, tag?:string, q?:string}} opts
   * @returns {Memory[]}
   */
  list(opts = {}) {
    let out = [...this.memories];
    if (opts.tag) {
      const t = String(opts.tag).toLowerCase();
      out = out.filter((m) => (m.tags || []).some((x) => x.toLowerCase() === t));
    }
    if (opts.q) {
      const q = String(opts.q).toLowerCase();
      out = out.filter(
        (m) =>
          m.content.toLowerCase().includes(q) ||
          (m.tags || []).some((x) => x.toLowerCase().includes(q))
      );
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (opts.limit) out = out.slice(0, opts.limit);
    return out;
  }

  /**
   * Add a memory. Evicts oldest+least-important when over maxCount.
   * @param {{content:string, tags?:string[], importance?:number, sessionId?:string}} mem
   * @returns {Memory}
   */
  add(mem) {
    const content = String(mem?.content || "").trim();
    if (!content) throw new Error("content required");
    const tags = Array.isArray(mem?.tags)
      ? mem.tags.map((t) => String(t).trim()).filter(Boolean)
      : [];
    const importance = Math.min(5, Math.max(1, Number(mem?.importance) || 3));
    /** @type {Memory} */
    const m = {
      id: randomUUID(),
      content,
      tags,
      importance,
      createdAt: Date.now(),
      sessionId: mem?.sessionId || undefined,
    };
    this.memories.push(m);
    this._evictIfNeeded();
    this.save();
    return m;
  }

  _evictIfNeeded() {
    if (this.memories.length <= this._maxCount) return;
    // Evict: lowest importance first, then oldest
    const sorted = [...this.memories].sort((a, b) => {
      const imp = (a.importance || 3) - (b.importance || 3);
      if (imp !== 0) return imp;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
    const toRemove = sorted.slice(0, this.memories.length - this._maxCount);
    const ids = new Set(toRemove.map((m) => m.id));
    this.memories = this.memories.filter((m) => !ids.has(m.id));
  }

  update(id, patch) {
    const m = this.memories.find((x) => x.id === id);
    if (!m) return null;
    if (typeof patch.content === "string") m.content = patch.content.trim();
    if (Array.isArray(patch.tags))
      m.tags = patch.tags.map((t) => String(t).trim()).filter(Boolean);
    if (typeof patch.importance === "number")
      m.importance = Math.min(5, Math.max(1, patch.importance));
    this.save();
    return m;
  }

  remove(id) {
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => m.id !== id);
    if (this.memories.length !== before) this.save();
    return this.memories.length !== before;
  }

  clear() {
    this.memories = [];
    this.save();
  }

  /**
   * Tokenize a query for scoring. CJK chars -> single chars; ASCII -> words.
   * @param {string} text
   * @returns {string[]}
   */
  _tokenize(text) {
    const s = String(text || "").toLowerCase();
    const tokens = [];
    // ASCII words
    const ascii = s.match(/[a-z][a-z0-9_-]{1,}/g) || [];
    tokens.push(...ascii);
    // CJK single chars (covers Chinese/Japanese/Korean)
    const cjk = s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || [];
    tokens.push(...cjk);
    return tokens;
  }

  /**
   * Score and rank memories by relevance to a query.
   * - tag exact hit: +2 per tag
   * - content token hit: +1 per occurrence
   * - importance weight: × (0.5 + importance/10)
   * @param {string} query
   * @param {{topK?:number}} opts
   * @returns {Memory[]}
   */
  search(query, opts = {}) {
    const topK = opts.topK || DEFAULT_TOP_K;
    const tokens = this._tokenize(query);
    if (!tokens.length) return [];
    const tokenSet = new Set(tokens);
    const scored = [];
    for (const m of this.memories) {
      let score = 0;
      const tags = (m.tags || []).map((t) => t.toLowerCase());
      for (const t of tags) {
        if (tokenSet.has(t)) score += 2;
        else if (tokens.some((tk) => t.includes(tk))) score += 1;
      }
      const contentLower = m.content.toLowerCase();
      for (const tk of tokens) {
        if (contentLower.includes(tk)) score += 1;
      }
      if (score <= 0) continue;
      const imp = m.importance || 3;
      score *= 0.5 + imp / 10;
      scored.push({ m, score });
    }
    scored.sort((a, b) => b.score - a.score || b.m.createdAt - a.m.createdAt);
    return scored.slice(0, topK).map((x) => x.m);
  }

  /**
   * Extract memories from a session's recent messages via a one-shot LLM call.
   * Fire-and-forget friendly: never throws to caller (logs on error).
   * @param {object} session - SessionStore.getActive() result
   * @param {object} cfg
   * @param {object} [opts] - { chatOnce } for test injection
   * @returns {Promise<Memory[]>}
   */
  async extractFromSession(session, cfg, opts = {}) {
    if (!session?.messages?.length) return [];
    const chatOnce =
      opts.chatOnce || require("../providers").chatOnce;
    try {
      // Take last ~20 messages from the active path
      let pathMsgs = session.messages;
      if (typeof session.getActivePath === "function") {
        // SessionStore method, but session here is the plain object - skip
      }
      const recent = pathMsgs
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-20)
        .map((m) => ({ role: m.role, content: String(m.content || "").slice(0, 1500) }));
      if (recent.length < 2) return [];

      const sys =
        "从对话中提取长期有用的事实和用户偏好，输出 JSON 数组，每条 {content, tags, importance(1-5)}。" +
        "只提取稳定事实（如「用户用 Rust」「项目是 PostgreSQL」「用户偏好函数式风格」），" +
        "不要提取任务片段、临时需求或一次性的代码片段。无值得记的返回 []。";
      const text = await chatOnce(cfg, {
        messages: [
          { role: "system", content: sys },
          { role: "user", content: JSON.stringify(recent) },
        ],
        maxTokens: 1024,
        temperature: 0.1,
      });
      const items = this._parseExtracted(text);
      const added = [];
      for (const it of items) {
        try {
          added.push(this.add({ ...it, sessionId: session.id }));
        } catch {
          /* skip bad entry */
        }
      }
      return added;
    } catch (e) {
      console.error("memory extract", e);
      return [];
    }
  }

  /** Parse LLM output into memory items (tolerant of markdown fences). */
  _parseExtracted(text) {
    let s = String(text || "").trim();
    // strip ```json ... ``` fences
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    try {
      const arr = JSON.parse(s);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter(
          (x) => x && typeof x.content === "string" && x.content.trim()
        )
        .map((x) => ({
          content: String(x.content).trim(),
          tags: Array.isArray(x.tags)
            ? x.tags.map((t) => String(t)).filter(Boolean)
            : [],
          importance: Math.min(5, Math.max(1, Number(x.importance) || 3)),
        }));
    } catch {
      return [];
    }
  }
}

module.exports = { MemoryStore };
