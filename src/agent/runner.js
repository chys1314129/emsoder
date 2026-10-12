const fs = require("fs/promises");
const path = require("path");
const { streamChat } = require("../providers");
const { normalizeContextHistory } = require("./contextHistory");
const { AGENT_TOOLS } = require("../tools/definitions");
const { executeTool } = require("../tools/executor");
const { getActiveModel, getActiveProvider } = require("../core/config");
const { loadProjectRules, formatRulesForPrompt } = require("../tools/rules");
const {
  loadSkillCatalog,
  formatSkillsForPrompt,
} = require("../tools/skills");
const { resolveSafePath } = require("../tools/paths");
const {
  tracker: contextStats,
  estimateMessagesTokens,
  resolveContextWindow,
} = require("../core/contextStats");
const {
  parseMutatingPath,
  looksLikeNeedsContinue,
  looksLikeFinished,
  looksLikeHandoff,
  rollbackFileRow,
} = require("./fileChanges");
const {
  compressActiveSession,
  shouldAutoCompress,
} = require("./compress");

const MUTATING_TOOLS = new Set([
  "write_file",
  "edit_file",
  "apply_diff",
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
  const pathMsgs = typeof sessions.getContextPath === "function"
    ? sessions.getContextPath(session)
    : typeof sessions.getActivePath === "function"
      ? sessions.getActivePath(session)
      : session.messages;
  const usable = pathMsgs.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "tool"
  );
  const tail = usable.slice(-HISTORY_LIMIT);
  const firstUser = usable.find((m) => m.role === "user");
  const lastRealUser = [...usable].reverse().find(
    (m) => m.role === "user" && !String(m.content || "").includes("请继续完成尚未完成的工作")
  );
  const pinned = [];
  if (firstUser && !tail.includes(firstUser)) pinned.push(firstUser);
  if (lastRealUser && lastRealUser !== firstUser && !tail.includes(lastRealUser)) {
    pinned.push(lastRealUser);
  }
  // A history-window cut must never leave an assistant tool call or a tool
  // result on its own. Normalize again after pin/tail selection.
  const history = normalizeContextHistory(pinned.length ? [...pinned, ...tail] : tail);

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
      // 仅当同批历史中存在携带对应 tool_calls 的 assistant 消息时才发送，
      // 否则丢弃——防止跨轮重建时产生孤儿 tool 消息（provider 直接 400）
      let content = String(m.content || "");
      if (content.length > TOOL_CONTENT_CAP) {
        content = content.slice(0, TOOL_CONTENT_CAP) + `\n…(工具输出已截断，共 ${content.length} 字符)`;
      }
      messages.push({ role: "tool", content, name: m.toolName, tool_call_id: m.toolCallId });
    } else if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      let content = String(m.content || "");
      if (content.length > MSG_CONTENT_CAP) content = content.slice(0, MSG_CONTENT_CAP) + "\n…(已截断)";
      messages.push({ role: "assistant", content, tool_calls: m.tool_calls });
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
async function _streamRound(cfg, messages, useTools, signal, events, sessions, mcpManager = null, turnSessionId = null) {
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
    } else if (chunk.type === "status") {
      events.onStatus?.(chunk.status || "");
    } else if (chunk.type === "error") {
      events.onError?.(chunk.error || "stream error");
      sessions.append({ role: "assistant", content: `错误: ${chunk.error}` }, turnSessionId);
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

    // 停止后工具才返回：丢弃结果，不记录文件变更、不追加消息
    if (signal.aborted) break;

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
    sessions.append({ role: "tool", content, toolName: call.function.name, toolCallId: call.id }, toolCtx.sessionId);
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
  const {
    normalizePermissionMode,
    permissionMeta,
  } = require("../tools/confirm");
  const permMode = normalizePermissionMode(cfg);
  const perm = permissionMeta(permMode);
  const permHint =
    permMode === "plan"
      ? `当前权限：计划模式。不要调用 write_file / edit_file / apply_diff / run_terminal。先用 read/search 了解代码，再输出清晰可执行的修改计划（步骤、涉及文件、风险），等用户切换到「自动编辑」「高危才询问」或「完全授权」后再动手。`
      : permMode === "confirm"
        ? `当前权限：变更前确认。改文件/跑命令前系统会弹窗问用户；你仍可正常调用工具，但要准备好被拒绝后改方案。`
        : permMode === "unrestricted"
          ? `当前权限：完全授权。不要停下来等用户确认。文件编辑和终端命令都会自动执行，由你自己判断风险并继续把任务做完。`
          : permMode === "full"
            ? `当前权限：高危才询问。文件编辑与安全终端命令会自动执行；只有高危命令才可能询问用户。`
            : `当前权限：自动编辑。文件读写/编辑会自动执行；终端命令仍可能需要用户确认。`;
  const agentHint = cfg.agentMode !== false
    ? `你处于 AGENT 模式，可调用工具读写文件、搜索、运行终端、生成文档、加载技能。
${permHint}
规则：
- 对代码库不要瞎猜，先用工具确认
- 编辑前先 read_file / search_text
- 改动尽量小而正确
- 工具执行后简要说明做了什么
- 重要改动用 edit_file 精确替换，避免整文件重写
- 同一文件多处修改优先 apply_diff（hunks 或 SEARCH/REPLACE 标记），比多次 edit_file / 整文件 write 更稳
- 用户要生成 Office 文档时，先 load_skill 对应预装技能并按工作流执行：Word 用 minimax-docx，PDF 用 minimax-pdf，Excel 用 minimax-xlsx；生成文件路径建议放在 exports/。精美 PPT 必须用 ppt-master，普通 PPT 可用 pptx-generator
- 做 PPT/PDF 需要图片时，可先 search_images 搜图 → download_image 下到 exports/assets/；把相对路径交给所选技能的工作流使用
- 用户明确要「精美 / 好看 / 高质量 / 设计感」的 PPT/演示/汇报/路演时，必须 load_skill ppt-master 并按其说明做完；这是用户指定的效果，不许自行以「流程太重 / 步骤多 / 更快」为由改用其它工具。ppt-master 的多步骤和确认环节是正常的，直接按 SKILL.md 的运行提示用终端执行到底
- 若 ppt-master 确实无法运行（如缺少它要求的图片生成 API Key、脚本报错），要先如实说明卡在哪、缺什么，再询问用户选择哪个替代 PPT 技能；不要默默降级
- 任务匹配已安装 Skill 描述时先 load_skill，再按技能说明用终端/文件工具执行（技能来自本机 zcode/agents）
- 用户消息中 @相对路径（如 @src/main.js）表示引用了该文件，你会在上下文中看到对应内容
- 带 mcp__ 前缀的工具来自外部 MCP server（如文件系统/浏览器/GitHub），按需直接调用
- 你有联网能力：需要最新信息、查资料、读文档时直接调 web_search（搜）和 web_fetch（读网页）；不确定的事实先联网核实，不要对用户说「我没有联网」
- 一次把用户任务做完：不要中途停下来等用户说「继续」；只要还有未完成步骤，就继续调用工具
- 不要说「先到这」「等你确认再继续」「需要我继续吗」。任务没做完就接着调工具`
    : "你处于 ASK 模式，回答问题并给出代码建议，不要声称已修改文件。需要生成文档或执行技能时提示用户切换到 Agent 模式。";

  // rulesText already starts with FOP priority rules (from loadProjectRules)
  return [
    rulesText || "",
    "你是 EMSoder，本地 AI 编程助手。打开文件夹，按用户的话改文件，等用户确认或撤销。",
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
    this.runs = new Map(); // sessionId -> AbortController
  }

  get isRunning() {
    return this.runs.size > 0;
  }

  isSessionRunning(sessionId) {
    return !!(sessionId && this.runs.has(sessionId));
  }

  stop(sessionId = null) {
    if (sessionId) {
      const ctrl = this.runs.get(sessionId);
      ctrl?.abort();
      return !!ctrl;
    }
    for (const ctrl of this.runs.values()) ctrl.abort();
    return this.runs.size > 0;
  }

  async runUserMessage(cfg, userText, events = {}, editorCtx = {}) {
    const requestedSessionId = editorCtx.sessionId || null;
    const session = (requestedSessionId && this.sessions.getById?.(requestedSessionId)) || this.sessions.getActive();
    const turnSessionId = session?.id;
    if (!turnSessionId) throw new Error("无活动会话");
    // Same-session protection remains; independent sessions can run concurrently.
    this.stop(turnSessionId);
    const controller = new AbortController();
    this.runs.set(turnSessionId, controller);
    const signal = controller.signal;
    const workspaceRoot = editorCtx.workspaceRoot || session.workspaceRoot || cfg.lastWorkspace || "";

    // Extract image attachments for multimodal messages
    const attachments = Array.isArray(editorCtx.attachments) ? editorCtx.attachments : [];
    const visionParts = attachments
      .filter((a) => a?.kind === "image" && a.dataUrl)
      .map((a) => ({ type: "image_url", image_url: { url: a.dataUrl } }));

    // Begin file-change tracking on the session frozen at submission time.
    try {
      this.sessions.beginFileChangeTurn(turnSessionId);
      events.onFileChanges?.(this.sessions.publicFileChanges(turnSessionId), turnSessionId);
    } catch { /* ignore */ }

    // branchFromUserEdit already appended; skip double-append
    if (!editorCtx.skipUserAppend) {
      this.sessions.append({
        role: "user",
        content: userText,
        attachments: attachments.map((a) => ({ name: a?.name, path: a?.path, kind: a?.kind, size: a?.size })),
      }, turnSessionId);
    }

    // Load rules + skills
    const { rulesText, skillsText, skillCatalog } =
      await _loadContext(cfg, workspaceRoot, events);

    // Long-term memory: retrieve relevant memories by current message (not all at start)
    let memoryText = "";
    if (this.memoryStore && cfg.memoriesEnabled === true) {
      try {
        const recentText = (this.sessions.getById(turnSessionId)?.messages || this.sessions.getActive()?.messages || [])
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
    const turnSession = this.sessions.getById(turnSessionId) || session;
    const messages = _buildMessages(turnSession, this.sessions, editorCtx, system, visionParts, memoryText);

    const useTools = cfg.agentMode !== false;
    const maxRounds = resolveAgentMaxRounds(cfg);
    const maxAutoContinue = resolveAgentAutoContinue(cfg);
    let stopReason = "done";
    const toolCtx = {
      cfg, workspaceRoot,
      sessionId: turnSessionId,
      signal, // 供 executeTool 长任务（run_terminal 等）响应 stop 中止
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
      let usedTools = false;
      let lastAssistantText = "";
      let autoCompacted = 0;

      const maybeAutoCompact = async () => {
        if (signal.aborted || autoCompacted >= 3) return;
        const windowSize = resolveContextWindow(getActiveModel(cfg), cfg);
        const used = estimateMessagesTokens(
          messages,
          useTools ? AGENT_TOOLS : undefined
        );
        const fillPercent = windowSize > 0 ? (used / windowSize) * 100 : 0;
        if (!shouldAutoCompress(cfg, { fillPercent })) return;
        events.onStatus?.("上下文较高，正在自动压缩");
        const r = await compressActiveSession({
          sessions: this.sessions,
          cfg,
          sessionId: turnSessionId,
          keepRecent: 8,
          keepFileChanges: true,
        });
        if (!r?.ok) return;
        autoCompacted += 1;
        const rebuilt = _buildMessages(
          this.sessions.getById(turnSessionId) || this.sessions.getActive(),
          this.sessions,
          editorCtx,
          system,
          visionParts,
          memoryText
        );
        messages.splice(0, messages.length, ...rebuilt);
        events.onStatus?.(
          `已自动压缩上下文（${r.pathCount} → ${r.afterCount}）`
        );
        events.onText?.(
          `\n\n_（已自动压缩上下文：${r.pathCount} → ${r.afterCount}，最初目标和最近对话还在）_\n\n`
        );
        if (r.stats) events.onContextStats?.(r.stats);
      };

      // Outer loop: model ↔ tools up to maxRounds, may auto-continue
      while (!signal.aborted) {
        let hitRoundCap = Number.isFinite(maxRounds);
        const roundLimit = Number.isFinite(maxRounds) ? maxRounds : Number.MAX_SAFE_INTEGER;
        for (let round = 0; round < roundLimit; round++) {
          if (signal.aborted) { stopReason = "stopped"; hitRoundCap = false; break; }
          await maybeAutoCompact();
          if (signal.aborted) { stopReason = "stopped"; hitRoundCap = false; break; }

          const phase = autoContinues > 0
            ? `agent 续跑${autoContinues} · 第 ${round + 1} 轮`
            : `agent 第 ${round + 1} 轮`;
          events.onStatus?.(useTools ? phase : "思考中");

          const roundResult = await _streamRound(cfg, messages, useTools, signal, events, this.sessions, this.mcpManager, turnSessionId);
          if (roundResult.earlyReturn) {
            stopReason = "error";
            return;
          }

          const { assistantText, calls } = roundResult;
          lastAssistantText = assistantText || "";
          this.sessions.append({
            role: "assistant",
            content: assistantText || (calls.length ? `调用工具: ${calls.map((c) => c.function.name).join(", ")}` : ""),
            tool_calls: calls,
          }, turnSessionId);

          if (!calls.length) { hitRoundCap = false; stopReason = "done"; break; }

          usedTools = true;
          messages.push({ role: "assistant", content: assistantText, tool_calls: calls });
          await _dispatchToolCalls(calls, toolCtx, this, this.sessions, events, signal, messages);

          if (signal.aborted) { hitRoundCap = false; stopReason = "stopped"; break; }
          await maybeAutoCompact();
        }

        if (signal.aborted || stopReason === "stopped") break;

        const unfinishedClose =
          looksLikeNeedsContinue(lastAssistantText) ||
          looksLikeHandoff(lastAssistantText) ||
          (usedTools && !String(lastAssistantText || "").trim());
        const wantContinue =
          useTools &&
          autoContinues < maxAutoContinue &&
          !looksLikeFinished(lastAssistantText) &&
          (hitRoundCap || unfinishedClose);

        if (wantContinue) {
          autoContinues += 1;
          const cont = "请继续完成尚未完成的工作。不要停下来等用户说「继续」；直接调用工具执行剩余步骤，直到任务真正完成。";
          const contLabel = Number.isFinite(maxAutoContinue)
            ? `${autoContinues}/${maxAutoContinue}`
            : String(autoContinues);
          events.onStatus?.(`自动继续 ${contLabel}`);
          events.onText?.(`\n\n_（自动继续 ${contLabel}：接着干）_\n\n`);
          this.sessions.append({ role: "user", content: cont }, turnSessionId);
          messages.push({ role: "user", content: cont });
          continue;
        }

        if (hitRoundCap) {
          stopReason = "max_rounds";
          const note = `已达工具轮次上限（${maxRounds} 轮 × 续跑 ${autoContinues}）。点停止可中止；或在设置把轮次改成 0 表示不限制。`;
          events.onStatus?.(note);
          this.sessions.append({ role: "assistant", content: note }, turnSessionId);
          events.onText?.("\n\n_（" + note + "）_");
        }
        break;
      }
    } catch (err) {
      if (err?.name === "AbortError" || signal.aborted) {
        stopReason = "stopped";
        events.onStatus?.("stopped");
      } else {
        stopReason = "error";
        events.onError?.(err.message || String(err));
      }
    } finally {
      if (this.runs.get(turnSessionId) === controller) this.runs.delete(turnSessionId);
      try {
        this.sessions.settleRun(stopReason === "stopped" ? "stopped" : "done", turnSessionId);
      } catch { /* ignore */ }
      try { events.onFileChanges?.(this.sessions.publicFileChanges(turnSessionId), turnSessionId); } catch { /* ignore */ }
      events.onDone?.(stopReason);
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

    const result = await rollbackFileRow(row);
    if (result.ok && !result.already) {
      this.sessions.rejectChange(abs, sessionId);
    }
    return result;
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

function resolveAgentMaxRounds(cfg) {
  const n = Number(cfg?.agentMaxRounds);
  if (!Number.isFinite(n) || n <= 0) return Number.POSITIVE_INFINITY;
  if (n >= 4) return Math.floor(n);
  return Number.POSITIVE_INFINITY;
}

function resolveAgentAutoContinue(cfg) {
  if (cfg?.agentAutoContinue === false || cfg?.agentAutoContinue === 0) return 0;
  const n = Number(cfg?.agentAutoContinue);
  if (!Number.isFinite(n) || n < 0) return Number.POSITIVE_INFINITY;
  return Math.floor(n);
}

module.exports = {
  AgentRunner,
  buildSystemPrompt,
  resolveAgentMaxRounds,
  resolveAgentAutoContinue,
};
