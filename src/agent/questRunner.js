const path = require("path");
const fs = require("fs/promises");
const { randomUUID } = require("crypto");
const { streamChat, chatOnce } = require("../providers");
const { AGENT_TOOLS } = require("../tools/definitions");
const { executeTool } = require("../tools/executor");
const {
  getActiveModel,
  getActiveProvider,
  getProviders,
  getEnabledProviders,
} = require("../core/config");
const { loadProjectRules, formatRulesForPrompt } = require("../tools/rules");
const {
  loadSkillCatalog,
  formatSkillsForPrompt,
} = require("../tools/skills");
const {
  parseMutatingPath,
  resolveUnder,
  looksLikeNeedsContinue,
  rollbackFileRow,
} = require("./fileChanges");

/**
 * Resolve third-party provider for a Quest (per-quest override, then global active).
 * Supports OpenAI-compatible / Anthropic / Ollama / custom gateways via BYOK config.
 */
function resolveQuestProvider(cfg, quest) {
  const all = getProviders(cfg);
  const enabled = getEnabledProviders(cfg);
  if (quest?.providerId) {
    const hit =
      enabled.find((p) => p.id === quest.providerId) ||
      all.find((p) => p.id === quest.providerId);
    if (hit) return hit;
  }
  return getActiveProvider(cfg);
}

function resolveQuestModel(cfg, quest, provider) {
  if (quest?.model) return quest.model;
  if (provider?.models?.length) {
    const active = getActiveModel(cfg);
    if (active && provider.models.includes(active)) return active;
    return provider.models[0];
  }
  return getActiveModel(cfg);
}

/**
 * Goal-driven Quest runner. Local. User brings the model.
 * Phases: plan -> execute (agent or experts) -> ready for review
 */
class QuestRunner {
  constructor(questStore, memoryStore = null, mcpManager = null) {
    this.store = questStore;
    this.memoryStore = memoryStore;
    this.mcpManager = mcpManager;
    /** @type {Map<string, AbortController>} */
    this.aborts = new Map();
  }

  isRunning(questId) {
    return this.aborts.has(questId);
  }

  stop(questId) {
    const ac = this.aborts.get(questId);
    if (ac) {
      ac.abort();
      this.aborts.delete(questId);
    }
    if (questId) {
      const q = this.store.get(questId);
      if (q && q.status === "running") {
        this.store.update(questId, {
          status: "cancelled",
          error: "用户停止",
          finishedAt: Date.now(),
        });
      }
    }
    return { ok: true };
  }

  stopAll() {
    for (const id of [...this.aborts.keys()]) this.stop(id);
  }

