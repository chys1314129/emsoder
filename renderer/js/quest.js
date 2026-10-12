/* global emsoder, EmsoderDom */
(function () {
  const state = {
    board: null,
    activeId: null,
    quest: null,
    running: false,
    liveDelta: "",
    rightTab: "plan",
  };

  const STATUS_LABEL = {
    draft: "草稿",
    running: "运行中",
    action_required: "待操作",
    ready: "待审阅",
    error: "错误",
    completed: "已完成",
    cancelled: "已取消",
  };

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function $(id) {
    return document.getElementById(id);
  }

  function toast(msg, err) {
    window.EmsoderApp?.toast?.(msg, err);
  }

  function isQuestShell() {
    return document.getElementById("app")?.classList.contains("quest-shell");
  }

  async function refreshBoard() {
    state.board = await emsoder.questBoard();
    renderBoard();
    const list = await emsoder.questList();
    const running = list.some((q) => q.status === "running");
    const dot = document.querySelector("#actQuest .quest-dot");
    if (dot) dot.classList.toggle("on", running);
    const sb = $("sbQuest");
    if (sb) {
      const active = list.find((q) => q.id === state.activeId);
      sb.textContent = active
        ? `${STATUS_LABEL[active.status] || active.status} · ${active.progress || 0}%`
        : running
          ? "Quest 运行中"
          : "Quest";
    }
  }

  function renderBoard() {
    const el = $("questBoard");
    if (!el || !state.board) return;
    const order = [
      "running",
      "action_required",
      "ready",
      "error",
      "draft",
      "completed",
      "cancelled",
    ];
    const labels = {
      running: "运行中",
      action_required: "待操作",
      ready: "待审阅",
      error: "错误",
      draft: "草稿",
      completed: "已完成",
      cancelled: "已取消",
    };
    el.innerHTML = "";
    for (const key of order) {
      const items = state.board[key] || [];
      if (
        !items.length &&
        key !== "running" &&
        key !== "ready" &&
        key !== "draft"
      ) {
        continue;
      }
      const col = document.createElement("div");
      col.innerHTML = `<div class="quest-col-title"><span>${labels[key]}</span><span class="n">${items.length}</span></div>`;
      for (const q of items) {
      const card = document.createElement("div");
      card.className =
        "quest-card" + (q.id === state.activeId ? " active" : "");
      card.innerHTML = `
          <div class="t"></div>
          <div class="g"></div>
          <div class="r"></div>
          <div class="meta">
            <span class="quest-badge ${q.status}">${escapeHtml(STATUS_LABEL[q.status] || q.status)}</span>
            <span>${q.mode === "experts" ? "Experts" : "Agent"}</span>
            <span>${q.progress || 0}%</span>
            <span>${q.changeCount || 0} 文件</span>
          </div>
          <div class="card-actions"></div>`;
      card.querySelector(".t").textContent = q.title || "未命名";
      card.querySelector(".g").textContent = q.goal || "";
      const remarkEl = card.querySelector(".r");
      if (q.remark) {
        remarkEl.textContent = "备注: " + q.remark;
        remarkEl.title = q.remark;
      }
      card.onclick = () => selectQuest(q.id);
      // 错误状态可重试；hover 删除
      const actions = card.querySelector(".card-actions");
      if (q.status === "error") {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "btn tb-mini primary";
        retry.textContent = "重试";
        retry.onclick = async (e) => {
          e.stopPropagation();
          try {
            await emsoder.questStart(q.id);
            toast("已重新启动 " + (q.title || "任务"));
          } catch (err) {
            toast(err.message || err, true);
          }
          await refreshBoard();
        };
        actions.appendChild(retry);
      }
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn tb-mini danger";
      del.textContent = "删除";
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!(await EmsoderDom.showConfirm("删除 Quest「" + (q.title || "未命名") + "」？"))) return;
        try {
          await emsoder.questRemove(q.id);
          if (state.activeId === q.id) {
            state.activeId = null;
            state.quest = null;
            renderConsole();
          }
        } catch (err) {
          toast(err.message || err, true);
        }
        await refreshBoard();
      };
      actions.appendChild(del);
      col.appendChild(card);

      }
      if (!items.length) {
        const empty = document.createElement("div");
        empty.style.cssText =
          "color:var(--text-muted);font-size:11px;padding:4px;";
        empty.textContent = "无任务";
        col.appendChild(empty);
      }
      el.appendChild(col);
    }
  }

  async function selectQuest(id) {
    state.activeId = id;
    await emsoder.questSetActive(id);
    state.quest = await emsoder.questGet(id);
    state.liveDelta = "";
    renderBoard();
    renderConsole();
    enterQuestMode(true);
    // 载入备注到补充输入框
    const fi = $("questFollowInput");
    if (fi && state.quest) fi.value = state.quest.remark || "";
  }

  /** 事件驱动的全量刷新：200ms trailing 合并密集事件 */
  let _questRefreshTimer = null;
  let _questRefreshRunning = false;
  function scheduleQuestRefresh() {
    if (_questRefreshTimer) return;
    _questRefreshTimer = setTimeout(async () => {
      _questRefreshTimer = null;
      if (_questRefreshRunning) return;
      _questRefreshRunning = true;
      try {
        if (state.activeId) {
          state.quest = await emsoder.questGet(state.activeId);
          renderConsole();
        }
        await refreshBoard();
      } catch {
        /* ignore */
      } finally {
        _questRefreshRunning = false;
      }
    }, 200);
  }

  async function saveRemark() {
    if (!state.activeId) {
      toast("请先选择任务", true);
      return;
    }
    const v = ($("questFollowInput")?.value || "").trim();
    try {
      const r = await emsoder.questUpdate(state.activeId, { remark: v });
      if (r) {
        state.quest = r;
        toast(v ? "备注已保存" : "备注已清空");
        await refreshBoard();
      }
    } catch (e) {
      toast(e.message || e, true);
    }
  }

  function setShellMode(mode) {
    // Quest 壳已下线。任何 mode 都落回 IDE，永不加 quest-shell。
    void mode;
    const app = $("app");
    const main = $("mainLayout");
    if (!app || !main) return;
    app.classList.remove("quest-shell");
    main.classList.remove("quest-mode");
    try {
      localStorage.setItem("emsoder.uiMode", "ide");
    } catch {
      /* ignore */
    }
    try {
      const pref = localStorage.getItem("emsoder.ideEditorVisible");
      main.classList.toggle("editor-collapsed", pref !== "1");
    } catch {
      main.classList.add("editor-collapsed");
    }
    try {
      window.EmsoderApp?.syncEditorToggleUI?.();
    } catch {
      /* ignore */
    }
    setTimeout(() => window.EmsoderEditor?.layout?.(), 80);
  }

  function enterQuestMode(on) {
    void on;
    setShellMode("ide");
  }

  function setRightTab(name) {
    state.rightTab = name;
    document.querySelectorAll(".quest-right-tabs button").forEach((b) => {
      b.classList.toggle("active", b.dataset.rtab === name);
    });
    document.querySelectorAll(".quest-right-pane").forEach((p) => {
      p.classList.toggle("active", p.dataset.rpane === name);
    });
  }

  function fillSteps(container, q) {
    if (!container) return;
    container.innerHTML = '<div class="quest-section-h">计划与步骤</div>';
    const plan = q.plan || [];
    if (plan.length) {
      const p = document.createElement("div");
      p.className = "quest-step done";
      p.innerHTML = `<div class="st">总计划</div><div class="sd"></div>`;
      p.querySelector(".sd").textContent = plan
        .map((x, i) => `${i + 1}. ${x.title}${x.detail ? " — " + x.detail : ""}`)
        .join("\n");
      container.appendChild(p);
    }
    for (const s of q.steps || []) {
      const d = document.createElement("div");
      d.className = "quest-step " + (s.status || "");
      d.innerHTML = `<div class="st"></div><div class="sd"></div>`;
      d.querySelector(".st").textContent =
        (s.expert ? `[${s.expert}] ` : "") + s.title + ` · ${s.status}`;
      d.querySelector(".sd").textContent = s.detail || "";
      container.appendChild(d);
    }
    if (!plan.length && !(q.steps || []).length) {
      const e = document.createElement("div");
      e.style.cssText = "color:var(--text-muted);font-size:12px;padding:8px;";
      e.textContent = "启动后将自动生成计划与步骤";
      container.appendChild(e);
    }
  }

  function fillChanges(container, q) {
    if (!container) return;
    container.innerHTML = '<div class="quest-section-h">Changes 审阅</div>';
    const files = q.fileChanges || [];
    if (!files.length) {
      const e = document.createElement("div");
      e.style.cssText = "color:var(--text-muted);font-size:12px;padding:8px;";
      e.textContent = "暂无文件变更。任务改文件后会显示在这里。";
      container.appendChild(e);
      return;
    }
    for (const f of files) {
      const row = document.createElement("div");
      row.className = "quest-change-row" + (f.rejected ? " rejected" : "");
      row.innerHTML = `
        <span class="quest-badge">${f.kind || "edit"}</span>
        <span class="path" title=""></span>
        <button class="tb-mini" data-a="open">打开</button>
        <button class="tb-mini" data-a="reject" ${f.rejected ? "disabled" : ""}>回滚</button>`;
      const pathEl = row.querySelector(".path");
      pathEl.textContent = f.relative || f.path;
      pathEl.title = f.path;
      const open = () => {
        // switch to IDE briefly to show file, or navigate in place
        window.EmsoderLsp?.onNavigate?.(f.path, 1, 1);
      };
      pathEl.onclick = open;
      row.querySelector('[data-a="open"]').onclick = open;
      row.querySelector('[data-a="reject"]').onclick = async () => {
        if (!(await EmsoderDom.showConfirm("回滚该文件到任务开始前的内容？"))) return;
        try {
          await emsoder.questRejectChange(q.id, f.path);
          state.quest = await emsoder.questGet(q.id);
          renderConsole();
          toast("已回滚");
        } catch (err) {
          toast(err.message || err, true);
        }
      };
      container.appendChild(row);
    }
  }

  function renderConsole() {
    const empty = $("questEmpty");
    const body = $("questBody");
    const q = state.quest;
    if (!q) {
      if (empty) empty.classList.remove("hidden");
      if (body) body.classList.add("hidden");
      fillSteps($("questRightSteps"), { plan: [], steps: [] });
      fillChanges($("questRightChanges"), { fileChanges: [] });
      return;
    }
    if (empty) empty.classList.add("hidden");
    if (body) body.classList.remove("hidden");

    if ($("questTitle")) $("questTitle").textContent = q.title || "Quest";
    if ($("questStatus")) {
      $("questStatus").textContent = STATUS_LABEL[q.status] || q.status;
      $("questStatus").className = "quest-badge " + (q.status || "");
    }
    if ($("questMeta")) {
      const modelLabel = q.model
        ? q.providerId
          ? `${q.model} @ ${q.providerId}`
          : q.model
        : "未绑定模型";
      $("questMeta").textContent = `${q.mode === "experts" ? "Experts" : "Agent"} · ${modelLabel} · ${q.progress || 0}%`;
    }
    if ($("questGoal")) $("questGoal").textContent = q.goal || "";
    const bar = $("questProgressBar");
    if (bar) bar.style.width = `${q.progress || 0}%`;

    // center log only (quest shell); also fill hidden steps for non-shell
    const stepsEl = $("questSteps");
    if (stepsEl) fillSteps(stepsEl, q);
    fillSteps($("questRightSteps"), q);
    fillChanges($("questChanges"), q);
    fillChanges($("questRightChanges"), q);

    const log = $("questLog");
    if (log) {
      log.innerHTML = isQuestShell()
        ? ""
        : '<div class="quest-section-h">执行日志</div>';
      for (const m of q.messages || []) {
        if (m.role === "user" && (m.content || "").length > 800) continue;
        const line = document.createElement("div");
        line.className =
          "line " +
          (m.role === "tool"
            ? "tool"
            : m.role === "assistant"
              ? "assistant"
              : "");
        const prefix =
          m.expert && m.role === "assistant" ? `【${m.expert}】 ` : "";
        line.textContent = prefix + (m.content || "").slice(0, 6000);
        log.appendChild(line);
      }
      if (state.liveDelta) {
        const line = document.createElement("div");
        line.className = "line delta";
        line.textContent = state.liveDelta.slice(-3000);
        log.appendChild(line);
      }
      log.scrollTop = log.scrollHeight;
    }

    const running = q.status === "running";
    if ($("btnQuestStart")) $("btnQuestStart").disabled = running || !q.goal;
    if ($("btnQuestStop")) $("btnQuestStop").disabled = !running;
    if ($("btnQuestDone")) {
      $("btnQuestDone").disabled = !(
        q.status === "ready" || q.status === "error"
      );
    }
  }

  function parseModelSelectValue(raw) {
    const s = String(raw || "");
    const i = s.indexOf("::");
    if (i < 0) return { providerId: "", model: s };
    return { providerId: s.slice(0, i), model: s.slice(i + 2) };
  }

  async function fillQuestModelSelect() {
    const sel = $("questModelSelect");
    if (!sel) return;
    const list = await emsoder.listProviders();
    const cfg = await emsoder.getConfig();
    const activeProviderId = cfg?.activeProviderId || "";
    const activeModel = cfg?.activeModel || "";
    sel.innerHTML = "";
    let count = 0;
    let preferred = "";
    for (const p of list.filter((x) => x.enabled !== false)) {
      for (const m of p.models || []) {
        count++;
        const val = `${p.id}::${m}`;
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = `${m} · ${p.name}`;
        if (p.id === activeProviderId && m === activeModel) preferred = val;
        if (!preferred && p.id === activeProviderId) preferred = val;
        sel.appendChild(opt);
      }
    }
    if (!count) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "请先添加服务商/模型";
      sel.appendChild(opt);
    } else if (preferred) {
      sel.value = preferred;
    }
  }

  async function createAndMaybeStart(startNow) {
    const goal = $("questGoalInput")?.value?.trim();
    if (!goal) {
      toast("请填写 Quest 目标", true);
      return;
    }
    const mode = $("questModeSelect")?.value || "agent";
    const picked = parseModelSelectValue($("questModelSelect")?.value);
    if (!picked.model) {
      toast("请先配置第三方模型：顶栏「服务商」→ 添加 Ollama / DeepSeek / 自定义网关", true);
      return;
    }
    const q = await emsoder.questCreate({
      goal,
      mode,
      workspace: (await emsoder.getWorkspace()) || "",
      model: picked.model,
      providerId: picked.providerId,
    });
    if ($("questGoalInput")) $("questGoalInput").value = "";
    state.activeId = q.id;
    state.quest = q;
    await refreshBoard();
    renderConsole();
    toast("Quest 壳已下线，用 Chat 说话改文件");
    if (startNow) await startActive();
  }

  async function startActive() {
    if (!state.activeId) {
      toast("请先创建或选择 Quest", true);
      return;
    }
    try {
      await window.EmsoderPanels?.ensureTerm?.();
    } catch {
      /* ignore */
    }
    state.liveDelta = "";
    state.running = true;
    await emsoder.questStart(state.activeId);
    toast("Quest 已启动");
    setRightTab("plan");
    renderConsole();
  }

  async function stopActive() {
    if (!state.activeId) return;
    await emsoder.questStop(state.activeId);
    state.running = false;
    state.quest = await emsoder.questGet(state.activeId);
    await refreshBoard();
    renderConsole();
    toast("已停止");
  }

  async function markDone() {
    if (!state.activeId) return;
    await emsoder.questComplete(state.activeId);
    state.quest = await emsoder.questGet(state.activeId);
    await refreshBoard();
    renderConsole();
    toast("已标记完成");
  }

  function renderSidePanel() {
    const title = $("sideTitle");
    if (title) title.textContent = "My Quests";
    const body = $("sideBody");
    if (!body) return;
    body.innerHTML = `
      <div class="quest-new">
        <textarea id="questGoalInput" placeholder="描述目标，例如：给登录页加上表单校验并写单元测试…"></textarea>
        <div class="quest-new-row">
          <select id="questModeSelect" title="执行模式">
            <option value="agent">Agent 单智能体</option>
            <option value="experts">Experts 多智能体</option>
          </select>
        </div>
        <div class="quest-new-row">
          <select id="questModelSelect" title="自定义第三方模型（BYOK）" style="flex:1"></select>
          <button class="btn" id="btnQuestModels" title="管理服务商">⚙</button>
        </div>
        <div class="quest-new-hint">模型来自顶栏「服务商」：Ollama / DeepSeek / OpenAI 兼容 / Anthropic / 自建网关</div>
        <div class="quest-new-row">
          <button class="btn" id="btnQuestCreate" style="flex:1">创建</button>
          <button class="btn primary" id="btnQuestCreateRun" style="flex:1">创建并运行</button>
        </div>
      </div>
      <div class="quest-board" id="questBoard"></div>`;
    $("btnQuestCreate").onclick = () => createAndMaybeStart(false);
    $("btnQuestCreateRun").onclick = () => createAndMaybeStart(true);
    $("btnQuestModels")?.addEventListener("click", () => {
      if (typeof window.EmsoderApp?.showProviders === "function") {
        window.EmsoderApp.showProviders();
      } else {
        $("btnProviders")?.click();
      }
    });
    fillQuestModelSelect();
    refreshBoard();
  }

  function init() {
    $("btnQuestStart")?.addEventListener("click", startActive);
    $("btnQuestStop")?.addEventListener("click", stopActive);
    $("btnQuestDone")?.addEventListener("click", markDone);
    $("btnQuestRemarkSave")?.addEventListener("click", saveRemark);
    $("btnQuestRefresh")?.addEventListener("click", async () => {
      if (state.activeId) {
        state.quest = await emsoder.questGet(state.activeId);
      }
      await refreshBoard();
      renderConsole();
    });
    $("btnQuestClosePanel")?.addEventListener("click", () => {
      enterQuestMode(false);
      document.querySelector('.act-btn[data-view="explorer"]')?.click();
    });

    document.querySelectorAll(".quest-right-tabs button").forEach((btn) => {
      btn.addEventListener("click", () => setRightTab(btn.dataset.rtab));
    });

    document.querySelectorAll(".mode-switch button").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.mode === "quest") openQuestView();
        else {
          enterQuestMode(false);
          document.querySelector('.act-btn[data-view="explorer"]')?.click();
        }
      });
    });

    $("btnQuestOpenFolder")?.addEventListener("click", () => {
      $("btnOpenFolder")?.click();
    });
    $("btnQuestOpenTerm")?.addEventListener("click", () => {
      $("bottomPanel")?.classList.remove("collapsed");
      window.EmsoderPanels?.showTab?.("terminal");
    });
    $("btnQuestOpenGit")?.addEventListener("click", () => {
      $("bottomPanel")?.classList.remove("collapsed");
      window.EmsoderPanels?.showTab?.("git");
    });
    $("btnQuestToIde")?.addEventListener("click", () => {
      enterQuestMode(false);
      document.querySelector('.act-btn[data-view="explorer"]')?.click();
    });

    emsoder.onQuestEvent(async (ev) => {
      if (!ev) return;
      if (ev.questId && state.activeId && ev.questId !== state.activeId) {
        if (ev.type === "status" || ev.type === "done") refreshBoard();
        return;
      }
      if (ev.type === "delta" && ev.text) {
        // 截断累积缓冲：长任务输出不会无限占内存（显示只用末尾 3000 字符）
        state.liveDelta = (state.liveDelta + ev.text).slice(-10000);
        // rAF throttle — Quest stream can be very chatty
        if (!state._deltaRaf) {
          state._deltaRaf = requestAnimationFrame(() => {
            state._deltaRaf = 0;
            const log = $("questLog");
            if (!log) return;
            let last = log.querySelector(".line.delta");
            if (!last) {
              last = document.createElement("div");
              last.className = "line delta";
              log.appendChild(last);
            }
            last.textContent = state.liveDelta.slice(-3000);
            log.scrollTop = log.scrollHeight;
          });
        }
      } else if (ev.type === "tool_start") {
        state.liveDelta = "";
        const log = $("questLog");
        if (log) {
          const line = document.createElement("div");
          line.className = "line tool";
          line.textContent = `→ ${ev.name}`;
          log.appendChild(line);
          log.scrollTop = log.scrollHeight;
        }
      } else if (ev.type === "tool_end") {
        const log = $("questLog");
        if (log) {
          const line = document.createElement("div");
          line.className = "line tool";
          line.textContent = `← ${ev.name}: ${String(ev.result || "").slice(0, 240)}`;
          log.appendChild(line);
          log.scrollTop = log.scrollHeight;
        }
      } else if (
        ev.type === "plan" ||
        ev.type === "step" ||
        ev.type === "message" ||
        ev.type === "file_change" ||
        ev.type === "status" ||
        ev.type === "done" ||
        ev.type === "error"
      ) {
        state.liveDelta = "";
        // 即时 UI 反馈（toast / tab 切换 / 运行标志）
        if (ev.type === "file_change") setRightTab("changes");
        if (ev.type === "plan" || ev.type === "step") setRightTab("plan");
        if (ev.type === "done") {
          state.running = false;
          if (ev.status === "ready") {
            toast("Quest 待审阅 — 请看右侧 Changes");
            setRightTab("changes");
          }
          if (ev.status === "error") toast(ev.error || "Quest 失败", true);
        }
        if (ev.type === "error") toast(ev.error || "错误", true);
        // 全量 refetch（questGet + renderConsole + refreshBoard）节流合并：
        // 密集事件（status/step 每轮多次）只做一次拉取
        scheduleQuestRefresh();
      }
    });

    emsoder.onMenu("showQuest", () => openQuestView());
  }

  function openQuestView() {
    setShellMode("ide");
  }

  function bootDefault() {
    setShellMode("ide");
  }

  window.EmsoderQuest = {
    init,
    open: openQuestView,
    renderSide: renderSidePanel,
    refreshBoard,
    refreshModelOptions: fillQuestModelSelect,
    bootDefault,
    setShellMode,
    enterQuestMode,
  };
})();
