const fs = require("fs/promises");
const path = require("path");
const { streamChat } = require("../providers");
const { AGENT_TOOLS } = require("../tools/definitions");
const { executeTool } = require("../tools/executor");
const { getActiveModel, getActiveProvider } = require("../core/config");
const { loadProjectRules, formatRulesForPrompt } = require("../tools/rules");
const {
  loadSkillCatalog,
  formatSkillsForPrompt,
} = require("../tools/skills");
const { resolveSafePath } = require("../tools/paths");
const { tracker: contextStats } = require("../core/contextStats");

const MUTATING_TOOLS = new Set([
  "write_file",
  "edit_file",
  "apply_diff",
  "create_document",
]);

// ── Limits (module-level constants, not recreated per call) ──────────────────
const HISTORY_LIMIT = 24;
const TOOL_CONTENT_CAP = 12_000;
const MSG_CONTENT_CAP = 20_000;
const TOOL_RESULT_CAP = 50_000;

// ── Helper: load project rules + skill catalog ────────────────────────────────
async function _loadContext(cfg, workspaceRoot, events) {
  let rulesText = "";
  try {
    const rules = await loadProjectRules(workspaceRoot);
    rulesText = formatRulesForPrompt(rules);
    if (rules.files?.length) events.onStatus?.(`rules: ${rules.files.join(", ")}`);
  } catch { /* ignore rules errors */ }

  let skillsText = "";
  let skillCatalog = null;
  try {
    skillCatalog = await loadSkillCatalog(cfg, workspaceRoot);
    skillsText = formatSkillsForPrompt(skillCatalog);
    const n = skillCatalog.skills?.filter((s) => !s.disabled).length || 0;
    if (n) events.onStatus?.(`skills: ${n}`);
  } catch { /* ignore skill catalog errors */ }

  return { rulesText, skillsText, skillCatalog };
}

// ── Helper: build the messages array for a new turn ──────────────────────────
function _buildMessages(session, sessions, editorCtx, system, visionParts, memoryText = "") {
  const pathMsgs = typeof sessions.getActivePath === "function"
    ? sessions.getActivePath(session)
    : session.messages;
  const history = pathMsgs
    .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
    .slice(-HISTORY_LIMIT);

  const messages = [{ role: "system", content: system }];

  if (editorCtx.activeFile || editorCtx.selection || editorCtx.openTabs?.length) {
    messages.push({
      role: "system",
      content: [
        "当前编辑器上下文:",
        editorCtx.activeFile ? `活动文件: ${editorCtx.activeFile}` : "",
        editorCtx.language ? `语言: ${editorCtx.language}` : "",
        editorCtx.selection
          ? `选中代码:\n\`\`\`${editorCtx.language || ""}\n${String(editorCtx.selection).slice(0, 6000)}\n\`\`\``
          : "",
        editorCtx.cursorLine != null ? `光标行: ${editorCtx.cursorLine}` : "",
        editorCtx.openTabs?.length
          ? `打开标签:\n${editorCtx.openTabs.slice(0, 12).map((t) => `- ${t}`).join("\n")}`
          : "",
      ].filter(Boolean).join("\n"),
    });
  }
  if (visionParts.length) {
    messages.push({ role: "system", content: "用户消息可能含图片。请结合图片内容理解并回答；描述你看到的关键信息。" });
  }
  // Inject retrieved long-term memories (only when relevant - empty string = skip)
  if (memoryText) {
    messages.push({ role: "system", content: `相关长期记忆（按当前消息检索，非全部注入）:\n${memoryText}` });
  }

  const userText = String(
    history.find((m) => m.role === "user")?.content || ""
  );
  for (let hi = 0; hi < history.length; hi++) {
    const m = history[hi];
    const isLastUser = hi === history.length - 1 && m.role === "user" && visionParts.length;
    if (m.role === "tool") {
      let content = String(m.content || "");
      if (content.length > TOOL_CONTENT_CAP) {
        content = content.slice(0, TOOL_CONTENT_CAP) + `\n…(工具输出已截断，共 ${content.length} 字符)`;
      }
      messages.push({ role: "tool", content, name: m.toolName, tool_call_id: m.toolCallId });
    } else if (isLastUser) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: String(m.content || userText || "") }, ...visionParts],
      });
    } else {
      let content = String(m.content || "");
      if (content.length > MSG_CONTENT_CAP) content = content.slice(0, MSG_CONTENT_CAP) + "\n…(已截断)";
      messages.push({ role: m.role, content });
    }
  }
  return messages;
}