  /**
   * @param {object} cfg app config
   * @param {string} questId
   * @param {object} events callbacks for UI
   * @param {object} bridges { ptyBridge, confirm }
   */
  async start(cfg, questId, events = {}, bridges = {}) {
    const quest = this.store.get(questId);
    if (!quest) throw new Error("Quest 不存在");
    if (!quest.goal?.trim()) throw new Error("请先填写目标 goal");
    if (this.aborts.has(questId)) throw new Error("该 Quest 已在运行");

    const ac = new AbortController();
    this.aborts.set(questId, ac);
    const signal = ac.signal;
    const workspaceRoot = quest.workspace || cfg.lastWorkspace || "";

    const emit = (type, data = {}) => {
      events.onEvent?.({ type, questId, ...data });
    };

    this.store.update(questId, {
      status: "running",
      error: "",
      progress: 5,
      startedAt: Date.now(),
      finishedAt: null,
      steps: [],
      // 每次运行重置变更集：撤销只回滚到本次运行之前，
      // 避免复用上次运行的过期 before 快照
      fileChanges: [],
    });
    emit("status", { status: "running", progress: 5 });

    try {
      let rulesText = "";
      try {
        const rules = await loadProjectRules(workspaceRoot);
        rulesText = formatRulesForPrompt(rules);
      } catch {
        /* ignore */
      }
      let skillsText = "";
      let skillCatalog = null;
      try {
        skillCatalog = await loadSkillCatalog(cfg, workspaceRoot);
        skillsText = formatSkillsForPrompt(skillCatalog);
      } catch {
        /* ignore */
      }
      // per-quest 上下文：并发 Quest 互不污染技能目录/记忆注入
      this._runCtx = this._runCtx || new Map();
      this._runCtx.set(questId, { skillCatalog, skillsText, memoryText: "" });

      // ---- Long-term memory: 按目标检索相关记忆注入系统提示 ----
      let memoryText = "";
      if (this.memoryStore && cfg.memoriesEnabled === true) {
        try {
          const hits = this.memoryStore.search(quest.goal, { topK: 5 });
          if (hits.length) {
            memoryText = hits
              .map((h) => `- ${h.content}${h.tags?.length ? ` [tags: ${h.tags.join(", ")}]` : ""}`)
              .join("\n");
          }
        } catch { /* ignore memory retrieval errors - never block the quest */ }
      }
      const ctx = this._runCtx.get(questId);
      if (ctx) ctx.memoryText = memoryText;

      // ---- Phase 1: Plan ----
      const planStep = this.store.appendStep(questId, {
        title: "制定计划",
        status: "running",
        startedAt: Date.now(),
        expert: "planner",
      });
      emit("step", { step: planStep });
      this.store.appendMessage(questId, {
        role: "system",
        content: `Quest 开始 · 模式=${quest.mode} · 工作区=${workspaceRoot || "(无)"}`,
      });

      const plan = await this._makePlan(cfg, quest, workspaceRoot, rulesText, signal);
      this.store.update(questId, {
        plan,
        progress: 20,
        title: quest.title === "新 Quest" || !quest.title
          ? plan[0]?.title?.slice(0, 40) || quest.goal.slice(0, 40)
          : quest.title,
      });
      this.store.updateStep(questId, planStep.id, {
        status: "done",
        finishedAt: Date.now(),
        detail: plan.map((p, i) => `${i + 1}. ${p.title}`).join("\n"),
      });
      this.store.appendMessage(questId, {
        role: "assistant",
        content:
          "计划：\n" +
          plan.map((p, i) => `${i + 1}. **${p.title}** — ${p.detail || ""}`).join("\n"),
        expert: "planner",
        stepId: planStep.id,
      });
      emit("plan", { plan });
      emit("message", {});
      emit("status", { status: "running", progress: 20 });

      if (signal.aborted) throw new Error("aborted");

      // ---- Phase 2: Execute ----
      if (quest.mode === "experts") {
        await this._runExperts(
          cfg,
          questId,
          workspaceRoot,
          rulesText,
          plan,
          signal,
          events,
          bridges
        );
      } else {
        await this._runAgentExecute(
          cfg,
          questId,
          workspaceRoot,
          rulesText,
          plan,
          signal,
          events,
          bridges
        );
      }

      if (signal.aborted) throw new Error("aborted");

      // ---- Phase 3: Ready for review ----
      const q = this.store.get(questId);
      const changes = (q?.fileChanges || []).filter((f) => !f.rejected);
      this.store.update(questId, {
        status: "ready",
        progress: 100,
        finishedAt: Date.now(),
        error: "",
      });
      this.store.appendMessage(questId, {
        role: "assistant",
        content: changes.length
          ? `任务完成，待审阅。共 ${changes.length} 个文件变更，请在右侧 Changes 中检查。`
          : "任务流程结束。未记录到文件变更（可能只做了分析/搜索）。",
      });
      emit("status", { status: "ready", progress: 100 });
      emit("done", { status: "ready" });
      // Fire-and-forget: 从本次 Quest 提取长期记忆（不阻塞 UI）
      if (this.memoryStore && cfg.memoriesEnabled === true) {
        try {
          this.memoryStore.extractFromSession(q, cfg).catch(() => { /* ignore */ });
        } catch { /* ignore */ }
      }
    } catch (err) {
      if (signal.aborted || err?.message === "aborted") {
        emit("status", { status: "cancelled" });
        emit("done", { status: "cancelled" });
      } else {
        this.store.update(questId, {
          status: "error",
          error: err?.message || String(err),
          finishedAt: Date.now(),
        });
        this.store.appendMessage(questId, {
          role: "assistant",
          content: `错误: ${err?.message || err}`,
        });
        emit("error", { error: err?.message || String(err) });
        emit("status", { status: "error" });
        emit("done", { status: "error" });
      }
    } finally {
      this.aborts.delete(questId);
      if (this._runCtx) this._runCtx.delete(questId);
    }
  }

