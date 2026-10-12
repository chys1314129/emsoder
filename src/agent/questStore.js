const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { app } = require("electron");
const { clipChangeBodies } = require("./fileChanges");

function questsPath() {
  return path.join(app.getPath("userData"), "emsoder-quests.json");
}

/**
 * Quest task statuses:
 * draft | running | action_required | ready | error | completed | cancelled
 */
const SAVE_DEBOUNCE_MS = 400;
const MAX_QUESTS = 80;
const MAX_QUEST_MESSAGES = 120;

class QuestStore {
  constructor() {
    /** @type {Map<string, object>} */
    this.quests = new Map();
    this.activeId = null;
    this._saveTimer = null;
    this._dirty = false;
    this.debounceMs = SAVE_DEBOUNCE_MS;
    this.load();
  }

  /** 运行中加大防抖（quest 每轮多次写盘），空闲恢复；退出仍 flush 兜底 */
  setDebounceMs(ms) {
    const v = Number(ms);
    if (Number.isFinite(v) && v >= 100) this.debounceMs = v;
  }

  load() {
    try {
      const p = questsPath();
      if (!fs.existsSync(p)) return;
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      for (const q of data.quests || []) {
        if (Array.isArray(q.messages) && q.messages.length > MAX_QUEST_MESSAGES) {
          q.messages = q.messages.slice(-MAX_QUEST_MESSAGES);
        }
        if (typeof q.remark !== "string") q.remark = "";
        this.quests.set(q.id, q);
      }
      this.activeId = data.activeId || null;
    } catch (e) {
      console.error("quest load", e);
    }
  }

  saveNow() {
    this._saveTimer = null;
    this._dirty = false;
    try {
      const p = questsPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const quests = this.list()
        .slice(0, MAX_QUESTS)
        .map((q) => ({
          ...q,
          messages: Array.isArray(q.messages)
            ? q.messages.slice(-MAX_QUEST_MESSAGES)
            : [],
        }));
      const tmp = p + ".tmp";
      // 紧凑序列化：减少主线程 stringify 耗时与写盘体积
      fs.writeFileSync(
        tmp,
        JSON.stringify({ activeId: this.activeId, quests }),
        "utf8"
      );
      fs.renameSync(tmp, p);
    } catch (e) {
      console.error("quest save", e);
      // rename 失败（杀软占用等）时直接覆盖写，避免整个 quests 数据丢失
      try {
        const p = questsPath();
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(
          p,
          JSON.stringify({
            activeId: this.activeId,
            quests: this.list().slice(0, MAX_QUESTS),
          }),
          "utf8"
        );
      } catch (e2) {
        console.error("quest save fallback", e2);
      }
    }
  }