// ── Helper: one streaming round → { assistantText, calls, sawUsage, earlyReturn } ──
async function _streamRound(cfg, messages, useTools, signal, events, sessions, mcpManager = null) {
  let assistantText = "";
  const toolCalls = new Map();
  let sawUsage = false;
  const modelName = getActiveModel(cfg);
  const agentTools = useTools
    ? AGENT_TOOLS.concat(mcpManager?.getTools ? mcpManager.getTools() : [])
    : undefined;

  try {
    const snap = contextStats.beginRequest({ model: modelName, cfg, messages, tools: agentTools });
    events.onContextStats?.(snap);
  } catch { /* ignore */ }

  for await (const chunk of streamChat(cfg, { messages, tools: agentTools, signal })) {
    if (chunk.type === "text" && chunk.text) {
      assistantText += chunk.text;
      events.onText?.(chunk.text);
    } else if (chunk.type === "reasoning" && chunk.text) {
      events.onReasoning?.(chunk.text);
    } else if (chunk.type === "usage" && chunk.usage) {
      sawUsage = true;
      try {
        const snap = contextStats.recordUsage(chunk.usage, { model: modelName, source: "api" });
        events.onContextStats?.(snap);
      } catch { /* ignore */ }
    } else if (chunk.type === "tool_call" && chunk.toolCall) {
      const idx = chunk.toolCall.index ?? 0;
      const prev = toolCalls.get(idx);
      toolCalls.set(idx, {
        id: chunk.toolCall.id || prev?.id || `call_${idx}`,
        type: "function",
        function: {
          name: chunk.toolCall.function?.name || prev?.function.name || "",
          arguments: chunk.toolCall.function?.arguments ?? prev?.function.arguments ?? "",
        },
      });
    } else if (chunk.type === "error") {
      events.onError?.(chunk.error || "stream error");
      sessions.append({ role: "assistant", content: `错误: ${chunk.error}` });
      events.onDone?.();
      return { earlyReturn: true };
    }
  }

  if (!sawUsage) {
    try {
      const snap = contextStats.commitEstimateAsUsage({ completionTokens: Math.ceil((assistantText || "").length / 4) });
      events.onContextStats?.(snap);
    } catch { /* ignore */ }
  }

  const calls = [...toolCalls.values()].filter((c) => c.function.name);
  return { assistantText, calls, sawUsage, earlyReturn: false };
}

// ── Helper: execute a tool; MCP tools route to the MCP manager ────────────────
async function executeToolOrMcp(toolCtx, name, argsRaw) {
  if (String(name || "").startsWith("mcp__") && toolCtx.mcpManager) {
    return toolCtx.mcpManager.callTool(name, argsRaw);
  }
  return executeTool(toolCtx, name, argsRaw);
}

// ── Helper: execute all tool calls for one round ──────────────────────────────
async function _dispatchToolCalls(calls, toolCtx, runner, sessions, events, signal, messages) {
  for (const call of calls) {
    if (signal.aborted) break;
    events.onToolStart?.(call.function.name, call.function.arguments);
    try { events.ptyBridge?.mirrorTool?.(call.function.name, "start", String(call.function.arguments || "").slice(0, 120)); } catch { /* ignore */ }

    let snapshotRow = null;
    if (MUTATING_TOOLS.has(call.function.name)) {
      try { snapshotRow = await runner._snapshotBeforeWrite(toolCtx.workspaceRoot, call.function.arguments, toolCtx.sessionId); } catch { /* ignore */ }
    }

    const result = await executeToolOrMcp(toolCtx, call.function.name, call.function.arguments);
    const content = String(result.content || "").slice(0, TOOL_RESULT_CAP);

    if (MUTATING_TOOLS.has(call.function.name)) {
      if (result?.ok === true) {
        try {
          await runner._captureAfterWrite(toolCtx.workspaceRoot, call.function.name, call.function.arguments, toolCtx.sessionId);
          events.onFileChanges?.(sessions.publicFileChanges(toolCtx.sessionId), toolCtx.sessionId);
        } catch { /* ignore */ }
      } else if (snapshotRow?.path) {
        try { runner._discardUnchangedFailedSnapshot(snapshotRow.path, toolCtx.sessionId); } catch { /* ignore */ }
      }
    }

    try { events.ptyBridge?.mirrorTool?.(call.function.name, "end", content.slice(0, 160)); } catch { /* ignore */ }
    events.onToolEnd?.(call.function.name, content);
    sessions.append({ role: "tool", content, toolName: call.function.name, toolCallId: call.id });
    messages.push({ role: "tool", content, name: call.function.name, tool_call_id: call.id });
  }
}