  async _makePlan(cfg, quest, workspaceRoot, rulesText, signal) {
    const provider = resolveQuestProvider(cfg, quest);
    const model = resolveQuestModel(cfg, quest, provider);
    if (!provider || !model) {
      throw new Error(
        "Quest 未配置可用模型。请在顶栏「服务商」添加第三方模型（Ollama / DeepSeek / OpenAI 兼容 / Anthropic），再创建或启动任务。"
      );
    }
    // stamp resolved binding so UI shows the real model used
    if (!quest.model || !quest.providerId) {
      this.store.update(quest.id, {
        model: model,
        providerId: provider.id,
      });
      quest.model = model;
      quest.providerId = provider.id;
    }
    const prompt = [
      "你是软件项目规划助手。根据用户目标，输出 JSON 数组计划（不要 markdown 围栏）。",
      '格式: [{"title":"步骤标题","detail":"做什么"}]',
      "3～8 步，可执行、可验证。",
      rulesText ? `项目规则摘要已加载。` : "",
      `工作区: ${workspaceRoot || "(未绑定)"}`,
      `服务商: ${provider.name} · 模型: ${model}`,
      `目标: ${quest.goal}`,
    ]
      .filter(Boolean)
      .join("\n");

    let text = "";
    try {
      text = await chatOnce(cfg, {
        provider,
        model,
        messages: [
          { role: "system", content: "只输出 JSON 数组，不要其它说明。" },
          { role: "user", content: prompt },
        ],
        maxTokens: 2048,
        temperature: 0.2,
        signal,
      });
    } catch (e) {
      return [
        { title: "理解目标并探索代码库", detail: quest.goal },
        { title: "实现改动", detail: "按目标修改相关文件" },
        { title: "自检", detail: "检查改动是否完整" },
      ];
    }

    const parsed = extractJsonArray(text);
    if (parsed?.length) {
      return parsed
        .map((p) => ({
          title: String(p.title || p.name || "步骤").slice(0, 80),
          detail: String(p.detail || p.description || "").slice(0, 400),
        }))
        .slice(0, 10);
    }
    return [
      { title: "探索与定位", detail: "搜索相关代码" },
      { title: "实施改动", detail: quest.goal },
      { title: "验证", detail: "确认结果" },
    ];
  }

  async _runAgentExecute(
    cfg,
    questId,
    workspaceRoot,
    rulesText,
    plan,
    signal,
    events,
    bridges
  ) {
    const quest = this.store.get(questId);
    const step = this.store.appendStep(questId, {
      title: "Agent 执行",
      status: "running",
      startedAt: Date.now(),
      expert: "agent",
    });
    events.onEvent?.({ type: "step", questId, step });

    const planText = plan.map((p, i) => `${i + 1}. ${p.title}: ${p.detail}`).join("\n");
    const userGoal = [
      `【Quest 目标】\n${quest.goal}`,
      `【执行计划】\n${planText}`,
      "请按计划使用工具完成任务。完成后简要总结改了什么。",
    ].join("\n\n");

    await this._toolLoop(
      cfg,
      questId,
      workspaceRoot,
      rulesText,
      userGoal,
      "agent",
      signal,
      events,
      bridges,
      { progressFrom: 25, progressTo: 90 }
    );

    this.store.updateStep(questId, step.id, {
      status: "done",
      finishedAt: Date.now(),
    });
    this.store.update(questId, { progress: 95 });
    events.onEvent?.({ type: "status", questId, status: "running", progress: 95 });
  }