  /** Debounced persist during high-frequency step/message updates */
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
    this.saveNow();
  }

  list() {
    return [...this.quests.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listByStatus() {
    const board = {
      running: [],
      action_required: [],
      ready: [],
      error: [],
      completed: [],
      draft: [],
      cancelled: [],
    };
    for (const q of this.list()) {
      const k = board[q.status] ? q.status : "draft";
      board[k].push(summary(q));
    }
    return board;
  }

  get(id) {
    return this.quests.get(id) || null;
  }

  getActive() {
    if (this.activeId && this.quests.has(this.activeId)) {
      return this.quests.get(this.activeId);
    }
    return null;
  }

  setActive(id) {
    if (id && !this.quests.has(id)) return null;
    this.activeId = id || null;
    this.save();
    return this.getActive();
  }

  create({
    goal,
    title,
    mode = "agent",
    workspace = "",
    model = "",
    providerId = "",
  } = {}) {
    const now = Date.now();
    const g = String(goal || "").trim();
    const quest = {
      id: randomUUID(),
      title: (title || g.slice(0, 48) || "新 Quest").trim(),
      goal: g,
      mode: mode === "experts" ? "experts" : "agent",
      status: "draft",
      workspace: workspace || "",
      model: model || "",
      providerId: providerId || "",
      remark: "",
      plan: [],
      steps: [],
      messages: [],
      fileChanges: [],
      error: "",
      progress: 0,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.quests.set(quest.id, quest);
    this.activeId = quest.id;
    this.save();
    return quest;
  }

  update(id, patch) {
    const q = this.quests.get(id);
    if (!q) return null;
    Object.assign(q, patch, { updatedAt: Date.now() });
    this.quests.set(id, q);
    this.save();
    return q;
  }

  appendMessage(id, msg) {
    const q = this.quests.get(id);
    if (!q) return null;
    const m = {
      id: randomUUID(),
      role: msg.role,
      content: String(msg.content || ""),
      stepId: msg.stepId || null,
      expert: msg.expert || null,
      createdAt: Date.now(),
    };
    q.messages.push(m);
    if (q.messages.length > MAX_QUEST_MESSAGES) {
      q.messages = q.messages.slice(-MAX_QUEST_MESSAGES);
    }
    q.updatedAt = Date.now();
    this.save();
    return m;
  }

  appendStep(id, step) {
    const q = this.quests.get(id);
    if (!q) return null;
    const s = {
      id: step.id || randomUUID(),
      title: step.title || "步骤",
      status: step.status || "pending",
      detail: step.detail || "",
      expert: step.expert || null,
      startedAt: step.startedAt || null,
      finishedAt: step.finishedAt || null,
    };
    q.steps.push(s);
    q.updatedAt = Date.now();
    this.save();
    return s;
  }

  updateStep(id, stepId, patch) {
    const q = this.quests.get(id);
    if (!q) return null;
    const s = q.steps.find((x) => x.id === stepId);
    if (!s) return null;
    Object.assign(s, patch);
    q.updatedAt = Date.now();
    this.save();
    return s;
  }

  recordFileChange(id, change) {
    const q = this.quests.get(id);
    if (!q) return null;
    const abs = change.path;
    let row = q.fileChanges.find((f) => f.path === abs);
    if (!row) {
      row = {
        path: abs,
        relative: change.relative || abs,
        kind: change.kind || "edit",
        before: change.before ?? null,
        after: change.after ?? null,
        rejected: false,
      };
      q.fileChanges.push(row);
    } else {
      if (change.before != null && row.before == null) row.before = change.before;
      if (change.after != null) row.after = change.after;
      row.kind = change.kind || row.kind;
      row.rejected = false;
    }
    q.updatedAt = Date.now();
    this.save();
    return row;
  }

  rejectChange(id, filePath) {
    const q = this.quests.get(id);
    if (!q) return null;
    const row = q.fileChanges.find((f) => f.path === filePath);
    if (!row) return null;
    row.rejected = true;
    q.updatedAt = Date.now();
    this.save();
    return row;
  }

  /** 给渲染进程用：不含 before/after 正文（对齐 Chat 的 publicFileChanges） */
  publicFileChanges(q) {
    return (q?.fileChanges || []).map((f) => ({
      path: f.path,
      relative: f.relative || f.path,
      kind: f.kind || "edit",
      rejected: !!f.rejected,
    }));
  }

  /** 按需取单文件 before/after（带长度上限） */
  getFileChangeBodies(id, filePath, maxChars = 120_000) {
    const q = this.quests.get(id);
    if (!q || !filePath) return null;
    const row = (q.fileChanges || []).find((f) => f.path === filePath);
    if (!row) return null;
    const c = clipChangeBodies(row, maxChars);
    return {
      path: row.path,
      relative: row.relative || row.path,
      kind: row.kind || "edit",
      rejected: !!row.rejected,
      before: c.before,
      after: c.after,
      truncated: c.truncated,
    };
  }

  remove(id) {
    this.quests.delete(id);
    if (this.activeId === id) this.activeId = null;
    this.save();
    return { ok: true };
  }
}

function summary(q) {
  return {
    id: q.id,
    title: q.title,
    goal: q.goal,
    mode: q.mode,
    status: q.status,
    remark: q.remark || "",
    workspace: q.workspace,
    model: q.model,
    progress: q.progress || 0,
    stepCount: (q.steps || []).length,
    changeCount: (q.fileChanges || []).filter((f) => !f.rejected).length,
    error: q.error || "",
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
    startedAt: q.startedAt,
    finishedAt: q.finishedAt,
  };
}

module.exports = { QuestStore, questsPath, summary };
