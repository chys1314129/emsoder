const { randomUUID } = require("crypto");
const { normalizeContextHistory } = require("../agent/contextHistory");
const { getActiveModel, getActiveProvider } = require("../core/config");
const { streamChat } = require("../providers");
const { AGENT_TOOLS } = require("../tools/definitions");
const { executeTool } = require("../tools/executor");
const { validateArguments } = require("../tools/validateArguments");
const { loadSkillCatalog, formatSkillsForPrompt } = require("../tools/skills");
const {
  tracker: contextStats,
  resolveContextWindow,
} = require("../core/contextStats");
const {
  compressActiveSession,
} = require("../agent/compress");
const {
  looksLikeFinished,
  looksLikeNeedsContinue,
} = require("../agent/fileChanges");
const { getOAuthBearerToken } = require("../core/oauth");
const { METHODS } = require("./protocol");
const { PiSidecarClient } = require("./sidecarClient");

const MUTATING_TOOLS = new Set(["write_file", "edit_file", "apply_diff"]);
const MAX_RUNTIME_RESTARTS = 2;

/** EMSoder 思考档位 → Pi thinking token 预算（按上下文窗口比例，Pi 侧也有归一化）。 */
function thinkingBudgetsFor(cfg) {
  const win = Number(cfg?.contextWindow) || 128000;
  return {
    low: Math.max(2048, Math.floor(win * 0.02)),
    medium: Math.max(4096, Math.floor(win * 0.06)),
    high: Math.max(8192, Math.floor(win * 0.16)),
  };
}
function thinkingBudgetForLevel(cfg, level) {
  const b = thinkingBudgetsFor(cfg);
  const l = String(level || "medium").toLowerCase();
  if (l === "off") return 0;
  if (l === "low") return b.low;
  if (l === "high" || l === "ultra") return b.high;
  return b.medium;
}

function asPiToolDefs() {
  return AGENT_TOOLS.map((t) => ({
    name: t.function.name,
    label: t.function.name,
    description: t.function.description || "",
    parameters: t.function.parameters || { type: "object", properties: {} },
  }));
}

function textFromResult(result) {
  if (!result) return "";
  if (typeof result.content === "string") return result.content;
  return JSON.stringify(result);
}

function piMessagesToProvider(messages, systemPrompt = "") {
  const out = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });
  for (const m of messages || []) {
    if (!m || !m.role) continue;
    if (m.role === "user") {
      out.push({ role: "user", content: typeof m.content === "string" ? m.content : m.content });
    } else if (m.role === "assistant") {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const text = blocks.filter((b) => b?.type === "text").map((b) => b.text || "").join("");
      const calls = blocks.filter((b) => b?.type === "toolCall").map((b) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.arguments || {}) },
      }));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (m.role === "toolResult") {
      out.push({
        role: "tool",
        // Preserve content blocks so a text-only lane can reject non-text data.
        content: Array.isArray(m.content) ? m.content : textFromResult(m),
        tool_call_id: m.toolCallId,
        name: m.toolName,
      });
    }
  }
  return out;
}

function piToolsToProvider(tools) {
  return (tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.parameters || { type: "object", properties: {} },
    },
  }));
}

/**
 * Pi-backed runner with the same small surface used by IPC.
 * Pi owns model↔tool looping in a sidecar; EMSoder owns every tool operation.
 */
class PiRunnerAdapter {
  constructor(sessions, legacyRunner, mcpManager = null) {
    this.sessions = sessions;
    this.legacyRunner = legacyRunner;
    this.mcpManager = mcpManager;
    this.clients = new Map(); // sessionId -> PiSidecarClient
    this.active = new Map(); // sessionId -> { client, abort, runId }
  }

  get isRunning() {
    return this.active.size > 0;
  }