  async _runExperts(
    cfg,
    questId,
    workspaceRoot,
    rulesText,
    plan,
    signal,
    events,
    bridges
  ) {
    const experts = [
      {
        id: "architect",
        title: "架构师分析",
        hint: "分析代码结构与方案，指出要改的文件，不要大规模写代码。",
      },
      {
        id: "implementer",
        title: "实现者编码",
        hint: "根据计划与分析，实际修改代码文件。",
      },
      {
        id: "reviewer",
        title: "审查者检查",
        hint: "检查改动是否完成目标，不足则用工具修补。",
      },
    ];

    const quest = this.store.get(questId);
    const planText = plan.map((p, i) => `${i + 1}. ${p.title}: ${p.detail}`).join("\n");
    let n = 0;
    for (const ex of experts) {
      if (signal.aborted) throw new Error("aborted");
      n++;
      const step = this.store.appendStep(questId, {
        title: ex.title,
        status: "running",
        startedAt: Date.now(),
        expert: ex.id,
      });
      events.onEvent?.({ type: "step", questId, step });
      this.store.appendMessage(questId, {
        role: "system",
        content: `—— Experts · ${ex.title} ——`,
        expert: ex.id,
      });

      const userGoal = [
        `【Quest 目标】\n${quest.goal}`,
        `【计划】\n${planText}`,
        `【你的角色】${ex.title}`,
        ex.hint,
        "使用工具完成你的职责，最后用中文简短汇报。",
      ].join("\n\n");

      const from = 20 + ((n - 1) / experts.length) * 70;
      const to = 20 + (n / experts.length) * 70;
      await this._toolLoop(
        cfg,
        questId,
        workspaceRoot,
        rulesText,
        userGoal,
        ex.id,
        signal,
        events,
        bridges,
        { progressFrom: from, progressTo: to }
      );

      this.store.updateStep(questId, step.id, {
        status: "done",
        finishedAt: Date.now(),
      });
    }
    this.store.update(questId, { progress: 95 });
  }