function buildSystemPrompt(cfg, workspaceRoot, rulesText = "", skillsText = "") {
  const provider = getActiveProvider(cfg);
  const model = getActiveModel(cfg);
  const lang = cfg.responseLanguage || "zh-cn";
  const langHint =
    lang === "zh-cn"
      ? "默认用简体中文回复，代码标识符保持原文。"
      : lang === "en"
        ? "Reply in English by default."
        : "Match the user's language.";
  const agentHint = cfg.agentMode !== false
    ? `你处于 AGENT 模式，可调用工具读写文件、搜索、运行终端、生成文档、加载技能。
规则：
- 对代码库不要瞎猜，先用工具确认
- 编辑前先 read_file / search_text
- 改动尽量小而正确
- 工具执行后简要说明做了什么
- 重要改动用 edit_file 精确替换，避免整文件重写
- 同一文件多处修改优先 apply_diff（hunks 或 SEARCH/REPLACE 标记），比多次 edit_file / 整文件 write 更稳
- 用户要 Word/PDF/PPT 时用 create_document（format: docx|pdf|pptx），路径建议放在 exports/
- 任务匹配已安装 Skill 描述时先 load_skill，再按技能说明用终端/文件工具执行（技能来自本机 zcode/agents）
- 用户消息中 @相对路径（如 @src/main.js）表示引用了该文件，你会在上下文中看到对应内容
- 带 mcp__ 前缀的工具来自外部 MCP server（如文件系统/浏览器/GitHub），按需直接调用
- 一次把用户任务做完：不要中途停下来等用户说「继续」；只要还有未完成步骤，就继续调用工具`
    : "你处于 ASK 模式，回答问题并给出代码建议，不要声称已修改文件。需要生成文档或执行技能时提示用户切换到 Agent 模式。";

  // rulesText already starts with FOP priority rules (from loadProjectRules)
  return [
    rulesText || "",
    "你是 EMSoder，免费本地 AI 编程助手（Qoder 风格桌面壳，天蓝色皮肤）。",
    "无账号、无 Credits。用户自带 API Key 或本地模型。",
    agentHint,
    skillsText || "",
    langHint,
    `服务商: ${provider?.name || "none"} (${provider?.type || "?"})`,
    `模型: ${model || "none"}`,
    `工作区: ${workspaceRoot || "(未打开)"}`,
    "直接、实用。优先可运行代码。",
    cfg.systemPrompt ? `用户额外说明:\n${cfg.systemPrompt}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

class AgentRunner {
  constructor(sessions, memoryStore = null, mcpManager = null) {
    this.sessions = sessions;
    this.memoryStore = memoryStore;
    this.mcpManager = mcpManager;
    this.abort = null;
  }

  get isRunning() {
    return !!this.abort;
  }

  stop() {
    this.abort?.abort();
    this.abort = null;
  }

  async runUserMessage(cfg, userText, events = {}, editorCtx = {}) {
    if (this.abort) this.stop();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const workspaceRoot = editorCtx.workspaceRoot || cfg.lastWorkspace || "";

    // Extract image attachments for multimodal messages
    const attachments = Array.isArray(editorCtx.attachments) ? editorCtx.attachments : [];
    const visionParts = attachments
      .filter((a) => a?.kind === "image" && a.dataUrl)
      .map((a) => ({ type: "image_url", image_url: { url: a.dataUrl } }));

    // Begin file-change tracking for this turn (enables undo / summary)
    let turnSessionId = null;
    try {
      const turnSession = this.sessions.beginFileChangeTurn();
      turnSessionId = turnSession?.id || null;
      events.onFileChanges?.(this.sessions.publicFileChanges(turnSessionId), turnSessionId);
    } catch { /* ignore */ }

    // branchFromUserEdit already appended; skip double-append
    if (!editorCtx.skipUserAppend) {
      this.sessions.append({
        role: "user",
        content: userText,
        attachments: attachments.map(({ name, path: p, kind, size }) => ({ name, path: p, kind, size })),
      });
    }

    // Load rules + skills
    const { rulesText, skillsText, skillCatalog } =
      await _loadContext(cfg, workspaceRoot, events);

    // Long-term memory: retrieve relevant memories by current message (not all at start)
    let memoryText = "";
    if (this.memoryStore && cfg.memoriesEnabled === true) {
      try {
        const recentText = (this.sessions.getActive()?.messages || [])
          .slice(-6)
          .map((m) => String(m.content || ""))
          .join(" ");
        const hits = this.memoryStore.search(`${userText} ${recentText}`, { topK: 5 });
        if (hits.length) {
          memoryText = hits
            .map((h) => `- ${h.content}${h.tags?.length ? ` [tags: ${h.tags.join(", ")}]` : ""}`)
            .join("\n");
        }
      } catch { /* ignore memory retrieval errors - never block the chat */ }
    }

    const system = buildSystemPrompt(cfg, workspaceRoot, rulesText, skillsText);
    const session = this.sessions.getActive();
    const messages = _buildMessages(session, this.sessions, editorCtx, system, visionParts, memoryText);

    const useTools = cfg.agentMode !== false;
    const maxRounds = resolveAgentMaxRounds(cfg);
    const maxAutoContinue = resolveAgentAutoContinue(cfg);
    const toolCtx = {
      cfg, workspaceRoot,
      sessionId: turnSessionId,
      openTabs: editorCtx.openTabs || [],
      activeFile: editorCtx.activeFile || "",
      activeSelection: editorCtx.selection || "",
      confirm: events.confirm || (async () => true),
      onFsChange: events.onFsChange,
      ptyBridge: events.ptyBridge || null,
      skillCatalog,
      mcpManager: this.mcpManager || null,
    };

    try {
      let autoContinues = 0;
      let stopReason = "done";
      let usedTools = false;
      let lastAssistantText = "";

      // Outer loop: model ↔ tools up to maxRounds, may auto-continue
      while (!signal.aborted) {
        let hitRoundCap = true;
        for (let round = 0; round < maxRounds; round++) {
          if (signal.aborted) { stopReason = "stopped"; hitRoundCap = false; break; }

          const phase = autoContinues > 0
            ? `agent 续跑${autoContinues} · 第 ${round + 1}/${maxRounds} 轮`
            : `agent 第 ${round + 1}/${maxRounds} 轮`;
          events.onStatus?.(useTools ? phase : "思考中");

          const roundResult = await _streamRound(cfg, messages, useTools, signal, events, this.sessions, this.mcpManager);
          if (roundResult.earlyReturn) { this.abort = null; return; }

          const { assistantText, calls } = roundResult;
          lastAssistantText = assistantText || "";
          this.sessions.append({
            role: "assistant",
            content: assistantText || (calls.length ? `调用工具: ${calls.map((c) => c.function.name).join(", ")}` : ""),
          });

          if (!calls.length) { hitRoundCap = false; stopReason = "done"; break; }

          usedTools = true;
          messages.push({ role: "assistant", content: assistantText, tool_calls: calls });
          await _dispatchToolCalls(calls, toolCtx, this, this.sessions, events, signal, messages);

          if (signal.aborted) { hitRoundCap = false; stopReason = "stopped"; break; }
        }

        if (signal.aborted || stopReason === "stopped") break;

        const wantContinue = useTools && autoContinues < maxAutoContinue &&
          (hitRoundCap || (usedTools && looksLikeNeedsContinue(lastAssistantText)));

        if (wantContinue) {
          autoContinues += 1;
          const cont = "请继续完成尚未完成的工作。不要停下来等用户说「继续」；直接调用工具执行剩余步骤，直到任务真正完成。";
          events.onStatus?.(`自动继续 ${autoContinues}/${maxAutoContinue}`);
          events.onText?.(`\n\n_（自动继续 ${autoContinues}/${maxAutoContinue}：接着干）_\n\n`);
          this.sessions.append({ role: "user", content: cont });
          messages.push({ role: "user", content: cont });
          continue;
        }

        if (hitRoundCap) {
          stopReason = "max_rounds";
          const note = `已达工具轮次上限（${maxRounds} 轮 × 续跑 ${autoContinues}）。可发送「继续」，或在设置提高 agentMaxRounds / agentAutoContinue。`;
          events.onStatus?.(note);
          this.sessions.append({ role: "assistant", content: note });
          events.onText?.("\n\n_（" + note + "）_");
        }
        break;
      }
    } catch (err) {
      if (err?.name === "AbortError" || signal.aborted) {
        events.onStatus?.("stopped");
      } else {
        events.onError?.(err.message || String(err));
      }
    } finally {
      this.abort = null;
      try { events.onFileChanges?.(this.sessions.publicFileChanges(turnSessionId), turnSessionId); } catch { /* ignore */ }
      events.onDone?.();
    }
  }

  /**
   * 写前快照：同一文件只保留本轮第一次 before（与 Quest 一致）
   */
  async _snapshotBeforeWrite(workspaceRoot, argsJson, sessionId = null) {
    const target = parseMutatingPath(argsJson);
    if (!target) return null;
    const resolved = resolveSafePath(workspaceRoot, target);
    if (!resolved.ok) return null;
    let before = null;
    try {
      before = await fs.readFile(resolved.absolute, "utf8");
    } catch {
      before = null;
    }
    return this.sessions.recordFileChange({
      path: resolved.absolute,
      relative: resolved.relative || target,
      kind: before == null ? "create" : "edit",
      before,
    }, sessionId);
  }

  async _captureAfterWrite(workspaceRoot, toolName, argsJson, sessionId = null) {
    const target = parseMutatingPath(argsJson);
    if (!target) return null;
    const resolved = resolveSafePath(workspaceRoot, target);
    if (!resolved.ok) return null;
    let after = null;
    try {
      after = await fs.readFile(resolved.absolute, "utf8");
    } catch {
      after = null;
    }
    const existing = this.sessions
      .getFileChanges(sessionId)
      .find((f) => f.path === resolved.absolute);
    return this.sessions.recordFileChange({
      path: resolved.absolute,
      relative: resolved.relative || target,
      kind:
        toolName === "edit_file" || toolName === "apply_diff"
          ? "edit"
          : existing?.kind || (existing?.before == null ? "create" : "write"),
      before: existing?.before ?? null,
      after,
    }, sessionId);
  }

  _discardUnchangedFailedSnapshot(filePath, sessionId = null) {
    const abs = path.normalize(String(filePath || ""));
    if (!abs) return false;
    const row = this.sessions.getFileChanges(sessionId).find((f) => f.path === abs);
    if (!row || row.after != null) return false;
    return this.sessions.removeFileChange(abs, sessionId);
  }

  /** 回滚单个文件到本轮写前内容 */
  async applyReject(filePath, sessionId = null) {
    const abs = path.normalize(String(filePath || ""));
    if (!abs) throw new Error("缺少路径");
    const row = this.sessions.getFileChanges(sessionId).find((f) => f.path === abs);
    if (!row) throw new Error("未找到变更");
    if (row.rejected) return { ok: true, already: true };

    let current = null;
    let exists = true;
    try {
      current = await fs.readFile(abs, "utf8");
    } catch {
      exists = false;
      current = null;
    }
    if (row.after != null) {
      if (exists && current !== String(row.after)) {
        return {
          ok: false,
          code: "STALE_FILE",
          path: abs,
          error: "文件已被再次修改，未自动撤销",
        };
      }
      if (!exists && row.before != null) {
        return {
          ok: false,
          code: "STALE_FILE",
          path: abs,
          error: "文件已不存在，未自动撤销",
        };
      }
    }

    if (row.before == null) {
      if (exists) {
        try {
          await fs.unlink(abs);
        } catch {
          /* 文件可能已不存在 */
        }
      }
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, row.before, "utf8");
    }
    this.sessions.rejectChange(abs, sessionId);
    return { ok: true, path: abs };
  }

  /** 回滚本轮全部未 rejected 的变更（后写先回） */
  async applyRejectAll(sessionId = null) {
    const rows = this.sessions
      .getFileChanges(sessionId)
      .filter((f) => !f.rejected)
      .slice()
      .reverse();
    const results = [];
    for (const row of rows) {
      try {
        // eslint-disable-next-line no-await-in-loop
        results.push(await this.applyReject(row.path, sessionId));
      } catch (e) {
        results.push({ ok: false, path: row.path, error: e.message || String(e) });
      }
    }
    return { ok: true, results, remaining: this.sessions.publicFileChanges(sessionId) };
  }
}

function parseMutatingPath(argsJson) {
  try {
    const args =
      typeof argsJson === "string"
        ? JSON.parse(argsJson || "{}")
        : argsJson || {};
    const p = args.path || args.filename;
    return p ? String(p) : null;
  } catch {
    return null;
  }
}

function resolveAgentMaxRounds(cfg) {
  const n = Number(cfg?.agentMaxRounds);
  if (Number.isFinite(n) && n >= 4) return Math.min(80, Math.floor(n));
  return 32;
}

function resolveAgentAutoContinue(cfg) {
  if (cfg?.agentAutoContinue === false || cfg?.agentAutoContinue === 0) return 0;
  const n = Number(cfg?.agentAutoContinue);
  if (Number.isFinite(n) && n >= 0) return Math.min(5, Math.floor(n));
  return 2;
}

/** Model often stops mid-task with “下一步 / 需要我继续吗 / TODO” */
function looksLikeNeedsContinue(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (t.length < 40) return false;
  return /需要我继续|要我继续|是否继续|接下来我可以|下一步[：:]|如果你想|请告诉我是否|等你确认|我可以继续|剩余步骤|尚未完成|还没做完|TODO|未完成/i.test(
    t
  );
}

module.exports = {
  AgentRunner,
  buildSystemPrompt,
  resolveAgentMaxRounds,
  resolveAgentAutoContinue,
};