  _client(sessionId) {
    let client = this.clients.get(sessionId);
    if (client) return client;
    client = new PiSidecarClient({
      onRequest: (method, params) => this._handleSidecarRequest(sessionId, method, params),
      onNotification: (params) => this._handleSidecarEvent(sessionId, params),
      onStderr: (text) => { if (text.trim()) this._lastStderr = text.slice(-2000); },
      onExit: (code, signal) => this._onSidecarExit(sessionId, code, signal),
    });
    this.clients.set(sessionId, client);
    return client;
  }

  /** sidecar 进程意外退出：当前 run 标记 crashed 并解挂 done，由 runUserMessage 循环决定是否重启续跑。 */
  _onSidecarExit(sessionId, code, signal) {
    const run = this.active.get(sessionId);
    if (!run || run.terminated) return;
    run.terminated = true;
    run.crashed = true;
    run.crashInfo = { code, signal };
    run.reason = "crashed";
    try { run.resolveDone?.(); } catch { /* ignore */ }
  }

  async runUserMessage(cfg, userText, events = {}, editorCtx = {}) {
    const requestedSessionId = editorCtx.sessionId || null;
    const session = (requestedSessionId && this.sessions.getById?.(requestedSessionId)) || this.sessions.getActive();
    const sessionId = session?.id;
    if (!sessionId) throw new Error("无活动会话");
    const runId = randomUUID();
    let client = this._client(sessionId);
    const turn = this.sessions.beginFileChangeTurn(sessionId);
    const signalController = new AbortController();
    const append = (message) => this.sessions.append(message, sessionId);

    const runMode = editorCtx.runMode === "plan" || editorCtx.runMode === "goal" ? editorCtx.runMode : "auto";
    const planApproved = editorCtx.planApproved === true;
    const maxAutoContinue =
      runMode === "goal"
        ? (Number(cfg.agentAutoContinue) === 0 ? 0 : Number(cfg.agentAutoContinue) > 0 ? Number(cfg.agentAutoContinue) : -1)
        : -1; // 非 goal 模式不自动续跑

    const run = {
      sessionId, client, abort: signalController, runId, events, cfg, editorCtx,
      turnId: runId, resolveDone: null, skillCatalog: null,
      reason: "done", terminated: false, crashed: false,
      runMode, planApproved, autoContinues: 0, lastAssistantText: "",
    };
    this.active.set(sessionId, run);
    const done = new Promise((resolve) => { run.resolveDone = resolve; });
    // 本地 abort 时立即结束本轮等待，不等 sidecar 的 agent_end——
    // 否则点一次「停止」只中断当前请求，主循环仍卡在 await done，
    // 需要反复点停止直到 sidecar 真正结束。
    const abortPromise = new Promise((resolve) => {
      if (signalController.signal.aborted) resolve();
      else signalController.signal.addEventListener("abort", resolve, { once: true });
    });

    const historyFor = () => {
      // content 参数会成为 Pi 侧下一条 user 消息；若会话路径末尾正好是刚追加的
      // user 消息（本轮/续跑/恢复提示），从 history 中剔除，避免重复注入。
      const path = (this.sessions.getContextPath?.(turn) || this.sessions.getActivePath(turn) || []);
      const dropTrailingUser =
        path.length && path[path.length - 1]?.role === "user";
      return normalizeContextHistory(dropTrailingUser ? path.slice(0, -1) : path).map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
        toolName: m.toolName,
        toolCallId: m.toolCallId,
        tool_calls: Array.isArray(m.tool_calls) ? m.tool_calls : undefined,
        tool_call_id: m.tool_call_id,
      }));
    };

    const buildSystemPrompt = () => {
      const skillsText = formatSkillsForPrompt(run.skillCatalog);
      return [
        "你是 EMSoder 的 Pi Agent。请使用工具完成用户任务，不要中途等待用户。",
        "需要某个技能时，先调用 load_skill，再严格按技能说明执行；技能脚本可位于工作区之外，按 load_skill 返回的绝对路径和 cwd 运行。产物必须写回当前工作区。",
        "你有联网能力：需要最新信息、查资料、读文档时直接调 web_search（搜）和 web_fetch（读网页）；不确定的事实先联网核实，不要对用户说「我没有联网」。",
        runMode === "goal"
          ? "当前是目标模式（goal）：自动执行直到目标真正完成，不要停下来询问，工具执行完就继续下一步。"
          : runMode === "plan" && !planApproved
            ? "当前是计划模式（plan）：先用一段话给出可执行计划（不改文件、不跑命令），等待用户批准后再执行。"
            : "",
        skillsText,
      ].filter(Boolean).join("\n\n");
    };

    const providerPayload = () => {
      const provider = getActiveProvider(cfg) || {};
      const model = getActiveModel(cfg);
      return {
        provider: {
          id: provider.id,
          type: provider.type,
          api: provider.type === "anthropic" ? "anthropic-messages" : "openai-completions",
          model,
          baseUrl: provider.baseUrl,
          maxTokens: cfg.maxTokens,
          contextWindow: resolveContextWindow(model, cfg),
          reasoning: cfg.reasoningEffort !== "off",
        },
        model,
      };
    };

    try {
      run.skillCatalog = await loadSkillCatalog(cfg, run.editorCtx.workspaceRoot || cfg.lastWorkspace || "");
      if (!editorCtx.skipUserAppend) append({ role: "user", content: userText });

      let content = userText;
      let restarts = 0;
      for (;;) {
        if (signalController.signal.aborted) break;
        run.crashed = false;
        run.terminated = false;
        const { provider: providerInfo, model } = providerPayload();
        const thinkingLevel = cfg.reasoningEffort === "off" ? "off" : (cfg.reasoningEffort || "medium");
        try {
          const prompt = await client.prompt({
            sessionId,
            turnId: runId,
            content,
            provider: providerInfo,
            model,
            thinkingLevel,
            thinkingBudgets: thinkingBudgetsFor(cfg),
            runMode: run.runMode,
            planApproved: run.planApproved,
            systemPrompt: buildSystemPrompt(),
            history: historyFor(),
            tools: asPiToolDefs(),
          });
          if (!prompt?.accepted) throw new Error("Pi sidecar 未接受任务");
          await Promise.race([done, abortPromise]);
        } catch (error) {
          if (run.crashed && restarts < MAX_RUNTIME_RESTARTS && !signalController.signal.aborted) {
            restarts += 1;
            events.onStatus?.(`Pi runtime 意外退出，自动恢复中（${restarts}/${MAX_RUNTIME_RESTARTS}）…`);
            // 换新客户端进程重启 sidecar；会话历史仍在 SessionStore，续跑即可
            this.clients.delete(sessionId);
            try { await client.close(); } catch { /* ignore */ }
            client = this._client(sessionId);
            run.client = client;
            run.terminated = false;
            content = "（系统提示：上次 Pi 运行时意外中断，已自动恢复）继续完成上面的任务，不要从头解释，直接接着做。";
            if (editorCtx.skipUserAppend !== true) append({ role: "user", content: content });
            continue;
          }
          throw error;
        }

        // goal 模式：模型提前收口时自动续跑，直到完成或达到次数上限
        const wantContinue =
          run.runMode === "goal" &&
          (maxAutoContinue === -1 || run.autoContinues < maxAutoContinue) &&
          !looksLikeFinished(run.lastAssistantText) &&
          (run.lastAssistantText.trim() === "" ||
            looksLikeNeedsContinue(run.lastAssistantText));
        if (!wantContinue) break;
        run.autoContinues += 1;
        events.onStatus?.(`目标模式自动续跑 ${maxAutoContinue === -1 ? run.autoContinues : `${run.autoContinues}/${maxAutoContinue}`}`);
        content = "请继续完成尚未完成的工作。不要停下来等用户说「继续」；直接调用工具执行剩余步骤，直到任务真正完成。";
        if (editorCtx.skipUserAppend !== true) append({ role: "user", content: content });
      }
    } catch (error) {
      if (!signalController.signal.aborted) events.onError?.(error.message || String(error));
      throw error;
    } finally {
      this.active.delete(sessionId);
      const reason = run?.reason || (signalController.signal.aborted ? "stopped" : "done");
      try { this.sessions.settleRun(reason, sessionId); } catch { /* ignore */ }
      events.onFileChanges?.(this.sessions.publicFileChanges(sessionId), sessionId);
      events.onDone?.(reason);
    }
  }

  async _handleSidecarRequest(sessionId, method, params) {
    const run = this.active.get(sessionId);
    if (!run) throw Object.assign(new Error("Pi run not found"), { code: -32000 });
    if (method === METHODS.providerStream) return this._proxyProvider(run, params);
    if (method === METHODS.prepareTurn || method === METHODS.compactHost) {
      return this._proxyCompactHost(run);
    }
    if (method === METHODS.oauthToken) return this._proxyOAuthToken(run, params);
    if (method === "provider.abort") {
      run.abort.abort();
      return { ok: true };
    }
    if (method === METHODS.toolInvoke) return this._proxyTool(run, params);
    throw Object.assign(new Error(`Unsupported Pi parent request: ${method}`), { code: -32601 });
  }

  /**
   * Pi 完整接管压缩：Pi 已用自身 token 估算决定压缩时机，这里只负责执行真实
   * 压缩（会话存储 + 摘要）并返回替换历史。压缩失败/会话过短时返回未压缩，
   * Pi 侧继续使用原上下文，不阻断本轮。
   */
  async _proxyCompactHost(run, chat = undefined) {
    const session = this.sessions.getById(run.sessionId) || this.sessions.getActive();
    if (!session) return { compacted: false };
    const r = await compressActiveSession({
      sessions: this.sessions,
      cfg: run.cfg,
      sessionId: run.sessionId,
      keepRecent: 8,
      keepFileChanges: true,
      ...(typeof chat === "function" ? { chat } : {}),
    });
    if (!r?.ok) return { compacted: false };
    run.events.onStatus?.(`已自动压缩上下文（${r.pathCount} → ${r.afterCount}）`);
    run.events.onText?.(`\n\n_（已自动压缩上下文：${r.pathCount} → ${r.afterCount}，最初目标和最近对话还在）_\n\n`);
    if (r.stats) run.events.onContextStats?.(r.stats);
    const compacted = (this.sessions.getById(run.sessionId) || session);
    const history = (this.sessions.getContextPath?.(compacted) || this.sessions.getActivePath(compacted) || []).map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      toolName: m.toolName,
      toolCallId: m.toolCallId,
      tool_calls: Array.isArray(m.tool_calls) ? m.tool_calls : undefined,
      tool_call_id: m.tool_call_id,
    }));
    return { compacted: true, history, pathCount: r.pathCount, afterCount: r.afterCount, stats: r.stats || null };
  }

  /** Pi 自行鉴权时（OAuth provider）经主进程取当前 access token（自动刷新）。 */
  async _proxyOAuthToken(run, params) {
    const providerId = String(params?.provider || "");
    try {
      const token = await getOAuthBearerToken(run.cfg, providerId);
      return typeof token === "string" && token ? { ok: true, token } : { ok: false, error: "no oauth token" };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  async _proxyProvider(run, params) {
    const events = [];
    let finalText = "";
    let finalThinking = "";
    let finalUsage = null;
    let sawUsage = false;
    let errorMessage = "";
    const toolCalls = new Map();
    const callKeys = new Map();
    const providerTools = piToolsToProvider(params.context?.tools || []);
    const allowedTools = new Set(providerTools.map((t) => t.function.name));
    const isSub = !!params.subSessionId;
    const modelName = params.model?.id || getActiveModel(run.cfg);
    const providerMessages = piMessagesToProvider(params.context?.messages || [], params.context?.systemPrompt || "");
    if (!isSub) {
      try {
        const snap = contextStats.beginRequest({
          model: modelName,
          cfg: run.cfg,
          messages: providerMessages,
          tools: providerTools,
        });
        run.events.onContextStats?.(snap);
      } catch { /* ignore */ }
    }
    // Pi 思考档位 → 本次请求的 token 预算（Pi 侧归一化后的档位 + 预算表）
    const level = String(params.reasoning || run.cfg.reasoningEffort || "medium").toLowerCase();
    const thinkingBudget = params.thinkingBudgets
      ? (level === "off" ? 0
        : level === "low" ? (Number(params.thinkingBudgets.low) || 0)
        : level === "high" || level === "ultra" ? (Number(params.thinkingBudgets.high) || 0)
        : (Number(params.thinkingBudgets.medium) || 0))
      : 0;
    try {
      for await (const chunk of streamChat(run.cfg, {
        messages: providerMessages,
        tools: providerTools,
        signal: run.abort.signal,
        reasoningEffort: run.cfg.reasoningEffort,
        thinkingBudget,
        maxTokens: params.maxTokens ?? run.cfg.maxTokens,
        temperature: params.temperature ?? run.cfg.temperature,
      })) {
        if (chunk.type === "error") {
          errorMessage = String(chunk.error?.message || chunk.error || "provider error");
          events.push({ type: "error", error: errorMessage });
          break;
        }
        if (run.abort.signal.aborted) break;
        if (chunk.type === "text") { finalText += chunk.text || ""; events.push({ type: "text", text: chunk.text || "" }); }
        else if (chunk.type === "reasoning") {
          finalThinking += chunk.text || "";
          events.push({ type: "reasoning", text: chunk.text || "" });
        } else if (chunk.type === "status") {
          if (typeof chunk.status === "string") run.events.onStatus?.(chunk.status);
        } else if (chunk.type === "usage") {
          sawUsage = true;
          finalUsage = chunk.usage || null;
          if (!isSub) {
            try {
              const snap = contextStats.recordUsage(chunk.usage, { model: modelName, source: "api" });
              run.events.onContextStats?.(snap);
            } catch { /* ignore */ }
          }
        } else if (chunk.type === "tool_call") {
          const c = chunk.toolCall || {};
          const indexKey = Number.isInteger(c.index) && c.index >= 0 ? `index:${c.index}` : null;
          const idKey = typeof c.id === "string" && c.id ? `id:${c.id}` : null;
          const key = callKeys.get(indexKey) ?? callKeys.get(idKey) ?? indexKey ?? idKey;
          if (key == null) throw new Error("工具调用缺少稳定的 index/id");
          const previous = toolCalls.get(key);
          // 供应商发的是累计快照，不拼接参数；别名保持仅 index → id 的调用身份稳定。
          const call = {
            id: c.id || previous?.id,
            name: c.function?.name ?? c.name ?? previous?.name,
            arguments: c.function?.arguments !== undefined ? c.function.arguments : c.arguments,
            index: c.index ?? previous?.index,
          };
          toolCalls.set(key, call);
          if (indexKey) callKeys.set(indexKey, key);
          if (idKey) callKeys.set(idKey, key);
        }
      }
    } catch (error) {
      errorMessage ||= String(error?.message || error || "provider error");
      events.push({ type: "error", error: errorMessage });
    }
    // 与旧后端一致：大量 OpenAI 兼容服务不会在流式结束块回 usage，
    // 仍要把 beginRequest 的本地估算落账，否则底栏会一直显示 ctx 0/容量。
    if (!isSub && !sawUsage) {
      try {
        const snap = contextStats.commitEstimateAsUsage({
          completionTokens: Math.ceil((finalText || "").length / 4),
        });
        run.events.onContextStats?.(snap);
        finalUsage = {
          prompt_tokens: snap.usedTokens || 0,
          completion_tokens: snap.completionTokens || Math.ceil((finalText || "").length / 4),
          total_tokens: (snap.usedTokens || 0) + (snap.completionTokens || 0),
          _source: "estimate",
        };
      } catch { /* ignore */ }
    }
    const content = [];
    if (finalThinking) content.push({ type: "thinking", thinking: finalThinking });
    if (finalText) content.push({ type: "text", text: finalText });
    const validatedCalls = [];
    if (!errorMessage && !run.abort.signal.aborted) {
      try {
        for (const call of toolCalls.values()) {
          // Pi 兜底只接受上下文白名单中的原名；Harmony 名称恢复由供应商 adapter 负责。
          if (typeof call.name !== "string" || !allowedTools.has(call.name)) {
            throw new Error(`未知工具: ${String(call.name || "")}`);
          }
          let arguments_ = call.arguments;
          if (typeof arguments_ === "string") {
            try { arguments_ = JSON.parse(arguments_); } catch {
              throw new Error(`工具 ${call.name} 的参数不是合法 JSON`);
            }
          }
          if (arguments_ === null || typeof arguments_ !== "object" || Array.isArray(arguments_)) {
            throw new Error(`工具 ${call.name} 的参数必须是 JSON object`);
          }
          validateArguments(arguments_, providerTools.find((t) => t.function.name === call.name)?.function.parameters);
          validatedCalls.push({ ...call, id: String(call.id || randomUUID()), arguments: arguments_ });
        }
      } catch (error) {
        errorMessage = String(error?.message || error);
        events.push({ type: "error", error: errorMessage });
      }
    }
    // 全部验证成功才暴露工具，错误或停止时连 toolcall_end 事件也不能携带可执行参数。
    if (!errorMessage && !run.abort.signal.aborted) {
      for (const call of validatedCalls) {
        content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
        events.push({ type: "tool_call", call });
      }
    }
    if (run.abort.signal.aborted && !errorMessage) errorMessage = "已停止";
    const message = {
      role: "assistant",
      content,
      api: params.model?.api || "openai-completions",
      provider: params.model?.provider || "emsoder",
      model: params.model?.id || getActiveModel(run.cfg),
      usage: { input: finalUsage?.prompt_tokens || 0, output: finalUsage?.completion_tokens || 0, cacheRead: 0, cacheWrite: 0, totalTokens: finalUsage?.total_tokens || 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: run.abort.signal.aborted ? "aborted" : errorMessage ? "error" : (validatedCalls.length ? "toolUse" : "stop"),
      ...(errorMessage ? { errorMessage } : {}),
      timestamp: Date.now(),
    };
    return { events, final: message };
  }

  async _proxyTool(run, params) {
    const name = String(params.name || "");
    const isSub = !!params.subSessionId;
    if (name === "spawn_subagent" && !isSub) {
      // 子代理派发在 adapter 层实现：直接在 sidecar 内建子 runtime
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      return await this._spawnSubagents(run, args);
    }
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    const raw = JSON.stringify(args);
    let snapshot = null;
    if (MUTATING_TOOLS.has(name)) {
      try { snapshot = await this.legacyRunner._snapshotBeforeWrite(run.editorCtx.workspaceRoot || run.cfg.lastWorkspace, raw, run.sessionId); } catch { /* ignore */ }
    }
    const ctx = {
      cfg: run.cfg,
      workspaceRoot: run.editorCtx.workspaceRoot || run.cfg.lastWorkspace || "",
      sessionId: run.sessionId,
      signal: run.abort.signal,
      openTabs: run.editorCtx.openTabs || [],
      activeFile: run.editorCtx.activeFile || "",
      activeSelection: run.editorCtx.selection || "",
      confirm: run.events.confirm || (async () => false),
      onFsChange: run.events.onFsChange,
      ptyBridge: run.events.ptyBridge || null,
      skillCatalog: run.skillCatalog,
      mcpManager: this.mcpManager,
    };
    const result = String(name).startsWith("mcp__") && this.mcpManager
      ? await this.mcpManager.callTool(name, raw)
      : await executeTool(ctx, name, raw);
    if (run.abort.signal.aborted) return { ok: false, content: "已停止" };
    // 文件变更事务：快照→执行→后写捕获，与旧后端完全一致；子代理的真实改动
    // 同样进入父会话的审阅队列，但不污染父会话对话记录。
    if (MUTATING_TOOLS.has(name)) {
      if (result?.ok === true) {
        try {
          await this.legacyRunner._captureAfterWrite(ctx.workspaceRoot, name, raw, run.sessionId);
          run.events.onFileChanges?.(this.sessions.publicFileChanges(run.sessionId), run.sessionId);
        } catch { /* ignore */ }
      } else if (snapshot?.path) {
        try { this.legacyRunner._discardUnchangedFailedSnapshot(snapshot.path, run.sessionId); } catch { /* ignore */ }
      }
    }
    if (!isSub) {
      this.sessions.append({ role: "tool", content: textFromResult(result), toolName: name, toolCallId: params.callId }, run.sessionId);
    }
    return result;
  }

  /** spawn_subagent：sidecar 内并行子 runtime；任务组上限 6 个并行。 */
  async _spawnSubagents(run, args) {
    const tasks = Array.isArray(args.tasks)
      ? args.tasks.slice(0, 6)
      : [{ task: String(args.task || args.prompt || "").trim() }];
    if (!tasks.length || !tasks.every((t) => t && String(t.task || "").trim())) {
      return { ok: false, content: "spawn_subagent 需要 task（或 tasks 数组，最多 6 个并行任务）" };
    }
    const provider = getActiveProvider(run.cfg) || {};
    const model = getActiveModel(run.cfg);
    // 子代理禁用 spawn_subagent（防递归），其余工具完整可用
    const tools = asPiToolDefs().filter((t) => t.name !== "spawn_subagent");
    const maxRounds = Math.min(24, Math.max(1, Number(args.maxRounds) || 8));
    const sysPrompt = String(args.systemPrompt || [
      "你是主 Agent 派出的子代理。独立完成分配的子任务，可调用工具（读写文件、搜索、联网、技能）。",
      "完成任务后输出简洁结论：做了什么、结果是什么。不要询问用户。",
    ].join("\n"));
    const runOne = async (task) => {
      const subSessionId = randomUUID();
      run.events.onStatus?.(`子代理开始: ${String(task.task || "").slice(0, 40)}`);
      try {
        const result = await run.client.subagentRun({
          sessionId: run.sessionId,
          subSessionId,
          task: String(task.task || ""),
          systemPrompt: sysPrompt,
          maxRounds,
          provider: {
            id: provider.id,
            type: provider.type,
            api: provider.type === "anthropic" ? "anthropic-messages" : "openai-completions",
            model,
            baseUrl: provider.baseUrl,
            maxTokens: run.cfg.maxTokens,
            contextWindow: resolveContextWindow(model, run.cfg),
            reasoning: run.cfg.reasoningEffort !== "off",
          },
          model,
          thinkingLevel: run.cfg.reasoningEffort === "off" ? "off" : (run.cfg.reasoningEffort || "medium"),
          thinkingBudgets: thinkingBudgetsFor(run.cfg),
          tools,
        });
        return {
          task: String(task.task || ""),
          ok: result?.ok !== false,
          content: String(result?.content || ""),
        };
      } catch (error) {
        return { task: String(task.task || ""), ok: false, content: String(error?.message || error) };
      }
    };
    const results = await Promise.all(tasks.map(runOne));
    const content = [
      `子代理结果（${results.length} 个）：`,
      ...results.map((r, i) =>
        `${i + 1}. 任务: ${r.task}\n   ${r.ok ? "完成" : "失败"}: ${String(r.content).slice(0, 3000)}`
      ),
    ].join("\n");
    return { ok: results.every((r) => r.ok), content };
  }

  _handleSidecarEvent(sessionId, envelope) {
    const run = this.active.get(sessionId);
    if (!run || envelope.sessionId && envelope.sessionId !== sessionId) return;
    const event = envelope.event || {};
    const isSub = !!envelope.subSessionId;
    const out = run.events;
    switch (event.type) {
      case "agent_start":
        if (isSub) out.onStatus?.(`子代理 ${envelope.subSessionId.slice(0, 8)} 启动`);
        else out.onStatus?.("Pi Agent 启动");
        break;
      case "turn_start": if (!isSub) out.onStatus?.("Pi 思考中"); break;
      case "message_update":
        // 子代理输出属于其独立上下文：不能直接混进父 Agent 的流式回答，
        // 否则 UI 会把评审草稿当成主回答，也会污染 goal 完成判定。
        if (isSub) break;
        if (event.deltaText) {
          out.onText?.(event.deltaText);
          run.lastAssistantText = (run.lastAssistantText || "") + event.deltaText;
        }
        if (event.deltaThinking) out.onReasoning?.(event.deltaThinking);
        break;
      case "message_end":
        // 子代理的助手消息不进入父会话对话记录（其工具结果由子 runtime 自持）
        if (isSub) break;
        if (event.message?.role === "assistant") {
          const text = (event.message.content || [])
            .filter((b) => b?.type === "text")
            .map((b) => b.text || "")
            .join("");
          const calls = (event.message.content || [])
            .filter((b) => b?.type === "toolCall")
            .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.arguments || {}) } }));
          if (text || calls.length) {
            this.sessions.append({ role: "assistant", content: text || (calls.length ? `调用工具: ${calls.map((c) => c.function.name).join(", ")}` : ""), tool_calls: calls }, sessionId);
          }
        }
        break;
      case "plan_ready":
        out.onPlanReady?.(String(event.planText || ""), event.note || "");
        break;
      case "subagent_status": out.onStatus?.(String(event.note || "子代理状态更新")); break;
      case "tool_start": out.onToolStart?.(event.toolName, JSON.stringify(event.args || {})); break;
      case "tool_end": out.onToolEnd?.(event.toolName, textFromResult(event.result)); break;
      case "compaction_start": out.onStatus?.(event.manual ? "Pi 正在压缩上下文（手动）" : "Pi 正在压缩上下文"); break;
      case "compaction_end": out.onStatus?.("Pi 上下文压缩完成"); break;
      case "error":
        // 子代理失败由 spawn_subagent 的结果返回给父 Agent；绝不能结束父 run。
        if (isSub) {
          out.onStatus?.(`子代理失败: ${textFromResult(event.error).slice(0, 240)}`);
          break;
        }
        run.reason = run.abort.signal.aborted ? "stopped" : "error";
        out.onError?.(textFromResult(event.error));
        run.resolveDone?.();
        break;
      case "agent_end":
        // 子代理结束只是 spawn_subagent 工具等待条件，父 Agent 必须继续拿结果跑下一轮。
        if (!isSub) run.resolveDone?.();
        break;
      default: break;
    }
  }

  isSessionRunning(sessionId) {
    return !!(sessionId && this.active.has(sessionId));
  }

  stop(sessionId = null) {
    if (sessionId) {
      const run = this.active.get(sessionId);
      if (!run) return false;
      run.abort.abort();
      run.client.abort({ sessionId, runId: run.runId }).catch(() => {});
      // Keep this sidecar runtime alive until its normal agent_end; the next
      // prompt will refresh its session state without affecting other sessions.
      return true;
    }
    for (const [id, run] of this.active) {
      run.abort.abort();
      run.client.abort({ sessionId: id, runId: run.runId }).catch(() => {});
    }
    for (const client of this.clients.values()) client.close().catch(() => {});
    return true;
  }

  async close() {
    for (const client of this.clients.values()) {
      try { await client.close(); } catch { /* ignore */ }
    }
    this.clients.clear();
    this.active.clear();
  }

  async applyReject(filePath, sessionId = null) { return this.legacyRunner.applyReject(filePath, sessionId); }
  async applyRejectAll(sessionId = null) { return this.legacyRunner.applyRejectAll(sessionId); }
}

module.exports = { PiRunnerAdapter, asPiToolDefs };