  async _toolLoop(
    cfg,
    questId,
    workspaceRoot,
    rulesText,
    userText,
    expert,
    signal,
    events,
    bridges,
    progressRange
  ) {
    const quest = this.store.get(questId);
    const provider = resolveQuestProvider(cfg, quest);
    const model = resolveQuestModel(cfg, quest, provider);
    if (!provider || !model) {
      throw new Error(
        "Quest 未配置可用模型。请添加自定义第三方服务商并选择模型。"
      );
    }
    if (quest && (!quest.model || !quest.providerId)) {
      this.store.update(questId, { model, providerId: provider.id });
      quest.model = model;
      quest.providerId = provider.id;
    }
    const runCtx = this._runCtx?.get(questId) || {};
    const skillsText = runCtx.skillsText || "";
    const system = buildQuestSystem(
      cfg,
      workspaceRoot,
      rulesText,
      expert,
      provider,
      model,
      skillsText,
      runCtx.memoryText || ""
    );

    const messages = [
      { role: "system", content: system },
      { role: "user", content: userText },
    ];

    this.store.appendMessage(questId, {
      role: "user",
      content: userText.slice(0, 2000),
      expert,
    });

    const toolCtx = {
      cfg,
      workspaceRoot,
      signal, // 供 executeTool 长任务响应 stop 中止
      openTabs: [],
      activeFile: "",
      activeSelection: "",
      confirm: bridges.confirm || (async () => true),
      ptyBridge: bridges.ptyBridge || null,
      skillCatalog: runCtx.skillCatalog || null,
      mcpManager: this.mcpManager || null,
      onFsChange: async (filePath, kind) => {
        await this._captureChange(questId, workspaceRoot, filePath, kind);
        events.onEvent?.({
          type: "file_change",
          questId,
          path: filePath,
          kind,
        });
      },
    };

    const maxRounds = (() => {
      const n = Number(cfg?.agentMaxRounds);
      if (!Number.isFinite(n) || n <= 0) return Number.POSITIVE_INFINITY;
      if (n >= 4) return Math.floor(n);
      return Number.POSITIVE_INFINITY;
    })();
    const maxAutoContinue = (() => {
      if (cfg?.agentAutoContinue === false || cfg?.agentAutoContinue === 0)
        return 0;
      const n = Number(cfg?.agentAutoContinue);
      if (!Number.isFinite(n) || n < 0) return Number.POSITIVE_INFINITY;
      return Math.floor(n);
    })();
    let assistantAcc = "";
    let autoContinues = 0;
    let lastText = "";
    let usedTools = false;

    while (!signal.aborted) {
    let hitRoundCap = Number.isFinite(maxRounds);
    const roundLimit = Number.isFinite(maxRounds) ? maxRounds : Number.MAX_SAFE_INTEGER;
    for (let round = 0; round < roundLimit; round++) {
      if (signal.aborted) throw new Error("aborted");

      const toolCalls = new Map();
      assistantAcc = "";
      events.onEvent?.({
        type: "status",
        questId,
        status: "running",
        progress: lerp(
          progressRange.progressFrom,
          progressRange.progressTo,
          Number.isFinite(maxRounds) ? (round + 0.3) / maxRounds : 0.5
        ),
      });

      for await (const chunk of streamChat(cfg, {
        provider,
        model,
        messages,
        tools:
          AGENT_TOOLS.concat(
            this.mcpManager?.getTools ? this.mcpManager.getTools() : []
          ),
        signal,
        temperature: cfg.temperature ?? 0.2,
        maxTokens: cfg.maxTokens ?? 8192,
      })) {
        if (chunk.type === "text" && chunk.text) {
          assistantAcc += chunk.text;
          events.onEvent?.({
            type: "delta",
            questId,
            text: chunk.text,
            expert,
          });
        } else if (chunk.type === "tool_call" && chunk.toolCall) {
          const idx = chunk.toolCall.index ?? 0;
          const prev = toolCalls.get(idx);
          toolCalls.set(idx, {
            id: chunk.toolCall.id || prev?.id || `call_${idx}`,
            type: "function",
            function: {
              name:
                chunk.toolCall.function?.name || prev?.function.name || "",
              arguments:
                chunk.toolCall.function?.arguments ??
                prev?.function.arguments ??
                "",
            },
          });
        } else if (chunk.type === "error") {
          throw new Error(chunk.error || "stream error");
        }
      }

      const calls = [...toolCalls.values()].filter((c) => c.function.name);
      lastText = assistantAcc || "";
      if (assistantAcc) {
        this.store.appendMessage(questId, {
          role: "assistant",
          content: assistantAcc,
          expert,
        });
        events.onEvent?.({ type: "message", questId });
      }

      if (!calls.length) {
        hitRoundCap = false;
        break;
      }

      usedTools = true;
      messages.push({
        role: "assistant",
        content: assistantAcc,
        tool_calls: calls,
      });

      for (const call of calls) {
        if (signal.aborted) throw new Error("aborted");
        events.onEvent?.({
          type: "tool_start",
          questId,
          name: call.function.name,
          args: call.function.arguments,
          expert,
        });
        // Snapshot before write/edit
        if (
          call.function.name === "write_file" ||
          call.function.name === "edit_file" ||
          call.function.name === "apply_diff"
        ) {
          try {
            const p = parseMutatingPath(call.function.arguments);
            if (p) {
              await this._snapshotBefore(questId, workspaceRoot, p);
            }
          } catch {
            /* ignore */
          }
        }

        let result;
        if (
          String(call.function.name || "").startsWith("mcp__") &&
          toolCtx.mcpManager
        ) {
          result = await toolCtx.mcpManager.callTool(
            call.function.name,
            call.function.arguments
          );
        } else {
          result = await executeTool(
            toolCtx,
            call.function.name,
            call.function.arguments
          );
        }
        const content = String(result.content || "").slice(0, 50_000);

        // 停止后到达这里：工具可能已跑完但任务已取消——不再记录变更/追加消息
        if (signal.aborted) throw new Error("aborted");

        if (
          call.function.name === "write_file" ||
          call.function.name === "edit_file" ||
          call.function.name === "apply_diff"
        ) {
          try {
            const p = parseMutatingPath(call.function.arguments);
            if (p) {
              await this._captureChange(
                questId,
                workspaceRoot,
                resolveUnder(workspaceRoot, p),
                call.function.name === "edit_file" ? "edit" : "write"
              );
            }
          } catch {
            /* ignore */
          }
        }

        events.onEvent?.({
          type: "tool_end",
          questId,
          name: call.function.name,
          result: content.slice(0, 2000),
          expert,
        });
        this.store.appendMessage(questId, {
          role: "tool",
          content: content.slice(0, 8000),
          expert,
        });
        messages.push({
          role: "tool",
          content,
          name: call.function.name,
          tool_call_id: call.id,
        });
      }
    }

    const wantContinue =
      autoContinues < maxAutoContinue &&
      (hitRoundCap ||
        (usedTools && looksLikeNeedsContinue(lastText)));
    if (!wantContinue) break;

    autoContinues += 1;
    const cont =
      "请继续完成尚未完成的工作。不要停下来等用户；直接调用工具执行剩余步骤直到完成。";
    this.store.appendMessage(questId, { role: "user", content: cont });
    messages.push({ role: "user", content: cont });
    events.onEvent?.({
      type: "status",
      questId,
      status: "running",
      detail: `自动继续 ${autoContinues}/${maxAutoContinue}`,
    });
    } // while auto-continue
  }

