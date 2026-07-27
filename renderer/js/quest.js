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
          <div class="meta">
            <span class="quest-badge ${q.status}">${STATUS_LABEL[q.status] || q.status}</span>
            <span>${q.mode === "experts" ? "Experts" : "Agent"}</span>
            <span>${q.progress || 0}%</span>
            <span>${q.changeCount || 0} 文件</span>
          </div>`;
        card.querySelector(".t").textContent = q.title || "未命名";
        card.querySelector(".g").textContent = q.goal || "";
        card.onclick = () => selectQuest(q.id);
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
  }

  function setShellMode(mode) {
    const app = $("app");
    const main = $("mainLayout");
    if (!app || !main) return;
    if (mode === "quest") {
      app.classList.add("quest-shell");
      main.classList.add("quest-mode");
      main.classList.remove("chat-collapsed");
      document
        .querySelectorAll(".mode-switch button")
        .forEach((b) =>
          b.classList.toggle("active", b.dataset.mode === "quest")
        );
      document
        .querySelectorAll(".act-btn[data-view]")
        .forEach((b) => b.classList.remove("active"));
      document
        .querySelector('.act-btn[data-view="quest"]')
        ?.classList.add("active");
    } else {
      app.classList.remove("quest-shell");
      main.classList.remove("quest-mode");
      document
        .querySelectorAll(".mode-switch button")
        .forEach((b) =>
          b.classList.toggle("active", b.dataset.mode === "ide")
        );
      // IDE：活动栏高亮「会话」（置顶入口）
      document
        .querySelectorAll(".act-btn[data-view]")
        .forEach((b) => b.classList.remove("active"));
      document
        .querySelector('.act-btn[data-view="sessions"]')
        ?.classList.add("active");
      // IDE: keep right editor preference (default hidden)
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
    }
    try {
      localStorage.setItem("emsoder.uiMode", mode);
    } catch {
      /* ignore */
    }
    setTimeout(() => window.EmsoderEditor?.layout?.(), 80);
  }

  function enterQuestMode(on) {
    if (on) {
      setShellMode("quest");
      renderSidePanel();
    } else {
      setShellMode("ide");
    }
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
        if (!confirm("回滚该文件到任务开始前的内容？")) return;
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
    enterQuestMode(true);
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
        state.liveDelta += ev.text;
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
        if (state.activeId) {
          state.quest = await emsoder.questGet(state.activeId);
          renderConsole();
        }
        await refreshBoard();
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
      }
    });

    emsoder.onMenu("showQuest", () => openQuestView());
  }

  function openQuestView() {
    enterQuestMode(true);
    renderSidePanel();
    if (state.activeId) {
      emsoder.questGet(state.activeId).then((q) => {
        state.quest = q;
        renderConsole();
      });
    } else {
      renderConsole();
    }
  }

  function bootDefault() {
    // 打开 EMSoder 时默认始终进入 IDE（可手动再切 Quest）
    try {
      localStorage.setItem("emsoder.uiMode", "ide");
    } catch {
      /* ignore */
    }
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