  async _snapshotBefore(questId, workspaceRoot, relPath) {
    const abs = resolveUnder(workspaceRoot, relPath);
    let before = null;
    try {
      before = await fs.readFile(abs, "utf8");
    } catch {
      before = null;
    }
    this.store.recordFileChange(questId, {
      path: abs,
      relative: workspaceRoot
        ? path.relative(workspaceRoot, abs)
        : abs,
      kind: before == null ? "create" : "edit",
      before,
    });
  }

  async _captureChange(questId, workspaceRoot, absOrRel, kind) {
    const abs = path.isAbsolute(absOrRel)
      ? absOrRel
      : resolveUnder(workspaceRoot, absOrRel);
    let after = null;
    try {
      after = await fs.readFile(abs, "utf8");
    } catch {
      after = null;
    }
    const q = this.store.get(questId);
    const existing = q?.fileChanges?.find((f) => f.path === abs);
    this.store.recordFileChange(questId, {
      path: abs,
      relative: workspaceRoot
        ? path.relative(workspaceRoot, abs)
        : abs,
      kind: kind || existing?.kind || "edit",
      before: existing?.before ?? null,
      after,
    });
  }

async applyReject(questId, filePath) {
    const q = this.store.get(questId);
    if (!q) throw new Error("Quest 不存在");
    const row = q.fileChanges.find((f) => f.path === filePath);
    if (!row) throw new Error("未找到变更");

    const result = await rollbackFileRow(row);
    if (result.ok && !result.already) {
      this.store.rejectChange(questId, filePath);
    }
    return result;
  }

  async markCompleted(questId) {
    return this.store.update(questId, {
      status: "completed",
      progress: 100,
      finishedAt: Date.now(),
    });
  }
}

function buildQuestSystem(
  cfg,
  workspaceRoot,
  rulesText,
  expert,
  provider,
  model,
  skillsText = "",
  memoryText = ""
) {
  const p = provider || getActiveProvider(cfg);
  const m = model || getActiveModel(cfg);
  const expertHint =
    expert === "architect"
      ? "你是架构师：多读少写，给出方案与文件清单。"
      : expert === "implementer"
        ? "你是实现者：用工具实际改代码。"
        : expert === "reviewer"
          ? "你是审查者：查缺补漏，必要时修补。"
          : "你是 Quest Agent：自主完成目标。";

  // rulesText already starts with FOP priority rules (highest load priority)
  return [
    rulesText || "",
    "你是 EMSoder Quest 执行引擎。用户自带模型。先探索再改动，改完等人审。",
    expertHint,
    "规则：先探索再改动；edit_file / apply_diff 精确替换；不要编造文件内容。",
    "匹配已安装 Skill 时先 load_skill 再按技能说明执行（本机 zcode/agents 技能）。",
    memoryText ? `相关长期记忆（按目标检索）：\n${memoryText}` : "",
    skillsText || "",
    `服务商: ${p?.name || "none"} (${p?.type || "?"}) · 模型: ${m || "none"}`,
    `Base URL: ${p?.baseUrl || "n/a"}`,
    `工作区: ${workspaceRoot || "(未绑定)"}`,
    cfg.systemPrompt || "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function extractJsonArray(text) {
  if (!text) return null;
  let t = String(text).trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\n?/, "").replace(/```$/, "").trim();
  }
  try {
    const j = JSON.parse(t);
    return Array.isArray(j) ? j : null;
  } catch {
    const m = t.match(/\[[\s\S]*\]/);
    if (!m) return null;
    try {
      const j = JSON.parse(m[0]);
      return Array.isArray(j) ? j : null;
    } catch {
      return null;
    }
  }
}

function lerp(a, b, t) {
  const x = Math.min(1, Math.max(0, t));
  return Math.round(a + (b - a) * x);
}

module.exports = { QuestRunner };
