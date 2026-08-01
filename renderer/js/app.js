/* global emsoder, EmsoderEditor, EmsoderPanels, EmsoderLsp, EmsoderQuest, EmsoderDom, EmsoderChatVirtual */
(() => {
  const state = {
    config: null,
    workspace: "",
    tabs: [],
    activePath: null,
    generating: false,
    /** 主进程 Chat 队列：排队条数 */
    queueDepth: 0,
    expandedDirs: new Set(),
    sideView: "sessions",
    streamingEl: null,
    streamingRaw: "",
    streamingRaf: 0,
    streamingScrollPending: false,
    reasoningEl: null,
    reasoningRaw: "",
    reasoningRaf: 0,
    activeToolRow: null,
    pendingConfirmId: null,
    monacoReady: false,
    attachments: [],
    /** @-mention state */
    mention: {
      visible: false,
      items: [],
      index: 0,
      triggerPos: 0,
      searchText: "",
      cache: null,
      ts: 0,
    },
    /** skills sidebar filter (preserved across re-render) */
    skillsFilter: {
      q: "",
      status: "all", // all | enabled | disabled
      source: "all", // all | zcode | agents | workspace | core | bundled | plugin
    },
    runStartedAt: 0,
    _runTick: 0,
    _runDetail: "",
    editMessageId: null,
    branchMeta: [],
    activeSessionId: null,
    /** 本轮 Agent 写盘摘要（无 before/after） */
    fileChanges: [],
    fileChangesSessionId: null,
  };

  function collapseProcessEnabled() {
    return state.config?.collapseProcess !== false;
  }

  /** @type {ReturnType<typeof EmsoderChatVirtual.createChatVirtualList> | null} */
  let chatVlist = null;

  function getChatMount() {
    if (chatVlist?.isActive?.()) {
      return chatVlist.getLiveRoot();
    }
    return messagesEl;
  }

  function scrollMessagesEnd() {
    if (chatVlist?.isActive?.()) {
      chatVlist.onLiveAppend?.();
      chatVlist.scrollToEnd?.();
      return;
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---------- Chat outline (目录) ----------
  function tocPreview(text, max = 42) {
    const t = String(text || "")
      .replace(/\s+/g, " ")
      .replace(/[#*`>\[\]]/g, "")
      .trim();
    if (!t) return "（空）";
    return t.length > max ? t.slice(0, max) + "…" : t;
  }

  /** 历史里无正文时 runner 会写「调用工具: xxx」占位，UI 一律隐藏 */
  function isToolCallPlaceholderText(text) {
    const t = String(text || "").trim();
    return /^调用工具\s*[:：]/.test(t);
  }

  function shouldHideFromChatUi(role, text) {
    if (role === "tool") return true;
    if (role === "assistant" && isToolCallPlaceholderText(text)) return true;
    return false;
  }

  function tocRoleLabel(role, toolName) {
    if (role === "user") return "你";
    if (role === "assistant") return "AI";
    if (role === "tool") return toolName ? `工具 · ${toolName}` : "工具";
    if (role === "reasoning") return "思考";
    if (role === "error") return "错误";
    return role || "消息";
  }

  function buildTocEntriesFromHistory(list) {
    const out = [];
    (list || []).forEach((m, i) => {
      if (!m) return;
      const role = m.role || "assistant";
      // 目录只列用户 / AI 主消息；工具、思考、「调用工具：…」占位不进目录
      if (role !== "user" && role !== "assistant" && role !== "error") return;
      if (shouldHideFromChatUi(role, m.content)) return;
      out.push({
        index: i,
        id: m.id || `hist-${i}`,
        role,
        label: tocRoleLabel(role, m.toolName),
        preview: tocPreview(m.content),
      });
    });
    return out;
  }

  function buildTocEntriesFromDom() {
    const nodes = messagesEl.querySelectorAll(".msg[data-role], .msg.user, .msg.assistant, .msg.error");
    const out = [];
    nodes.forEach((el, i) => {
      if (
        el.classList.contains("fold-msg") ||
        el.classList.contains("tool") ||
        el.classList.contains("tool-msg") ||
        el.classList.contains("reasoning-msg") ||
        el.classList.contains("hide-tool-call") ||
        el.hidden
      ) {
        return;
      }
      const role =
        el.dataset.role ||
        (el.classList.contains("user")
          ? "user"
          : el.classList.contains("assistant")
            ? "assistant"
            : el.classList.contains("error")
              ? "error"
              : "assistant");
      if (role !== "user" && role !== "assistant" && role !== "error") return;
      const raw = el.dataset.raw || el.querySelector(".body")?.textContent || "";
      if (shouldHideFromChatUi(role, raw)) return;
      const id = el.dataset.mid || el.dataset.tocId || `dom-${i}`;
      el.dataset.tocId = id;
      out.push({
        index: Number(el.dataset.tocIndex ?? i),
        id,
        role,
        label: tocRoleLabel(role),
        preview: tocPreview(raw),
        el,
      });
    });
    return out;
  }

  function refreshChatToc() {
    const listEl = $("chatTocList");
    const countEl = $("chatTocCount");
    if (!listEl) return;
    const hist = state._histList;
    let entries =
      Array.isArray(hist) && hist.length
        ? buildTocEntriesFromHistory(hist)
        : buildTocEntriesFromDom();
    // 流式进行中：历史之外还有 live 消息时，补 DOM 尾部 user/assistant
    if (Array.isArray(hist) && hist.length) {
      const liveExtras = buildTocEntriesFromDom().filter((e) => {
        if (!e.id) return true;
        return !hist.some((m) => m && m.id === e.id);
      });
      if (liveExtras.length) {
        entries = entries.concat(
          liveExtras.map((e, j) => ({
            ...e,
            index: hist.length + j,
          }))
        );
      }
    }
    if (countEl) countEl.textContent = String(entries.length);
    if (!entries.length) {
      listEl.innerHTML = '<div class="chat-toc-empty">暂无消息</div>';
      return;
    }
    listEl.innerHTML = "";
    for (const e of entries) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chat-toc-item " + (e.role || "");
      btn.dataset.tocId = e.id;
      btn.dataset.tocIndex = String(e.index);
      btn.innerHTML =
        `<span class="toc-role">${escapeHtml(e.label)}</span>` +
        `<span class="toc-preview">${escapeHtml(e.preview)}</span>`;
      btn.title = e.preview;
      btn.onclick = () => jumpToChatEntry(e);
      listEl.appendChild(btn);
    }
  }

  function jumpToChatEntry(entry) {
    if (!entry) return;
    // 虚拟列表：按历史索引跳转
    if (
      chatVlist?.isActive?.() &&
      Number.isFinite(Number(entry.index)) &&
      state._histList?.length
    ) {
      const ok = chatVlist.scrollToIndex?.(entry.index);
      if (ok) {
        highlightTocItem(entry.id);
        return;
      }
    }
    // DOM 直跳
    let el = entry.el || null;
    if (!el && entry.id) {
      el = [...messagesEl.querySelectorAll(".msg")].find(
        (n) => n.dataset.mid === entry.id || n.dataset.tocId === entry.id
      );
    }
    if (el) {
      el.scrollIntoView({ block: "start", behavior: "smooth" });
      el.classList.add("toc-flash");
      setTimeout(() => el.classList.remove("toc-flash"), 1200);
      highlightTocItem(entry.id);
    }
  }

  function highlightTocItem(id) {
    const listEl = $("chatTocList");
    if (!listEl) return;
    listEl.querySelectorAll(".chat-toc-item.active").forEach((n) => n.classList.remove("active"));
    const hit = [...listEl.querySelectorAll(".chat-toc-item")].find(
      (n) => n.dataset.tocId === id
    );
    if (hit) {
      hit.classList.add("active");
      hit.scrollIntoView({ block: "nearest" });
    }
  }

  function setChatTocVisible(on) {
    const toc = $("chatToc");
    const btn = $("btnToggleChatToc");
    const body = $("chatBody");
    if (!toc) return;
    toc.hidden = !on;
    if (body) body.classList.toggle("toc-hidden", !on);
    if (btn) {
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.classList.toggle("active", !!on);
    }
    try {
      localStorage.setItem("emsoder.chatToc", on ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  function cancelRaf(key) {
    if (state[key]) {
      cancelAnimationFrame(state[key]);
      state[key] = 0;
    }
  }

  function flushStreamingDom() {
    state.streamingRaf = 0;
    if (!state.streamingEl) return;
    state.streamingEl.textContent = state.streamingRaw;
    if (state.streamingScrollPending) {
      state.streamingScrollPending = false;
      scrollMessagesEnd();
    }
  }

  function scheduleStreamingDom() {
    state.streamingScrollPending = true;
    if (state.streamingRaf) return;
    state.streamingRaf = requestAnimationFrame(flushStreamingDom);
  }

  function flushReasoningDom() {
    state.reasoningRaf = 0;
    if (!state.reasoningEl) return;
    const pre = state.reasoningEl.querySelector(".fold-body pre");
    if (pre) pre.textContent = state.reasoningRaw;
    const sum = state.reasoningEl.querySelector("summary .fold-label");
    if (sum) {
      const n = (state.reasoningRaw || "").length;
      sum.textContent = n ? `思考过程 · ${n} 字` : "思考过程";
    }
  }

  function scheduleReasoningDom() {
    if (state.reasoningRaf) return;
    state.reasoningRaf = requestAnimationFrame(flushReasoningDom);
  }

  /** Create a collapsible process block (tool / reasoning). */
  function makeFoldDetails(kind, label, detail, toolName, opts = {}) {
    clearWelcome();
    // 聊天界面隐藏「调用工具」折叠块（不挂载；仍返回节点给 updateToolFoldEnd 用）
    if (kind === "tool" && !opts.forceShowTool) {
      const dummy = document.createElement("details");
      dummy.className = "msg tool fold-msg tool-msg hide-tool-call";
      dummy.hidden = true;
      dummy.style.display = "none";
      dummy.dataset.role = "tool";
      if (toolName) dummy.dataset.tool = toolName;
      dummy.dataset.raw = detail || "";
      dummy.innerHTML =
        '<summary class="fold-summary"><span class="fold-label"></span></summary>' +
        '<div class="fold-body"><pre></pre></div>';
      const lab = dummy.querySelector(".fold-label");
      if (lab) lab.textContent = label;
      const pre = dummy.querySelector("pre");
      if (pre) pre.textContent = detail || "";
      return dummy;
    }
    const details = document.createElement("details");
    details.className =
      "msg tool fold-msg " + (kind === "reasoning" ? "reasoning-msg" : "tool-msg");
    details.open = !collapseProcessEnabled();
    details.dataset.role = kind;
    if (toolName) details.dataset.tool = toolName;
    details.dataset.raw = detail || "";
    details.innerHTML =
      '<summary class="fold-summary"><span class="fold-label"></span></summary>' +
      '<div class="fold-body"><pre></pre></div>';
    details.querySelector(".fold-label").textContent = label;
    details.querySelector("pre").textContent = detail || "";
    if (!opts.noMount) {
      getChatMount().appendChild(details);
      scrollMessagesEnd();
    }
    return details;
  }

  function ensureReasoningFold() {
    if (state.reasoningEl) return state.reasoningEl;
    state.reasoningRaw = "";
    state.reasoningEl = makeFoldDetails("reasoning", "思考过程", "");
    return state.reasoningEl;
  }

  function finishReasoningFold() {
    cancelRaf("reasoningRaf");
    flushReasoningDom();
    state.reasoningEl = null;
    state.reasoningRaw = "";
  }

  /** Close answer bubble: keep text or drop empty placeholder. */
  function finalizeStreamingBubble(asMarkdown) {
    if (!state.streamingEl) return;
    cancelRaf("streamingRaf");
    flushStreamingDom();
    const host =
      state.streamingEl.closest?.(".msg") || state.streamingEl.parentElement;
    if (state.streamingRaw) {
      setMsgBody(state.streamingEl, state.streamingRaw, !!asMarkdown);
    } else if (host) {
      host.remove();
    }
    state.streamingEl = null;
    state.streamingRaw = "";
  }

  function addToolFold(phase, name, detail) {
    const label =
      phase === "start"
        ? `工具 · ${name || "?"} · 调用中`
        : `工具 · ${name || "?"}`;
    return makeFoldDetails("tool", label, detail, name || "");
  }

  function updateToolFoldEnd(name, result) {
    let row = state.activeToolRow;
    if (!row || (name && row.dataset.tool && row.dataset.tool !== name)) {
      row = addToolFold("end", name, "← " + (name || "") + "\n" + (result || ""));
    } else {
      const pre = row.querySelector(".fold-body pre");
      const prev = pre?.textContent || "";
      const next =
        (prev ? prev + "\n\n" : "") +
        "← " +
        (name || "") +
        "\n" +
        (result || "");
      if (pre) pre.textContent = next;
      row.dataset.raw = next;
      const lab = row.querySelector("summary .fold-label");
      if (lab) lab.textContent = `工具 · ${name || "?"} · 完成`;
    }
    state.activeToolRow = null;
    scrollMessagesEnd();
  }

  function resetStreamUi() {
    cancelRaf("streamingRaf");
    cancelRaf("reasoningRaf");
    state.streamingRaw = "";
    state.reasoningRaw = "";
    state.reasoningEl = null;
    state.activeToolRow = null;
  }

  const $ = (id) => document.getElementById(id);
  const mainLayout = $("mainLayout");
  const messagesEl = $("messages");
  const inputEl = $("input");
  const editorEmpty = $("editorEmpty");
  const monacoHost = $("monacoEditor");
  const tabsEl = $("tabs");
  const sideBody = $("sideBody");
  const sideTitle = $("sideTitle");

  const localBreakpoints = new Map(); // path -> Set<line>

  async function toggleBreakpoint(filePath, line) {
    if (!filePath || !line) return;
    const key = String(filePath);
    if (!localBreakpoints.has(key)) localBreakpoints.set(key, new Set());
    const set = localBreakpoints.get(key);
    if (set.has(line)) {
      set.delete(line);
      await emsoder.debugRemoveBreakpoint(filePath, line);
    } else {
      set.add(line);
      await emsoder.debugSetBreakpoint(filePath, line);
    }
    await EmsoderEditor.syncBreakpointDecorations?.(filePath, [...set]);
    EmsoderPanels.refreshBreakpointsList?.();
  }

  window.EmsoderApp = {
    toast: (...a) => EmsoderDom.toast(...a),
    toggleBreakpoint,
    getActivePath: () => state.activePath || "",
    showProviders: () => showProviders(),
    showModels: () => showModels(),
    refreshQuestModels: () => {
      if (typeof window.EmsoderQuest?.refreshModelOptions === "function") {
        return window.EmsoderQuest.refreshModelOptions();
      }
    },
  };

  const toast = (...a) => EmsoderDom.toast(...a);


  function setBusyButton(btn, busy, labelBusy, labelIdle) {
    if (!btn) return;
    if (busy) {
      if (!btn.dataset.prevText) btn.dataset.prevText = btn.textContent;
      if (labelBusy) btn.textContent = labelBusy;
      btn.classList.add("busy");
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
    } else {
      btn.classList.remove("busy");
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      if (labelIdle) btn.textContent = labelIdle;
      else if (btn.dataset.prevText) btn.textContent = btn.dataset.prevText;
      delete btn.dataset.prevText;
    }
  }

  /** 给 IPC/网络请求加前端超时，避免按钮一直转圈 */
  function withUiTimeout(promise, ms, label = "请求") {
    const timeoutMs = Math.max(3000, Number(ms) || 20000);
    let settled = false;
    let timer;
    return new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${label}超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      Promise.resolve(promise).then(
        (v) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  }

  /** 按钮兜底：无论 promise 怎样，最多 N ms 后强制复位 */
  function guardBusyButton(btn, idleLabel, ms = 20000) {
    if (!btn) return () => {};
    const token = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    btn.dataset.busyToken = token;
    const timer = setTimeout(() => {
      if (btn.dataset.busyToken !== token) return;
      btn.dataset.busy = "0";
      setBusyButton(btn, false, null, idleLabel);
      toast(idleLabel + "超时，已恢复按钮（请检查网络/Base URL）", true);
    }, ms);
    return () => {
      clearTimeout(timer);
      if (btn.dataset.busyToken === token) delete btn.dataset.busyToken;
    };
  }

  function setTaskProgress(active, detail) {
    const ind = $("runIndicator");
    const indText = $("runIndicatorText");
    const st = $("statusText");
    const sb = $("sbStatus");
    if (active) {
      if (!state.runStartedAt) state.runStartedAt = Date.now();
      const sec = Math.max(0, Math.floor((Date.now() - state.runStartedAt) / 1000));
      const base = detail || "任务进行中";
      const line = base + " · " + sec + "s";
      state._runDetail = base;
      if (ind) {
        ind.hidden = false;
        if (indText) indText.textContent = line;
      }
      if (st) {
        st.textContent = line;
        st.className = "status-run";
      }
      if (sb) sb.textContent = line;
      if (!state._runTick) {
        state._runTick = setInterval(() => {
          if (!state.generating) return;
          setTaskProgress(true, state._runDetail || "任务进行中");
        }, 1000);
      }
    } else {
      state.runStartedAt = 0;
      state._runDetail = "";
      if (state._runTick) {
        clearInterval(state._runTick);
        state._runTick = 0;
      }
      if (ind) ind.hidden = true;
      if (st) {
        st.textContent = detail || "就绪";
        st.className =
          detail && /失败|错误|error/i.test(String(detail))
            ? "status-err"
            : "status-idle";
      }
      if (sb) sb.textContent = detail || "就绪";
    }
  }

  function setGenerating(v, detail) {
    state.generating = !!v;
    if (v) state._runDetail = detail || "任务进行中";
    // 队列模式下发送不禁用：busy 时再点 = 入队
    if ($("btnSend")) $("btnSend").disabled = false;
    const busy = !!v || state.queueDepth > 0;
    if ($("btnStop")) $("btnStop").disabled = !busy;
    if ($("btnStop2")) $("btnStop2").disabled = !busy;
    let label = detail || (v ? "任务进行中" : "就绪");
    if (state.queueDepth > 0) {
      label = (v ? "生成中" : "排队") + " · 队列 " + state.queueDepth;
    }
    setTaskProgress(busy, label);
  }

  function setQueueDepth(n) {
    // 以主进程权威数字为准，覆盖渲染层本地估算
    state.queueDepth = Math.max(0, Number(n) || 0);
    // 只更新 UI 标签，不强制切换 generating（由 assistant_done / queue 事件各自管）
    if (state.generating || state.queueDepth > 0) {
      setGenerating(state.generating, state._runDetail || "任务进行中");
    } else {
      setGenerating(false, "就绪");
    }
  }

  function isEditorCollapsed() {
    return mainLayout.classList.contains("editor-collapsed");
  }

  function syncEditorToggleUI() {
    const hidden = isEditorCollapsed();
    const labelShow = "显示编辑器";
    const labelHide = "隐藏编辑器";
    const t1 = $("btnToggleEditor");
    const t2 = $("btnToggleEditor2");
    if (t1) {
      t1.textContent = hidden ? labelShow : labelHide;
      t1.classList.toggle("primary", hidden);
      t1.title = hidden ? "显示右侧编辑器" : "隐藏右侧编辑器";
    }
    if (t2) {
      t2.textContent = hidden ? labelShow : labelHide;
      t2.title = t1?.title || "";
    }
    const fromChat = $("btnShowEditorFromChat");
    if (fromChat) {
      fromChat.style.display = hidden ? "" : "none";
    }
  }

  function setEditorVisible(visible, persist = true) {
    mainLayout.classList.toggle("editor-collapsed", !visible);
    syncEditorToggleUI();
    if (persist) {
      try {
        localStorage.setItem("emsoder.ideEditorVisible", visible ? "1" : "0");
      } catch {
        /* ignore */
      }
    }
    setTimeout(() => {
      EmsoderEditor.layout?.();
      window.EmsoderResize?.applyQuestWidths?.();
    }, 40);
  }

  function toggleEditorPanel() {
    setEditorVisible(isEditorCollapsed());
  }

  window.EmsoderApp.syncEditorToggleUI = syncEditorToggleUI;
  window.EmsoderApp.setEditorVisible = setEditorVisible;
  window.EmsoderApp.toggleEditorPanel = toggleEditorPanel;


  function renderAttachments() {
    const box = $("attachChips");
    if (!box) return;
    const list = state.attachments || [];
    if (!list.length) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    box.innerHTML = "";
    list.forEach((a, idx) => {
      const chip = document.createElement("span");
      chip.className = "attach-chip" + (a.kind === "image" ? " image" : "");
      if (a.kind === "image" && a.dataUrl) {
        const img = document.createElement("img");
        img.className = "thumb";
        img.src = a.dataUrl;
        img.alt = a.name || "img";
        chip.appendChild(img);
      }
      const name = document.createElement("span");
      name.className = "name";
      name.title = a.path || a.name;
      const kindLabel =
        a.kind === "image" ? "图" : a.kind === "text" ? "文" : "路径";
      name.textContent = (a.name || "file") + " ·" + kindLabel;
      const x = document.createElement("button");
      x.type = "button";
      x.className = "x";
      x.textContent = "×";
      x.onclick = () => {
        state.attachments.splice(idx, 1);
        renderAttachments();
      };
      chip.appendChild(name);
      chip.appendChild(x);
      box.appendChild(chip);
    });
  }

  function formatSize(n) {
    const v = Number(n) || 0;
    if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + "MB";
    if (v >= 1024) return Math.round(v / 1024) + "KB";
    return v + "B";
  }

  // ---------- @-mention file picker ----------
  let _mentionCachePromise = null;

  async function loadMentionCache() {
    if (_mentionCachePromise) return _mentionCachePromise;
    _mentionCachePromise = emsoder.walkFiles({ maxFiles: 600 }).then((r) => {
      const all = [
        ...(r.dirs || []).map((d) => ({ ...d, icon: "📁" })),
        ...(r.files || []).map((f) => ({ ...f, icon: "📄" })),
      ];
      // sort: dirs first, then by path
      all.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.path.localeCompare(b.path);
      });
      state.mention.cache = all;
      state.mention.ts = Date.now();
      return all;
    }).catch(() => {
      _mentionCachePromise = null;
      return [];
    });
    return _mentionCachePromise;
  }

  function escapeMentionHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function highlightMatch(text, query) {
    if (!query) return escapeMentionHtml(text);
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return escapeMentionHtml(text);
    return (
      escapeMentionHtml(text.slice(0, idx)) +
      `<span class="mhl">${escapeMentionHtml(text.slice(idx, idx + query.length))}</span>` +
      escapeMentionHtml(text.slice(idx + query.length))
    );
  }

  async function showMentionPopup(searchText) {
    const m = state.mention;
    if (!m.cache || Date.now() - m.ts > 120_000) {
      await loadMentionCache();
    }
    const items = (m.cache || []).filter((f) => {
      if (!searchText) return true;
      const q = searchText.toLowerCase();
      return f.path.toLowerCase().includes(q);
    }).slice(0, 30);
    if (!items.length) {
      hideMentionPopup();
      return;
    }
    m.items = items;
    m.visible = true;
    m.searchText = searchText;
    m.index = Math.min(m.index, items.length - 1);
    renderMentionList();
    $("mentionPopup").hidden = false;
  }

  function hideMentionPopup() {
    const m = state.mention;
    m.visible = false;
    m.items = [];
    m.index = 0;
    m.searchText = "";
    m.triggerPos = -1;
    $("mentionPopup").hidden = true;
  }

  function renderMentionList() {
    const m = state.mention;
    const list = $("mentionList");
    list.innerHTML = "";
    m.items.forEach((f, i) => {
      const el = document.createElement("div");
      el.className = "mention-item" + (i === m.index ? " active" : "");
      el.innerHTML = `<span class="micon">${f.icon || "📄"}</span><span class="mpath">${highlightMatch(f.path, m.searchText)}</span>`;
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        selectMentionAt(i);
      });
      list.appendChild(el);
    });
    // scroll active into view
    const active = list.children[m.index];
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function selectMentionAt(index) {
    const m = state.mention;
    const item = m.items[index];
    if (!item) return;
    // Replace @text from trigger position in textarea
    const pos = m.triggerPos;
    if (pos >= 0) {
      const v = inputEl.value;
      const cursor = inputEl.selectionStart || 0;
      const prefix = v.slice(0, pos);
      const suffix = v.slice(cursor);
      const ref = "@" + item.path + " ";
      inputEl.value = prefix + ref + suffix;
      const newPos = pos + ref.length;
      inputEl.selectionStart = inputEl.selectionEnd = newPos;
    }
    hideMentionPopup();
    inputEl.focus();
  }

  function detectAtTrigger() {
    const v = inputEl.value;
    const cursor = inputEl.selectionStart;
    if (cursor == null) return;
    // find the @ before cursor
    let pos = -1;
    for (let i = cursor - 1; i >= 0; i--) {
      if (v[i] === "@" && (i === 0 || /\s/.test(v[i - 1]) || v[i - 1] === "\n")) {
        pos = i;
        break;
      }
      if (/\s/.test(v[i]) || v[i] === "\n") break;
    }
    if (pos < 0) { hideMentionPopup(); return; }
    const search = v.slice(pos + 1, cursor);
    // ignore @ only (no search) if cursor just typed @ — show after 1ms debounce
    if (search.includes(" ")) { hideMentionPopup(); return; }
    state.mention.triggerPos = pos;
    showMentionPopup(search);
  }

  // @ 引用：单文件与合计上限，避免一次塞爆模型上下文（buildAttachmentPayload 另有 120k 切片）
  const AT_MENTION_MAX_CHARS = 80000;
  const AT_MENTION_MAX_TOTAL = 200000;
  const AT_MENTION_MAX_FILES = 12;

  /** Parse @path references from text, read files, return attachment-style objects. */
  async function resolveAtMentions(text) {
    if (!text || !state.workspace) return [];
    const re = /(?:^|\s)@([^\s@]+)/g;
    const paths = new Set();
    let m;
    while ((m = re.exec(text)) !== null) {
      const p = m[1].trim();
      if (p && !p.startsWith("@") && p.length > 1 && p.length < 300) {
        paths.add(p);
      }
    }
    if (!paths.size) return [];
    const results = [];
    let totalChars = 0;
    let skippedLarge = 0;
    const root = state.workspace.replace(/[/\\]+$/, "");
    for (const rel of paths) {
      if (results.length >= AT_MENTION_MAX_FILES) {
        skippedLarge++;
        break;
      }
      if (totalChars >= AT_MENTION_MAX_TOTAL) {
        skippedLarge++;
        break;
      }
      try {
        // Windows 下 / 亦可；统一去掉 rel 前导分隔，避免 // 或 \\
        const cleanRel = String(rel).replace(/^[/\\]+/, "").replace(/\\/g, "/");
        const abs = root + "/" + cleanRel;
        let content = await emsoder.readFile(abs);
        if (typeof content !== "string") continue;
        if (content.includes("\u0000")) continue;
        const origLen = content.length;
        let truncated = false;
        const room = Math.max(0, AT_MENTION_MAX_TOTAL - totalChars);
        const cap = Math.min(AT_MENTION_MAX_CHARS, room);
        if (content.length > cap) {
          content =
            content.slice(0, cap) +
            "\n\n/* … 已截断：原 " +
            origLen +
            " 字符，本次仅附带前 " +
            cap +
            " 字符（@ 引用上限）… */\n";
          truncated = true;
        }
        totalChars += content.length;
        results.push({
          kind: "text",
          path: cleanRel,
          name: cleanRel.split("/").pop() || cleanRel,
          size: origLen,
          content,
          truncated,
        });
      } catch {
        /* file unreadable */
      }
    }
    if (skippedLarge > 0 && results.length) {
      // 在首条 meta 上不污染 content；调用方可 toast，这里轻量提示一次
      try {
        toast(
          "@ 引用已达上限（单文件 " +
            AT_MENTION_MAX_CHARS +
            " / 合计 " +
            AT_MENTION_MAX_TOTAL +
            " / 最多 " +
            AT_MENTION_MAX_FILES +
            " 个），部分文件未附带全文",
          false
        );
      } catch {
        /* toast 未就绪时忽略 */
      }
    }
    return results;
  }

  /** Build display summary (chat bubble) + model text + vision attachments */
  function buildAttachmentPayload() {
    const list = state.attachments || [];
    if (!list.length) {
      return { displayText: "", modelText: "", attachments: [] };
    }
    const displayParts = [];
    const modelParts = [];
    const meta = [];
    for (const a of list) {
      const size = formatSize(a.size);
      if (a.kind === "image") {
        displayParts.push("📷 " + (a.name || "image") + " (" + size + ")");
        modelParts.push("图片附件: " + (a.name || a.path || "image"));
        meta.push(a);
      } else if (a.kind === "text" && a.content) {
        const truncNote = a.truncated ? "，已截断" : "";
        displayParts.push(
          "📄 " + (a.name || "file") + " (" + size + "，已附带内容" + truncNote + ")"
        );
        const body = String(a.content).slice(0, 120000);
        modelParts.push(
          "文件: " + (a.path || a.name) + "\n```\n" + body + "\n```"
        );
        meta.push(a);
      } else {
        displayParts.push(
          "📎 " + (a.name || "file") + " (" + size + "，仅路径)"
        );
        modelParts.push("文件路径: " + (a.path || a.name));
        meta.push(a);
      }
    }
    return {
      displayText: "【附件 " + list.length + "】\n" + displayParts.join("\n"),
      modelText: modelParts.join("\n\n"),
      attachments: meta,
    };
  }

  async function addAttachmentsFromPicker() {
    try {
      const files = await emsoder.pickAttach();
      if (!files?.length) return;
      for (const f of files) {
        if (state.attachments.some((x) => x.path === f.path)) continue;
        if (state.attachments.length >= 8) {
          toast("最多 8 个附件", true);
          break;
        }
        state.attachments.push(f);
      }
      renderAttachments();
      toast("已添加附件");
    } catch (e) {
      toast(e.message || e, true);
    }
  }

  const formatTok = (n) => EmsoderDom.formatTok(n);

  function updateContextStatsUI(stats) {
    const ctxEl = $("sbContext");
    const cacheEl = $("sbCache");
    if (!ctxEl && !cacheEl) return;
    if (!stats) {
      if (ctxEl) ctxEl.textContent = "ctx —";
      if (cacheEl) cacheEl.textContent = "cache —";
      return;
    }
    const used = formatTok(stats.usedTokens);
    const win = formatTok(stats.contextWindow);
    const pct = stats.fillPercent != null ? stats.fillPercent : 0;
    if (ctxEl) {
      ctxEl.textContent = `ctx ${used}/${win} (${pct}%)`;
      ctxEl.classList.toggle("warn", pct >= 70 && pct < 90);
      ctxEl.classList.toggle("danger", pct >= 90);
      ctxEl.title = [
        `上下文窗口: ${stats.usedTokens || 0} / ${stats.contextWindow || 0} tokens`,
        `占用 ${pct}%`,
        stats.model ? `模型: ${stats.model}` : "",
        stats.lastSource ? `来源: ${stats.lastSource}` : "",
        "点击可刷新；可在配置里设 contextWindow / modelContextWindows",
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (cacheEl) {
      const avg =
        stats.avgCacheHitPercent != null ? stats.avgCacheHitPercent : 0;
      const samples = stats.samples || 0;
      cacheEl.textContent = samples
        ? `cache ${avg}%`
        : "cache —";
      cacheEl.classList.toggle("good", avg >= 30);
      cacheEl.title = [
        `平均缓存命中率: ${avg}%（近 ${samples} 次请求）`,
        stats.lastCacheHitPercent != null
          ? `上次命中: ${stats.lastCacheHitPercent}%`
          : "",
        stats.cachedTokens
          ? `上次缓存 tokens: ${stats.cachedTokens}`
          : "",
        "有 API usage 时用服务商数据；否则用本地前缀复用估算",
      ]
        .filter(Boolean)
        .join("\n");
    }
  }

  async function refreshContextStats() {
    try {
      const stats = await emsoder.getContextStats();
      updateContextStatsUI(stats);
    } catch {
      /* ignore */
    }
  }

  function refreshModelChips() {
    const c = state.config;
    if (!c) return;
    $("modelChip").textContent = c.activeModel || "选择模型";
    $("sbModel").textContent = `${c.providerName || "none"} / ${c.activeModel || "?"}`;
    $("sbMode").textContent = c.agentMode ? "Agent" : "Ask";
    document.querySelectorAll("#modeSeg button").forEach((b) => {
      b.classList.toggle("active", (b.dataset.mode === "agent") === !!c.agentMode);
    });
    refreshAutoApproveBtn();
  }

  const openModal = (id) => EmsoderDom.openModal(id);

  const closeModal = (id) => EmsoderDom.closeModal(id);

  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.getAttribute("data-close")));
  });
  document.querySelectorAll(".modal-backdrop").forEach((bd) => {
    bd.addEventListener("click", (e) => {
      if (e.target === bd) closeModal(bd.id);
    });
  });

  const basename = (p) => EmsoderDom.basename(p);

  const escapeHtml = (s) => EmsoderDom.escapeHtml(s);

  function renderMarkdown(src) {
    const text = String(src || "");
    const parts = [];
    const re = /```([\w-]*)\n?([\s\S]*?)```/g;
    let m;
    let last = 0;
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push({ type: "text", value: text.slice(last, m.index) });
      parts.push({ type: "code", value: m[2] });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ type: "text", value: text.slice(last) });

    function inlineFormat(s) {
      let out = escapeHtml(s);
      out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
      out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      out = out.replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        (_, linkText, url) => {
          // Strip any " or ' to prevent attribute injection (e.g. href="url" onclick=...)
          const safeUrl = url.replace(/["']/g, (c) => encodeURIComponent(c));
          return `<a href="${safeUrl}" target="_blank" rel="noreferrer">${linkText}</a>`;
        }
      );
      return out;
    }

    function formatTextBlock(block) {
      const lines = block.split(/\r?\n/);
      let html = "";
      let listType = null;
      const flushList = () => {
        if (listType) {
          html += listType === "ol" ? "</ol>" : "</ul>";
          listType = null;
        }
      };
      for (const line of lines) {
        const ul = line.match(/^\s*[-*]\s+(.+)$/);
        const ol = line.match(/^\s*\d+\.\s+(.+)$/);
        if (ul) {
          if (listType !== "ul") {
            flushList();
            listType = "ul";
            html += "<ul>";
          }
          html += `<li>${inlineFormat(ul[1])}</li>`;
          continue;
        }
        if (ol) {
          if (listType !== "ol") {
            flushList();
            listType = "ol";
            html += "<ol>";
          }
          html += `<li>${inlineFormat(ol[1])}</li>`;
          continue;
        }
        flushList();
        if (line.trim()) html += `<p>${inlineFormat(line)}</p>`;
      }
      flushList();
      return html;
    }

    return parts
      .map((p) =>
        p.type === "code"
          ? `<pre><code>${escapeHtml(p.value.replace(/\n$/, ""))}</code></pre>`
          : formatTextBlock(p.value)
      )
      .join("");
  }

  function setMsgBody(el, text, asMarkdown) {
    if (!el) return;
    if (asMarkdown) el.innerHTML = renderMarkdown(text);
    else el.textContent = text;
  }

  // ---------- Editor / Tabs (Monaco) ----------
  function renderTabs() {
    tabsEl.innerHTML = "";
    for (const t of state.tabs) {
      const el = document.createElement("div");
      el.className =
        "tab" +
        (t.path === state.activePath ? " active" : "") +
        (t.dirty ? " dirty" : "");
      el.innerHTML = `<span class="name"></span><span class="close">×</span>`;
      el.querySelector(".name").textContent = t.name;
      el.title = t.path;
      el.addEventListener("click", (e) => {
        if (e.target.classList.contains("close")) closeTab(t.path);
        else activateTab(t.path);
      });
      tabsEl.appendChild(el);
    }
  }

  async function flushActiveToTab() {
    const cur = state.tabs.find((t) => t.path === state.activePath);
    if (!cur || !state.monacoReady) return;
    cur.content = EmsoderEditor.getValue();
    cur.dirty = cur.content !== cur.original;
  }

  async function activateTab(filePath) {
    const tab = state.tabs.find((t) => t.path === filePath);
    if (!tab) return;
    await flushActiveToTab();
    state.activePath = filePath;

    try {
      await EmsoderEditor.ensure();
      state.monacoReady = true;
      monacoHost.classList.remove("hidden");
      editorEmpty.classList.add("hidden");
      const info = await EmsoderEditor.openDocument({
        path: tab.path,
        content: tab.content,
      });
      $("editorLang").textContent = info.language || "plaintext";
      $("sbFile").textContent = tab.name;
      EmsoderEditor.applyConfig(state.config);
      renderTabs();
      sideBody.querySelectorAll(".tree-item").forEach((n) => {
        n.classList.toggle("active", n.dataset.path === filePath);
      });
    } catch (err) {
      toast("编辑器加载失败: " + (err.message || err), true);
    }
  }

  async function closeTab(filePath) {
    const idx = state.tabs.findIndex((t) => t.path === filePath);
    if (idx < 0) return;
    if (filePath === state.activePath) await flushActiveToTab();
    const tab = state.tabs[idx];
    if (tab.dirty && !(await EmsoderDom.showConfirm(`${tab.name} 有未保存更改，仍要关闭？`))) return;
    state.tabs.splice(idx, 1);
    if (state.activePath === filePath) {
      const next = state.tabs[idx] || state.tabs[idx - 1];
      if (next) await activateTab(next.path);
      else {
        state.activePath = null;
        monacoHost.classList.add("hidden");
        editorEmpty.classList.remove("hidden");
        $("sbFile").textContent = "—";
        $("editorLang").textContent = "—";
      }
    }
    renderTabs();
  }

  async function openFile(filePath, line, column) {
    if (typeof setEditorVisible === "function" && isEditorCollapsed()) setEditorVisible(true);
    const existing = state.tabs.find((t) => t.path === filePath);
    if (existing) {
      await activateTab(filePath);
      if (line) {
        EmsoderEditor.revealLine(line);
        try {
          const ed = EmsoderEditor.getEditor?.();
          ed?.setPosition({
            lineNumber: line,
            column: column || 1,
          });
          ed?.focus();
        } catch {
          /* ignore */
        }
      }
      return;
    }
    try {
      const file = await emsoder.readFile(filePath);
      state.tabs.push({
        path: file.path,
        name: basename(file.path),
        content: file.content,
        original: file.content,
        dirty: false,
      });
      await activateTab(file.path);
      // restore breakpoint decorations for this file
      const bps = localBreakpoints.get(file.path);
      if (bps?.size) {
        await EmsoderEditor.syncBreakpointDecorations?.(file.path, [...bps]);
      }
      if (line) {
        EmsoderEditor.revealLine(line);
        try {
          const ed = EmsoderEditor.getEditor?.();
          ed?.setPosition({
            lineNumber: line,
            column: column || 1,
          });
          ed?.focus();
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      toast("打开失败: " + (err.message || err), true);
    }
  }

  async function indexWorkspaceLsp(silent) {
    if (!state.workspace) return;
    try {
      if (!silent) toast("正在索引代码…");
      await EmsoderEditor.ensure();
      // 切换/重开工作区时先释放旧索引模型（保留已打开 tab 的模型）
      EmsoderLsp?.disposeIndexedModels?.(state.tabs.map((t) => t.path));
      const r = await EmsoderLsp?.indexWorkspace?.(state.workspace);
      if (!silent) {
        const tc = r?.tsconfig ? ` · ${r.tsconfig}` : "";
        toast(`LSP 索引：${r?.count || 0} 个文件${tc}`);
      }
      EmsoderPanels.renderProblems?.(EmsoderLsp?.getProblems?.() || []);
    } catch (err) {
      if (!silent) toast("索引失败: " + (err.message || err), true);
    }
  }

  async function saveActive() {
    const tab = state.tabs.find((t) => t.path === state.activePath);
    if (!tab) return;
    await flushActiveToTab();
    try {
      await emsoder.writeFile(tab.path, tab.content);
      tab.original = tab.content;
      tab.dirty = false;
      renderTabs();
      toast("已保存 " + tab.name);
    } catch (err) {
      toast("保存失败: " + (err.message || err), true);
    }
  }

  function hasDirtyTabs() {
    flushActiveToTab();
    return state.tabs.some((t) => t.dirty);
  }

  function getSelectionOrEmpty() {
    if (!state.monacoReady || !state.activePath) return "";
    return EmsoderEditor.getSelectionText() || "";
  }

  function addSelectionToChat(prefix) {
    const sel = getSelectionOrEmpty();
    if (!sel.trim()) {
      toast("请先选中代码", true);
      return;
    }
    const file = state.activePath || "selection";
    const lang = state.monacoReady ? EmsoderEditor.getLanguage() : "";
    const block = `${prefix || "关于这段代码："}\n\n文件: \`${file}\`\n\`\`\`${lang}\n${sel}\n\`\`\`\n`;
    inputEl.value = (inputEl.value ? inputEl.value + "\n\n" : "") + block;
    inputEl.focus();
    mainLayout.classList.remove("chat-collapsed");
  }

  // ---------- File tree ----------
  async function loadTree(dir, depth = 0) {
    const entries = await emsoder.readDir(dir);
    const frag = document.createDocumentFragment();
    for (const e of entries) {
      const item = document.createElement("div");
      item.className =
        "tree-item" +
        (e.isDirectory ? " dir" : "") +
        (e.heavy ? " heavy" : "");
      item.style.setProperty("--depth", depth);
      item.dataset.path = e.path;
      item.innerHTML = `<span class="icon">${e.isDirectory ? "▸" : "•"}</span><span class="label"></span>`;
      item.querySelector(".label").textContent =
        e.name + (e.heavy ? " (大目录)" : "");
      if (e.path === state.activePath) item.classList.add("active");

      if (e.isDirectory) {
        const expanded = state.expandedDirs.has(e.path);
        item.querySelector(".icon").textContent = expanded ? "▾" : "▸";
        item.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          if (state.expandedDirs.has(e.path)) state.expandedDirs.delete(e.path);
          else state.expandedDirs.add(e.path);
          await renderExplorer();
        });
        frag.appendChild(item);
        if (expanded) {
          try {
            frag.appendChild(await loadTree(e.path, depth + 1));
          } catch {
            /* ignore */
          }
        }
      } else {
        item.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openFile(e.path);
        });
        frag.appendChild(item);
      }
    }
    return frag;
  }

  async function renderExplorer() {
    sideTitle.textContent = "资源管理器";
    sideBody.innerHTML = "";
    if (!state.workspace) {
      sideBody.innerHTML =
        '<div class="tree-empty">打开一个文件夹开始编码。<br/>Ctrl+O</div>';
      return;
    }
    try {
      sideBody.appendChild(await loadTree(state.workspace, 0));
    } catch (err) {
      sideBody.innerHTML = `<div class="tree-empty">${escapeHtml(err.message || err)}</div>`;
    }
  }

  /** 按当前侧栏视图刷新，避免会话/搜索等点 ↻ 被打回资源管理器 */
  async function refreshCurrentSideView() {
    const view = state.sideView || "sessions";
    if (view === "explorer") return renderExplorer();
    if (view === "sessions") return renderSessionsSide();
    if (view === "search") return renderSearchSide();
    if (view === "git") return renderGitSide();
    if (view === "skills") return renderSkillsSide();
    if (view === "memory") return renderMemorySide();
    if (view === "mcp") return renderMcpSide();
    if (view === "quest") {
      EmsoderQuest?.refreshBoard?.();
      EmsoderQuest?.renderSide?.();
      return;
    }
    if (view === "settings") {
      openModal("modalSettings");
      fillSettingsForm();
      return;
    }
    return renderSessionsSide();
  }

  /** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / M月D日 / YYYY-M-D */
  function formatRelativeTime(ts) {
    const t = Number(ts);
    if (!t) return "";
    const diff = Date.now() - t;
    if (diff < 60 * 1000) return "刚刚";
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + " 小时前";
    const d = new Date(t);
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    if (sameYear && d.getDate() === now.getDate() - 1 && d.getMonth() === now.getMonth()) return "昨天";
    return `${sameYear ? "" : d.getFullYear() + "-"}${d.getMonth() + 1}月${d.getDate()}日`;
  }

  /** 仅当会话侧栏可见时静默重绘（不打断其他视图/聊天） */
  async function refreshSessionsSideIfVisible() {
    if (state.sideView !== "sessions") return;
    try {
      await renderSessionsSide();
    } catch {
      /* ignore */
    }
  }

  /** 双击标题内联重命名 */
  function beginRenameSession(item, titleEl) {
    const input = document.createElement("input");
    input.className = "session-title-input";
    input.value = item.title || "";
    input.maxLength = 60;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const value = save ? input.value.trim() : "";
      if (save && value && value !== (item.title || "")) {
        try {
          const r = await emsoder.renameSession(item.id, value);
          if (r?.ok === false) {
            toast(r.error || "重命名失败", true);
          } else if (r?.session && r.session.id === state.activeSessionId) {
            applySessionUpdate(r.session);
          }
          await refreshSessionsSideIfVisible();
        } catch (e) {
          toast(e.message || e, true);
        }
      } else {
        await refreshSessionsSideIfVisible();
      }
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (e) => e.stopPropagation());
  }

  /** 单条删除会话（hover ✕ 按钮） */
  async function deleteSessionItem(id, label) {
    if (!(await EmsoderDom.showConfirm("删除会话「" + label + "」？不可恢复。"))) return;
    try {
      const r = await emsoder.removeSession(id);
      toast("已删除会话");
      const active = r?.session || (await emsoder.getSession?.()) || null;
      if (active) {
        applySessionUpdate(active);
      } else {
        state.branchMeta = [];
        renderHistory([], []);
        renderChatChanges([], null);
      }
    } catch (e) {
      toast(e.message || e, true);
    }
    await refreshSessionsSideIfVisible();
  }

  async function renderSessionsSide() {
    sideTitle.textContent = "会话";
    const list = await emsoder.listSessions();
    sideBody.innerHTML = "";
    const toolbar = document.createElement("div");
    toolbar.className = "session-toolbar";
    toolbar.innerHTML =
      '<button class="btn primary btn-new-session" type="button" id="btnNewSessionSide" title="创建新会话">＋ 新会话</button>' +
      '<label class="session-check-all"><input type="checkbox" id="sessionCheckAll" /> 全选</label>' +
      '<button class="btn danger" type="button" id="btnDeleteSessions" disabled>删除</button>';
    sideBody.appendChild(toolbar);

    $("btnNewSessionSide")?.addEventListener("click", async () => {
      try {
        applySessionUpdate(await emsoder.newSession());
        toast("已创建新会话");
        await refreshSessionsSideIfVisible();
      } catch (e) {
        toast(e?.message || e || "创建失败", true);
      }
    });

    const selected = new Set();
    const syncDel = () => {
      const btn = $("btnDeleteSessions");
      if (btn) {
        btn.disabled = selected.size === 0;
        btn.textContent = selected.size
          ? "删除 (" + selected.size + ")"
          : "删除";
      }
      const all = $("sessionCheckAll");
      const boxes = sideBody.querySelectorAll(".session-check");
      if (all && boxes.length) {
        all.checked = selected.size === boxes.length;
        all.indeterminate = selected.size > 0 && selected.size < boxes.length;
      }
    };

    if (!list.length) {
      sideBody.appendChild(EmsoderDom.emptyState("暂无会话"));
      syncDel();
      return;
    }

    for (const item of list) {
      const el = document.createElement("div");
      el.className = "session-item tree-item";
      el.dataset.id = item.id;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "session-check";
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(item.id);
        else selected.delete(item.id);
        el.classList.toggle("selected", cb.checked);
        syncDel();
      });
      const meta = document.createElement("div");
      meta.className = "session-meta";
      const titleRow = document.createElement("div");
      titleRow.className = "session-title-row";
      const title = document.createElement("span");
      title.className = "session-title";
      title.textContent = item.title || "未命名";
      title.title = item.title || "";
      titleRow.appendChild(title);
      if (item.mode === "ask") {
        const badge = document.createElement("span");
        badge.className = "session-mode-badge";
        badge.textContent = "Ask";
        titleRow.appendChild(badge);
      }
      const sub = document.createElement("div");
      sub.className = "session-sub";
      const n = item.messageCount != null ? item.messageCount : "";
      const t = formatRelativeTime(item.updatedAt);
      sub.textContent = [n !== "" ? n + " 条消息" : "", t].filter(Boolean).join(" · ");
      meta.appendChild(titleRow);
      meta.appendChild(sub);
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "icon-btn session-del";
      delBtn.title = "删除会话";
      delBtn.textContent = "✕";
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await deleteSessionItem(item.id, item.title || "未命名");
      });
      el.appendChild(cb);
      el.appendChild(meta);
      el.appendChild(delBtn);
      titleRow.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        beginRenameSession(item, title);
      });
      el.addEventListener("click", async (e) => {
        if (e.target === cb || e.target.closest(".session-del")) return;
        if (state.generating) {
          toast("生成中，请先停止", true);
          return;
        }
        await emsoder.setActiveSession(item.id);
        const session = await emsoder.getSession();
        applySessionUpdate(session);
        sideBody.querySelectorAll(".session-item").forEach((n) => {
          n.classList.toggle("active", n.dataset.id === item.id);
        });
      });
      sideBody.appendChild(el);
    }

    $("sessionCheckAll")?.addEventListener("change", (e) => {
      const on = !!e.target.checked;
      sideBody.querySelectorAll(".session-check").forEach((box) => {
        box.checked = on;
        const row = box.closest(".session-item");
        const id = row?.dataset?.id;
        if (!id) return;
        if (on) selected.add(id);
        else selected.delete(id);
        row.classList.toggle("selected", on);
      });
      syncDel();
    });

    $("btnDeleteSessions")?.addEventListener("click", async () => {
      const ids = [...selected];
      if (!ids.length) return;
      if (!(await EmsoderDom.showConfirm("确定删除选中的 " + ids.length + " 个会话？不可恢复。"))) return;
      try {
        const r = await emsoder.removeSessions(ids);
        toast("已删除 " + (r.removed || ids.length) + " 个会话");
        // 删除后必须刷新：聊天区同步当前会话 + 侧栏列表重绘
        try {
          const active =
            r?.session ||
            (await emsoder.getSession?.()) ||
            null;
          if (active) {
            state.branchMeta = active.branchMeta || [];
            renderHistory(active.messages || [], active.branchMeta);
            renderChatChanges(active.fileChanges || [], active.id || null);
          } else {
            state.branchMeta = [];
            renderHistory([], []);
            renderChatChanges([], null);
          }
        } catch {
          /* 聊天同步失败不阻塞列表刷新 */
        }
      } catch (e) {
        toast(e.message || e, true);
      } finally {
        // 无论成功/失败都拉一次列表，避免 UI 停在旧勾选状态
        if (state.sideView === "sessions") {
          try {
            await renderSessionsSide();
          } catch (err) {
            toast(err?.message || err || "会话列表刷新失败", true);
          }
        }
      }
    });

    // 高亮当前活跃会话
    try {
      const active = await emsoder.getSession?.();
      const activeId = active?.id;
      if (activeId) {
        sideBody.querySelectorAll(".session-item").forEach((n) => {
          n.classList.toggle("active", n.dataset.id === activeId);
        });
      }
    } catch {
      /* ignore */
    }

    syncDel();
  }

  // ---------- Skills sidebar ----------
  function _skillSourceLabel(src) {
    const map = {
      zcode: "zcode",
      agents: "agents",
      workspace: "工作区",
      core: "预装",
      bundled: "捆绑",
      plugin: "插件",
    };
    return map[src] || src || "";
  }

  function _skillIconClass(src) {
    return "skill-icon " + (src || "");
  }

  function _skillIconEmoji(src) {
    const map = {
      zcode: "⚙",
      agents: "🤖",
      workspace: "📁",
      core: "★",
      bundled: "📦",
      plugin: "🔌",
    };
    return map[src] || "❓";
  }

  function _skillFilterMatch(s, q, status, source) {
    if (status === "enabled" && s.disabled) return false;
    if (status === "disabled" && !s.disabled) return false;
    if (source && source !== "all") {
      const src = s.source || "other";
      if (src !== source) return false;
    }
    const needle = String(q || "").trim().toLowerCase();
    if (!needle) return true;
    const hay = [
      s.name,
      s.id,
      s.description,
      s.cnDescription,
      s.source,
      ...(Array.isArray(s.triggers) ? s.triggers : []),
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    // multi-token: all tokens must appear (order-free)
    const tokens = needle.split(/\s+/).filter(Boolean);
    return tokens.every((t) => hay.includes(t));
  }

  function _appendSkillRow(sec, s, src) {
    const row = document.createElement("div");
    row.className = "skill-row" + (s.disabled ? " disabled" : "");
    const tipParts = [s.cnDescription, s.description, s.id].filter(Boolean);
    row.title = tipParts.join("\n") || s.id;
    row.innerHTML =
      `<div class="${_skillIconClass(src)}">${_skillIconEmoji(src)}</div>` +
      `<span class="skill-name">${escapeHtml(s.name)}</span>` +
      `<span class="skill-source">${_skillSourceLabel(src)}</span>` +
      '<div class="skill-actions">' +
      `<button class="btn-mini" data-act="view" title="查看 SKILL.md">查看</button>` +
      `<button class="btn-mini" data-act="toggle" title="禁用/启用">${s.disabled ? "启用" : "禁用"}</button>` +
      (src === "zcode" || src === "agents" || src === "workspace"
        ? '<button class="btn-mini danger" data-act="uninstall" title="卸载技能">卸载</button>'
        : "") +
      "</div>";

    row.querySelector('[data-act="view"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      showSkillDetail(s.id || s.name);
    });
    row.querySelector('[data-act="toggle"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      await toggleSkillDisable(s, !s.disabled);
      await renderSkillsSide();
    });
    const uninstallBtn = row.querySelector('[data-act="uninstall"]');
    if (uninstallBtn) {
      uninstallBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (await EmsoderDom.showConfirm(`确认卸载技能「${s.name}」？\n此操作不可撤销，将删除技能目录。`)) {
          await uninstallSkill(s);
          await renderSkillsSide();
        }
      });
    }
    row.addEventListener("click", () => showSkillDetail(s.id || s.name));
    sec.appendChild(row);
  }

  // ---------- Long-term memory sidebar ----------
  let _memorySearchTimer = null;

  async function renderMemorySide() {
    sideTitle.textContent = "长期记忆";
    if (!window.emsoder?.listMemories) {
      sideBody.innerHTML = '<div class="tree-empty">记忆 API 未就绪</div>';
      return;
    }
    sideBody.innerHTML = '<div class="tree-empty">加载中…</div>';
    let memories = [];
    try {
      const r = await emsoder.listMemories({ limit: 200 });
      memories = r?.ok ? r.memories || [] : [];
      if (!r?.ok) {
        sideBody.innerHTML = `<div class="tree-empty">${escapeHtml(r?.error || "加载失败")}</div>`;
        return;
      }
    } catch (e) {
      sideBody.innerHTML = `<div class="tree-empty">${escapeHtml(e.message || e)}</div>`;
      return;
    }

    sideBody.innerHTML = "";
    // Toolbar: search + add + extract-now + clear
    const toolbar = document.createElement("div");
    toolbar.className = "skills-toolbar";
    toolbar.innerHTML = `
      <input type="text" id="memorySearchInput" placeholder="搜索记忆内容或标签…" class="skills-search" />
      <button class="btn small" id="btnMemoryAdd" title="手动添加">+ 添加</button>
      <button class="btn small" id="btnMemoryExtract" title="从当前会话提取">提取</button>
      <button class="btn small" id="btnMemoryClear" title="清空全部">清空</button>
    `;
    sideBody.appendChild(toolbar);

    const list = document.createElement("div");
    list.className = "skill-list";
    list.id = "memoryList";
    sideBody.appendChild(list);

    function paint(items) {
      list.innerHTML = "";
      if (!items.length) {
        list.innerHTML = '<div class="tree-empty">暂无记忆。开启设置里的「长期记忆」后，每轮对话结束会自动提取事实/偏好。</div>';
        return;
      }
      for (const m of items) {
        const row = document.createElement("div");
        row.className = "skill-row";
        const imp = "★".repeat(m.importance || 3) + "☆".repeat(5 - (m.importance || 3));
        row.innerHTML = `
          <div class="skill-info">
            <span class="skill-name">${escapeHtml(m.content)}</span>
            <span class="skill-source">${escapeHtml((m.tags || []).join(", "))} · ${imp}</span>
          </div>
        `;
        row.addEventListener("click", () => showMemoryDetail(m.id));
        list.appendChild(row);
      }
    }
    paint(memories);

    // Search box (debounced)
    const searchInput = $("memorySearchInput");
    searchInput?.addEventListener("input", () => {
      clearTimeout(_memorySearchTimer);
      _memorySearchTimer = setTimeout(async () => {
        const q = searchInput.value.trim();
        if (!q) { paint(memories); return; }
        try {
          const r = await emsoder.listMemories({ q });
          paint(r?.ok ? r.memories || [] : []);
        } catch { /* ignore */ }
      }, 200);
    });

    $("btnMemoryAdd")?.addEventListener("click", () => showMemoryDetail(null));
    $("btnMemoryExtract")?.addEventListener("click", async () => {
      toast("正在从当前会话提取记忆…");
      try {
        const r = await emsoder.extractMemoriesNow();
        if (r?.ok) {
          toast(`提取了 ${r.added?.length || 0} 条记忆`);
          await renderMemorySide();
        } else {
          toast(r?.error || "提取失败", true);
        }
      } catch (e) { toast(e.message || e, true); }
    });
    $("btnMemoryClear")?.addEventListener("click", async () => {
      if (!(await EmsoderDom.showConfirm("确定清空全部长期记忆？不可恢复。"))) return;
      try {
        await emsoder.clearMemories();
        toast("已清空");
        await renderMemorySide();
      } catch (e) { toast(e.message || e, true); }
    });
  }

  async function showMemoryDetail(id) {
    let mem = null;
    if (id) {
      try {
        const all = await emsoder.listMemories({});
        mem = (all?.memories || []).find((m) => m.id === id) || null;
      } catch { /* ignore */ }
    }
    sideBody.innerHTML = "";
    const back = document.createElement("button");
    back.className = "btn small";
    back.textContent = "← 返回";
    back.addEventListener("click", () => renderMemorySide());
    sideBody.appendChild(back);

    const form = document.createElement("div");
    form.className = "skill-detail";
    form.innerHTML = `
      <div class="skill-section-title">${id ? "编辑记忆" : "添加记忆"}</div>
      <textarea id="memContent" rows="3" placeholder="记忆内容（事实或偏好）" style="width:100%;resize:vertical">${escapeHtml(mem?.content || "")}</textarea>
      <input type="text" id="memTags" placeholder="标签，逗号分隔" value="${escapeHtml((mem?.tags || []).join(", "))}" style="width:100%;margin-top:6px" />
      <label style="display:block;margin-top:6px;font-size:12px">重要性（1-5）
        <input type="number" id="memImportance" min="1" max="5" value="${mem?.importance || 3}" style="width:60px" />
      </label>
      <div style="margin-top:8px;display:flex;gap:6px">
        <button class="btn primary" id="memSave">${id ? "保存" : "添加"}</button>
        ${id ? '<button class="btn" id="memDelete">删除</button>' : ""}
      </div>
    `;
    sideBody.appendChild(form);

    $("memSave")?.addEventListener("click", async () => {
      const content = $("memContent").value.trim();
      if (!content) { toast("内容不能为空", true); return; }
      const tags = $("memTags").value.split(",").map((t) => t.trim()).filter(Boolean);
      const importance = Math.min(5, Math.max(1, Number($("memImportance").value) || 3));
      try {
        if (id) {
          await emsoder.updateMemory(id, { content, tags, importance });
          toast("已保存");
        } else {
          await emsoder.addMemory({ content, tags, importance });
          toast("已添加");
        }
        await renderMemorySide();
      } catch (e) { toast(e.message || e, true); }
    });
    $("memDelete")?.addEventListener("click", async () => {
      if (!(await EmsoderDom.showConfirm("删除这条记忆？"))) return;
      try {
        await emsoder.removeMemory(id);
        toast("已删除");
        await renderMemorySide();
      } catch (e) { toast(e.message || e, true); }
    });
  }

  async function renderSkillsSide() {
    sideTitle.textContent = "技能管理";
    if (!window.emsoder?.listSkills) {
      sideBody.innerHTML = '<div class="tree-empty">技能 API 未就绪</div>';
      return;
    }
    sideBody.innerHTML = '<div class="tree-empty">加载中…</div>';
    try {
      const r = await emsoder.listSkills();
      sideBody.innerHTML = "";
      if (!r?.ok) {
        sideBody.innerHTML = `<div class="tree-empty">${escapeHtml(r?.error || "加载失败")}</div>`;
        return;
      }
      if (r.enabled === false) {
        sideBody.innerHTML = '<div class="tree-empty">技能功能已关闭\n请在设置中启用 skillsEnabled</div>';
        return;
      }
      const skills = r.skills || [];

      const filter = state.skillsFilter || { q: "", status: "all", source: "all" };
      if (filter.source == null) filter.source = "all";
      if (!state.skillsFilter) state.skillsFilter = filter;

      const container = document.createElement("div");
      container.className = "skills-side";

      // Toolbar: install + search + status + source chips
      const toolbar = document.createElement("div");
      toolbar.className = "skill-filter-bar";
      toolbar.innerHTML =
        `<div class="skill-install-bar">` +
        `<button type="button" class="btn-mini primary" id="skillOpenInstall" title="npx skills add 包装">安装技能…</button>` +
        `</div>` +
        `<input type="search" class="skill-filter-input" id="skillFilterQ" ` +
        `placeholder="搜索名称 / 简介 / 关键词…" autocomplete="off" spellcheck="false" />` +
        `<div class="skill-filter-chips" role="tablist" aria-label="启用状态">` +
        `<button type="button" class="skill-chip" data-status="all">全部</button>` +
        `<button type="button" class="skill-chip" data-status="enabled">已启用</button>` +
        `<button type="button" class="skill-chip" data-status="disabled">已禁用</button>` +
        `</div>` +
        `<div class="skill-filter-chips skill-filter-sources" role="tablist" aria-label="来源">` +
        `<button type="button" class="skill-chip skill-chip-src" data-source="all">来源·全部</button>` +
        `<button type="button" class="skill-chip skill-chip-src" data-source="zcode">zcode</button>` +
        `<button type="button" class="skill-chip skill-chip-src" data-source="agents">agents</button>` +
        `<button type="button" class="skill-chip skill-chip-src" data-source="workspace">工作区</button>` +
        `<button type="button" class="skill-chip skill-chip-src" data-source="core">预装</button>` +
        `<button type="button" class="skill-chip skill-chip-src" data-source="bundled">捆绑</button>` +
        `<button type="button" class="skill-chip skill-chip-src" data-source="plugin">插件</button>` +
        `</div>` +
        `<div class="skill-batch-bar">` +
        `<button type="button" class="btn-mini" id="skillBatchDisable" title="禁用当前列表中的已启用技能">批量禁用</button>` +
        `<button type="button" class="btn-mini" id="skillBatchEnable" title="启用当前列表中的已禁用技能">批量启用</button>` +
        `<span class="skill-batch-hint" id="skillBatchHint"></span>` +
        `</div>`;
      container.appendChild(toolbar);

      toolbar.querySelector("#skillOpenInstall")?.addEventListener("click", (e) => {
        e.stopPropagation();
        openSkillInstallModal();
      });

      if (!skills.length) {
        const empty = EmsoderDom.emptyState(
          "未发现技能\n目录：~/.zcode/skills、~/.agents/skills\n点上方「安装技能…」或外部 npx skills add"
        );
        empty.style.whiteSpace = "pre-wrap";
        container.appendChild(empty);
        sideBody.appendChild(container);
        return;
      }

      const listHost = document.createElement("div");
      listHost.className = "skill-list-host";
      container.appendChild(listHost);

      const stats = document.createElement("div");
      stats.className = "skill-stats";
      container.appendChild(stats);

      const paintList = () => {
        const q = filter.q;
        const status = filter.status || "all";
        const source = filter.source || "all";
        const filtered = skills.filter((s) =>
          _skillFilterMatch(s, q, status, source)
        );
        // 供批量操作：仅当前筛选可见列表
        filter._lastFiltered = filtered;

        // chip active state（状态行 vs 来源行分开）
        toolbar.querySelectorAll(".skill-chip[data-status]").forEach((btn) => {
          btn.classList.toggle("active", btn.dataset.status === status);
        });
        toolbar.querySelectorAll(".skill-chip[data-source]").forEach((btn) => {
          btn.classList.toggle("active", btn.dataset.source === source);
        });

        listHost.innerHTML = "";
        if (!filtered.length) {
          const empty = EmsoderDom.emptyState(
            q.trim()
              ? `无匹配「${q.trim()}」的技能`
              : source !== "all"
                ? `当前来源无技能`
                : status === "disabled"
                  ? "没有已禁用的技能"
                  : "无匹配技能"
          );
          listHost.appendChild(empty);
        } else {
          const groups = new Map();
          for (const s of filtered) {
            const src = s.source || "other";
            if (!groups.has(src)) groups.set(src, []);
            groups.get(src).push(s);
          }
          const order = ["zcode", "agents", "workspace", "core", "bundled", "plugin"];
          for (const src of order) {
            const list = groups.get(src);
            if (!list || !list.length) continue;
            groups.delete(src);
            const sec = document.createElement("div");
            sec.className = "skill-section";
            sec.innerHTML = `<div class="skill-section-title">${_skillSourceLabel(src)} · ${list.length} 个</div>`;
            listHost.appendChild(sec);
            for (const s of list) _appendSkillRow(sec, s, src);
          }
          for (const [src, list] of groups) {
            const sec = document.createElement("div");
            sec.className = "skill-section";
            sec.innerHTML = `<div class="skill-section-title">${escapeHtml(src)} · ${list.length} 个</div>`;
            listHost.appendChild(sec);
            for (const s of list) {
              const row = document.createElement("div");
              row.className = "skill-row" + (s.disabled ? " disabled" : "");
              row.innerHTML =
                `<span class="skill-name">${escapeHtml(s.name)}</span>` +
                `<span class="skill-source">${escapeHtml(src)}</span>`;
              row.addEventListener("click", () => showSkillDetail(s.id || s.name));
              sec.appendChild(row);
            }
          }
        }

        const total = skills.length;
        const enabled = skills.filter((s) => !s.disabled).length;
        const disabled = total - enabled;
        const shown = filtered.length;
        const filtering = !!(q.trim() || status !== "all" || source !== "all");
        stats.textContent = filtering
          ? `显示 ${shown} / ${total} · 已启用 ${enabled} · 已禁用 ${disabled}` +
            (source !== "all" ? ` · 来源 ${source}` : "")
          : `共 ${total} 个 · 已启用 ${enabled} · 已禁用 ${disabled}`;

        const canDisable = filtered.filter((s) => !s.disabled).length;
        const canEnable = filtered.filter((s) => s.disabled).length;
        const btnDis = toolbar.querySelector("#skillBatchDisable");
        const btnEn = toolbar.querySelector("#skillBatchEnable");
        const hint = toolbar.querySelector("#skillBatchHint");
        if (btnDis) btnDis.disabled = canDisable === 0;
        if (btnEn) btnEn.disabled = canEnable === 0;
        if (hint) {
          hint.textContent = filtering
            ? `当前筛选：可禁 ${canDisable} · 可启 ${canEnable}`
            : `可禁 ${canDisable} · 可启 ${canEnable}`;
        }
      };

      const input = toolbar.querySelector("#skillFilterQ");
      input.value = filter.q || "";
      input.addEventListener("input", () => {
        filter.q = input.value;
        state.skillsFilter = filter;
        paintList();
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && input.value) {
          e.stopPropagation();
          input.value = "";
          filter.q = "";
          state.skillsFilter = filter;
          paintList();
        }
      });
      toolbar.querySelectorAll(".skill-chip[data-status]").forEach((btn) => {
        btn.addEventListener("click", () => {
          filter.status = btn.dataset.status || "all";
          state.skillsFilter = filter;
          paintList();
        });
      });
      toolbar.querySelectorAll(".skill-chip[data-source]").forEach((btn) => {
        btn.addEventListener("click", () => {
          filter.source = btn.dataset.source || "all";
          state.skillsFilter = filter;
          paintList();
        });
      });

      const runBatch = async (disabled) => {
        const list = filter._lastFiltered || [];
        const targets = list.filter((s) => !!s.disabled !== !!disabled);
        if (!targets.length) {
          toast(disabled ? "当前列表没有可禁用的技能" : "当前列表没有可启用的技能");
          return;
        }
        const verb = disabled ? "禁用" : "启用";
        if (
          !(await EmsoderDom.showConfirm(
            `确认${verb}当前列表中的 ${targets.length} 个技能？\n（仅影响筛选结果，不是全库）`
          ))
        ) {
          return;
        }
        const ids = targets.map((s) => s.id || s.name).filter(Boolean);
        try {
          if (!emsoder.setSkillsDisabledBatch) {
            // 旧 preload 兜底：逐个调用
            for (const id of ids) await emsoder.setSkillDisabled(id, disabled);
          } else {
            const r = await emsoder.setSkillsDisabledBatch(ids, disabled);
            if (!r?.ok) {
              toast(r?.error || "批量操作失败", true);
              return;
            }
          }
          state.config = await emsoder.getConfig();
          toast(`已${verb} ${ids.length} 个技能`);
          await renderSkillsSide();
        } catch (e) {
          toast(e.message || e, true);
        }
      };
      toolbar
        .querySelector("#skillBatchDisable")
        ?.addEventListener("click", (e) => {
          e.stopPropagation();
          runBatch(true);
        });
      toolbar
        .querySelector("#skillBatchEnable")
        ?.addEventListener("click", (e) => {
          e.stopPropagation();
          runBatch(false);
        });

      sideBody.appendChild(container);
      paintList();
      // keep focus only when user already had query (re-render after toggle)
      if (filter.q) {
        requestAnimationFrame(() => {
          input.focus();
          const len = input.value.length;
          try {
            input.setSelectionRange(len, len);
          } catch {
            /* ignore */
          }
        });
      }
    } catch (e) {
      sideBody.innerHTML = `<div class="tree-empty">${escapeHtml(e.message || e)}</div>`;
    }
  }

  async function toggleSkillDisable(skill, disabled) {
    try {
      await emsoder.setSkillDisabled(skill.id || skill.name, disabled);
      state.config = await emsoder.getConfig();
      toast((disabled ? "已禁用: " : "已启用: ") + skill.name);
    } catch (e) {
      toast(e.message || e, true);
    }
  }

  async function uninstallSkill(skill) {
    try {
      const r = await emsoder.uninstallSkill(skill.id || skill.name);
      if (!r?.ok) {
        toast(r?.error || "卸载失败", true);
        return;
      }
      state.config = await emsoder.getConfig();
      toast(r.message || `已卸载 ${skill.name}`);
    } catch (e) {
      toast(e.message || e, true);
    }
  }

  /** 技能安装向导：包装 npx skills add（main: skillInstall.js） */
  let _skillInstallLogUnsub = null;
  let _skillInstallBusy = false;

  function _skillInstallAppendLog(line) {
    const logEl = $("skillInstallLog");
    if (!logEl) return;
    const t = String(line || "").replace(/\s+$/, "");
    if (!t) return;
    if (logEl.textContent) logEl.textContent += "\n" + t;
    else logEl.textContent = t;
    logEl.classList.add("has-lines");
    logEl.scrollTop = logEl.scrollHeight;
  }

  function _skillInstallSetBusy(busy) {
    _skillInstallBusy = !!busy;
    const run = $("btnSkillInstallRun");
    const cancel = $("btnSkillInstallCancel");
    if (run) {
      run.disabled = !!busy;
      run.textContent = busy ? "安装中…" : "开始安装";
    }
    if (cancel) cancel.disabled = !busy;
  }

  async function openSkillInstallModal() {
    if (!window.emsoder?.installSkill) {
      toast("安装 API 未就绪（请重启应用）", true);
      return;
    }
    const logEl = $("skillInstallLog");
    if (logEl) {
      logEl.textContent = "";
      logEl.classList.remove("has-lines");
    }
    const repo = $("skillInstallRepo");
    const skill = $("skillInstallSkill");
    const g = $("skillInstallGlobal");
    if (repo && !repo.value) repo.value = "";
    if (skill) skill.value = skill.value || "";
    if (g) g.checked = true;

    const host = $("skillInstallPresets");
    if (host) {
      host.innerHTML = '<span style="font-size:11px;color:var(--text-muted)">加载预设…</span>';
      try {
        const pr = await emsoder.skillInstallPresets();
        host.innerHTML = "";
        const list = pr?.presets || [];
        if (!list.length) {
          host.innerHTML =
            '<span style="font-size:11px;color:var(--text-muted)">无内置预设，请手填仓库</span>';
        } else {
          for (const p of list) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "skill-preset-btn";
            b.innerHTML =
              `<span>${escapeHtml(p.label || p.repo)}</span>` +
              (p.hint ? `<span class="hint">${escapeHtml(p.hint)}</span>` : "");
            b.title = p.repo + (p.skill ? ` --skill ${p.skill}` : "");
            b.addEventListener("click", () => {
              if ($("skillInstallRepo")) $("skillInstallRepo").value = p.repo || "";
              if ($("skillInstallSkill")) $("skillInstallSkill").value = p.skill || "";
            });
            host.appendChild(b);
          }
        }
      } catch (e) {
        host.innerHTML = `<span style="font-size:11px;color:#f87171">${escapeHtml(
          e.message || e
        )}</span>`;
      }
    }

    if (_skillInstallLogUnsub) {
      try {
        _skillInstallLogUnsub();
      } catch {
        /* ignore */
      }
      _skillInstallLogUnsub = null;
    }
    if (typeof emsoder.onSkillInstallLog === "function") {
      _skillInstallLogUnsub = emsoder.onSkillInstallLog((data) => {
        _skillInstallAppendLog(data?.line || data);
      });
    }

    try {
      const st = await emsoder.skillInstallStatus?.();
      _skillInstallSetBusy(!!st?.running);
    } catch {
      _skillInstallSetBusy(false);
    }

    openModal("modalSkillInstall");
    requestAnimationFrame(() => $("skillInstallRepo")?.focus());
  }

  async function runSkillInstallFromModal() {
    if (_skillInstallBusy) return;
    if (!window.emsoder?.installSkill) {
      toast("安装 API 未就绪", true);
      return;
    }
    const repo = ($("skillInstallRepo")?.value || "").trim();
    const skillName = ($("skillInstallSkill")?.value || "").trim();
    const global = !!$("skillInstallGlobal")?.checked;
    if (!repo) {
      toast("请填写 owner/repo", true);
      return;
    }
    const logEl = $("skillInstallLog");
    if (logEl) {
      logEl.textContent = "";
      logEl.classList.remove("has-lines");
    }
    _skillInstallSetBusy(true);
    _skillInstallAppendLog(`$ npx skills add ${repo}${skillName ? " --skill " + skillName : ""}${global ? " -g" : ""}`);
    try {
      const r = await emsoder.installSkill({
        repo,
        skill: skillName || undefined,
        global,
      });
      if (r?.cmd) _skillInstallAppendLog(`[cmd] ${r.cmd}`);
      if (r?.ok) {
        _skillInstallAppendLog("安装完成。");
        toast("技能安装完成，正在刷新列表");
        try {
          state.config = await emsoder.getConfig();
        } catch {
          /* ignore */
        }
        if (state.sideView === "skills") await renderSkillsSide();
      } else {
        _skillInstallAppendLog(r?.error || "安装失败");
        if (r?.stderr) _skillInstallAppendLog(r.stderr.slice(-2000));
        toast(r?.error || "安装失败", true);
      }
    } catch (e) {
      _skillInstallAppendLog(e.message || String(e));
      toast(e.message || e, true);
    } finally {
      _skillInstallSetBusy(false);
    }
  }

  async function cancelSkillInstallFromModal() {
    try {
      const r = await emsoder.cancelSkillInstall?.();
      if (!r?.ok) toast(r?.error || "无法取消", true);
      else {
        _skillInstallAppendLog("已请求取消…");
        toast("已请求取消安装");
      }
    } catch (e) {
      toast(e.message || e, true);
    }
  }

  function wireSkillInstallModal() {
    $("btnSkillInstallRun")?.addEventListener("click", () => runSkillInstallFromModal());
    $("btnSkillInstallCancel")?.addEventListener("click", () => cancelSkillInstallFromModal());
    // 关闭时保留 unsub 到下次打开再绑，避免泄漏重复 listener
    document.querySelectorAll('[data-close="modalSkillInstall"]').forEach((el) => {
      el.addEventListener("click", () => {
        if (_skillInstallLogUnsub) {
          try {
            _skillInstallLogUnsub();
          } catch {
            /* ignore */
          }
          _skillInstallLogUnsub = null;
        }
      });
    });
  }

  async function showSkillDetail(id) {
    try {
      const r = await emsoder.readSkill(id);
      if (!r?.ok) {
        toast(r?.error || "读取失败", true);
        return;
      }
      // Build detail view in sideBody
      sideTitle.textContent = r.name || id;
      sideBody.innerHTML = "";
      const container = document.createElement("div");
      container.style.cssText = "padding:12px;overflow:auto;flex:1;";

      // Header row: name + source badge
      const header = document.createElement("div");
      header.className = "skill-detail-header";
      header.innerHTML =
        `<strong style="font-size:14px">${escapeHtml(r.name || id)}</strong>` +
        (r.source ? `<span class="skill-badge ${escapeHtml(r.source)}">${_skillSourceLabel(r.source)}</span>` : "");
      container.appendChild(header);

      // English description
      if (r.description) {
        const desc = document.createElement("div");
        desc.style.cssText = "font-size:12px;color:var(--text);margin-bottom:6px;line-height:1.5;";
        desc.textContent = r.description;
        container.appendChild(desc);
      }

      // Chinese description (if available)
      if (r.cnDescription) {
        const cn = document.createElement("div");
        cn.style.cssText =
          "font-size:12px;color:var(--sky-300);background:rgba(14,165,233,0.08);padding:8px 10px;border-radius:8px;margin-bottom:10px;line-height:1.6;border-left:3px solid var(--sky-400);";
        cn.textContent = "📖 " + r.cnDescription;
        container.appendChild(cn);
      }

      // Trigger keywords
      if (r.triggers && r.triggers.length > 0) {
        const trigSec = document.createElement("div");
        trigSec.style.cssText = "margin-bottom:10px;";
        const trigLabel = document.createElement("div");
        trigLabel.style.cssText =
          "font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;";
        trigLabel.textContent = "触发关键词";
        trigSec.appendChild(trigLabel);
        const tags = document.createElement("div");
        tags.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;";
        for (const t of r.triggers) {
          const tag = document.createElement("span");
          tag.style.cssText =
            "font-size:10px;padding:2px 8px;border-radius:999px;border:1px solid var(--border);color:var(--text-muted);white-space:nowrap;";
          tag.textContent = t;
          tags.appendChild(tag);
        }
        trigSec.appendChild(tags);
        container.appendChild(trigSec);
      }

      // Directory
      if (r.dir) {
        const dir = document.createElement("div");
        dir.style.cssText =
          "font-size:10px;color:var(--text-muted);margin-bottom:8px;word-break:break-all;";
        dir.textContent = "📁 " + r.dir;
        container.appendChild(dir);
      }

      // Full SKILL.md body
      const bodyLabel = document.createElement("div");
      bodyLabel.style.cssText =
        "font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;";
      bodyLabel.textContent = "SKILL.md 原文";
      container.appendChild(bodyLabel);
      const body = document.createElement("div");
      body.className = "skill-detail-body";
      body.textContent = r.content || "(无内容)";
      container.appendChild(body);

      // Back button
      const back = document.createElement("button");
      back.className = "btn";
      back.style.cssText = "margin-top:10px;";
      back.textContent = "← 返回列表";
      back.addEventListener("click", () => renderSkillsSide());
      container.appendChild(back);

      sideBody.appendChild(container);
    } catch (e) {
      toast(e.message || e, true);
    }
  }

  function renderSearchSide() {
    sideTitle.textContent = "搜索";
    sideBody.innerHTML = "";

    const form = document.createElement("div");
    form.style.padding = "12px";

    const qField = document.createElement("div");
    qField.className = "field";
    const qLabel = document.createElement("label");
    qLabel.textContent = "关键词";
    const qInput = document.createElement("input");
    qInput.id = "searchQuery";
    qInput.placeholder = "在工作区搜索…";
    qField.appendChild(qLabel);
    qField.appendChild(qInput);
    form.appendChild(qField);

    const globField = document.createElement("div");
    globField.className = "field";
    const globLabel = document.createElement("label");
    globLabel.textContent = "扩展过滤";
    const globInput = document.createElement("input");
    globInput.id = "searchGlob";
    globInput.placeholder = ".js / .ts";
    globField.appendChild(globLabel);
    globField.appendChild(globInput);
    form.appendChild(globField);

    const btnSearch = document.createElement("button");
    btnSearch.className = "btn primary";
    btnSearch.id = "btnDoSearch";
    btnSearch.style.width = "100%";
    btnSearch.textContent = "搜索";
    form.appendChild(btnSearch);

    const meta = document.createElement("div");
    meta.id = "searchMeta";
    meta.style.cssText = "margin-top:8px;font-size:11px;color:var(--text-muted)";
    form.appendChild(meta);

    const results = document.createElement("div");
    results.id = "searchResults";
    results.style.cssText = "margin-top:8px;user-select:text";
    form.appendChild(results);

    const btnMore = document.createElement("button");
    btnMore.className = "btn";
    btnMore.id = "btnSearchMore";
    btnMore.style.cssText = "width:100%;margin-top:8px;display:none";
    btnMore.textContent = "加载更多";
    form.appendChild(btnMore);

    sideBody.appendChild(form);

    const PAGE = 40;
    let allResults = [];
    let shown = 0;
    const paintPage = () => {
      const box = $("searchResults");
      const more = $("btnSearchMore");
      const metaEl = $("searchMeta");
      if (!box) return;
      const slice = allResults.slice(shown, shown + PAGE);
      for (const r of slice) {
        const btn = document.createElement("button");
        btn.className = "search-hit";
        btn.innerHTML = `<div class="path">${escapeHtml(r.relative)}:${r.line}</div><div class="line">${escapeHtml(r.text)}</div>`;
        btn.onclick = () => openFile(r.path, r.line);
        box.appendChild(btn);
      }
      shown += slice.length;
      if (metaEl) {
        metaEl.textContent = allResults.length
          ? `显示 ${shown} / ${allResults.length}`
          : "";
      }
      if (more) more.style.display = shown < allResults.length ? "block" : "none";
    };
    const run = async () => {
      const q = $("searchQuery").value.trim();
      const box = $("searchResults");
      if (!q) return;
      if (!state.workspace) {
        box.replaceChildren(EmsoderDom.emptyState("请先打开工作区"));
        return;
      }
      box.replaceChildren(EmsoderDom.emptyState("搜索中…"));
      if ($("searchMeta")) $("searchMeta").textContent = "";
      if ($("btnSearchMore")) $("btnSearchMore").style.display = "none";
      try {
        const out = await emsoder.search({
          query: q,
          glob: $("searchGlob").value.trim(),
          maxResults: 200,
        });
        box.replaceChildren();
        allResults = [];
        shown = 0;
        if (!out.ok) {
          box.appendChild(EmsoderDom.emptyState(out.error || "搜索失败"));
          return;
        }
        if (!out.results.length) {
          box.appendChild(EmsoderDom.emptyState(`没有匹配 “${q}”`));
          return;
        }
        allResults = out.results;
        paintPage();
      } catch (err) {
        box.replaceChildren(EmsoderDom.emptyState(err.message || String(err)));
      }
    };
    $("btnDoSearch").onclick = run;
    $("btnSearchMore").onclick = () => paintPage();
    $("searchQuery").addEventListener("keydown", (e) => {
      if (e.key === "Enter") run();
    });
  }

  function renderGitSide() {
    sideTitle.textContent = "Git";
    sideBody.innerHTML = "";
    sideBody.appendChild(
      EmsoderDom.emptyState("完整 Git 面板在底部「Git」标签。点击下方按钮打开。")
    );
    const btn = document.createElement("button");
    btn.className = "btn primary";
    btn.style.margin = "0 16px";
    btn.style.width = "calc(100% - 32px)";
    btn.textContent = "打开底部 Git";
    btn.onclick = () => {
      $("bottomPanel")?.classList.remove("collapsed");
      EmsoderPanels.showTab("git");
    };
    sideBody.appendChild(btn);
  }

  // ---------- MCP sidebar ----------
  const mcpStatusLabel = {
    running: "已连接",
    connecting: "连接中…",
    stopped: "未连接",
    error: "失败",
  };

  /** zcode 风格预设（字段与 mcp:upsert 归一化一致） */
  const MCP_PRESETS = {
    context7: {
      name: "Context7",
      type: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      hint: "文档/依赖问答，自动检索最新库文档",
    },
    filesystem: {
      name: "Filesystem",
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      hint: "本机文件读写（参数填一个可访问目录）",
    },
    playwright: {
      name: "Playwright",
      type: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      hint: "浏览器自动化：打开页面、点击、截图",
    },
    fetch: {
      name: "Fetch",
      type: "stdio",
      command: "npx",
      args: ["-y", "mcp-server-fetch"],
      hint: "抓取网页并转 Markdown",
    },
    memory: {
      name: "Memory",
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
      hint: "知识图谱长期记忆",
    },
    github: {
      name: "GitHub",
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer " },
      hint: "GitHub 仓库/Issue/PR（需 Personal Access Token）",
    },
  };

  function syncMcpFormType(type) {
    const isHttp = type === "http";
    document.querySelectorAll(".mcp-field-stdio").forEach((el) => {
      el.style.display = isHttp ? "none" : "";
    });
    document.querySelectorAll(".mcp-field-http").forEach((el) => {
      el.style.display = isHttp ? "" : "none";
    });
  }

  function openMcpEdit(server) {
    $("mcpEditTitle").textContent = server ? "编辑 MCP Server" : "添加 MCP Server";
    $("mpPreset").value = "";
    $("mpId").value = server?.id || "";
    $("mpId").disabled = !!server;
    $("mpName").value = server?.name || "";
    $("mpType").value = server?.type === "http" ? "http" : "stdio";
    $("mpCommand").value = server?.command || "";
    $("mpArgs").value = (server?.args || []).join(",");
    $("mpCwd").value = server?.cwd || "";
    $("mpUrl").value = server?.url || "";
    $("mpHeaders").value = Object.entries(server?.headers || {})
      .map(([k, v]) => k + ": " + v)
      .join("\n");
    $("mpEnv").value = Object.entries(server?.env || {})
      .map(([k, v]) => k + "=" + v)
      .join("\n");
    $("mpTimeout").value = server?.timeoutMs ? Math.round(server.timeoutMs / 1000) : 30;
    $("mpEnabled").value = server?.enabled === false ? "false" : "true";
    syncMcpFormType($("mpType").value);
    openModal("modalMcpEdit");
  }

  $("mpPreset")?.addEventListener("change", () => {
    const p = MCP_PRESETS[$("mpPreset").value];
    if (!p) return;
    if (!$("mpId").disabled) $("mpId").value = p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    $("mpName").value = p.name;
    $("mpType").value = p.type === "http" ? "http" : "stdio";
    $("mpCommand").value = p.command || "";
    $("mpArgs").value = (p.args || []).join(",");
    $("mpCwd").value = "";
    $("mpUrl").value = p.url || "";
    $("mpHeaders").value = Object.entries(p.headers || {})
      .map(([k, v]) => k + ": " + v)
      .join("\n");
    $("mpTimeout").value = 30;
    syncMcpFormType($("mpType").value);
  });

  $("mpType")?.addEventListener("change", () => syncMcpFormType($("mpType").value));

  function parseHeaderLines(text) {
    const out = {};
    for (const line of String(text || "").split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const ci = t.indexOf(":");
      if (ci > 0) out[t.slice(0, ci).trim()] = t.slice(ci + 1).trim();
    }
    return out;
  }

  function parseEnvLines(text) {
    const out = {};
    for (const line of String(text || "").split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const eq = t.indexOf("=");
      if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return out;
  }

  $("btnSaveMcp")?.addEventListener("click", async () => {
    const id = $("mpId").value.trim();
    const type = $("mpType").value === "http" ? "http" : "stdio";
    const command = $("mpCommand").value.trim();
    const url = $("mpUrl").value.trim();
    if (!id || (type === "stdio" ? !command : !url)) {
      toast(type === "stdio" ? "请填写 ID 和命令" : "请填写 ID 和 URL", true);
      return;
    }
    const server = {
      id,
      name: $("mpName").value.trim() || id,
      type,
      command,
      args: $("mpArgs")
        .value.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      cwd: $("mpCwd").value.trim(),
      url,
      headers: parseHeaderLines($("mpHeaders").value),
      env: parseEnvLines($("mpEnv").value),
      timeoutMs: (Number($("mpTimeout").value) || 30) * 1000,
      enabled: $("mpEnabled").value === "true",
    };
    try {
      const r = await emsoder.upsertMcpServer(server);
      if (r?.ok === false) {
        toast(r.error || "保存失败", true);
        return;
      }
      closeModal("modalMcpEdit");
      toast("已保存 MCP Server");
      await renderMcpSide();
    } catch (e) {
      toast(e.message || e, true);
    }
  });

  async function renderMcpSide() {
    sideTitle.textContent = "MCP";
    sideBody.innerHTML = '<div class="tree-empty">加载中…</div>';
    let data;
    try {
      data = await emsoder.listMcpServers();
    } catch (e) {
      sideBody.replaceChildren(EmsoderDom.emptyState(e.message || "MCP 未就绪"));
      return;
    }
    const servers = data?.servers || [];
    sideBody.innerHTML = "";

    const toolbar = document.createElement("div");
    toolbar.className = "session-toolbar";
    const addBtn = document.createElement("button");
    addBtn.className = "btn primary btn-new-session";
    addBtn.type = "button";
    addBtn.textContent = "＋ 添加 MCP Server";
    addBtn.onclick = () => openMcpEdit(null);
    toolbar.appendChild(addBtn);
    sideBody.appendChild(toolbar);

    if (!servers.length) {
      sideBody.appendChild(
        EmsoderDom.emptyState(
          "没有配置 MCP Server。\n点上方「添加 MCP Server」用预设一键填充，例如：\nContext7（文档问答）、Filesystem（本机文件）、\nPlaywright（浏览器）、GitHub（HTTP）。"
        )
      );
      return;
    }

    const list = document.createElement("div");
    list.className = "mcp-server-list";
    for (const s of servers) {
      const card = document.createElement("div");
      card.className = "mcp-server-card" + (s.enabled ? "" : " disabled");
      card.dataset.id = s.id;

      const head = document.createElement("div");
      head.className = "mcp-server-head";
      const dot = document.createElement("span");
      dot.className = "mcp-status-dot " + s.status;
      dot.title = mcpStatusLabel[s.status] || s.status;
      const name = document.createElement("span");
      name.className = "mcp-server-name";
      name.textContent = s.name || s.id;
      name.title = s.id;
      const typeBadge = document.createElement("span");
      typeBadge.className = "mcp-type-badge";
      typeBadge.textContent = s.type === "http" ? "HTTP" : "stdio";
      const badge = document.createElement("span");
      badge.className = "mcp-tool-count";
      badge.textContent = s.toolCount + " 工具";
      head.appendChild(dot);
      head.appendChild(name);
      head.appendChild(typeBadge);
      head.appendChild(badge);
      if (s.enabled === false) {
        const off = document.createElement("span");
        off.className = "session-mode-badge";
        off.textContent = "已禁用";
        head.appendChild(off);
      }
      card.appendChild(head);

      const cmd = document.createElement("div");
      cmd.className = "mcp-server-cmd";
      cmd.textContent =
        s.type === "http"
          ? s.url || ""
          : [s.command, ...(s.args || [])].join(" ");
      cmd.title = cmd.textContent;
      card.appendChild(cmd);

      if (s.status === "error" && s.error) {
        const err = document.createElement("div");
        err.className = "mcp-server-error";
        err.textContent = "失败: " + s.error;
        card.appendChild(err);
      }

      const actions = document.createElement("div");
      actions.className = "list-actions mcp-server-actions";
      const mkBtn = (label, cls, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn" + (cls ? " " + cls : "");
        b.textContent = label;
        b.onclick = async (e) => {
          e.stopPropagation();
          await fn();
        };
        actions.appendChild(b);
        return b;
      };
      if (s.status === "running") {
        mkBtn("断开", "", async () => {
          try {
            await emsoder.disconnectMcp(s.id);
            toast("已断开 " + s.name);
          } catch (e2) {
            toast(e2.message || e2, true);
          }
          await renderMcpSide();
        });
      } else {
        mkBtn(s.status === "connecting" ? "连接中…" : "连接", "primary", async () => {
          const r = await emsoder.connectMcp(s.id);
          if (r?.ok === false) {
            toast(r.error || "连接失败", true);
          } else {
            toast("已连接 " + s.name);
          }
          await renderMcpSide();
        });
      }
      mkBtn("编辑", "", () => openMcpEdit(s));
      mkBtn("删", "danger", async () => {
        if (!(await EmsoderDom.showConfirm("删除 MCP Server「" + (s.name || s.id) + "」？"))) return;
        try {
          await emsoder.removeMcpServer(s.id);
          toast("已删除");
        } catch (e2) {
          toast(e2.message || e2, true);
        }
        await renderMcpSide();
      });
      card.appendChild(actions);

      // 工具列表（点击卡片展开）
      const tools = document.createElement("div");
      tools.className = "mcp-tool-list";
      tools.hidden = true;
      if (s.tools?.length) {
        for (const t of s.tools) {
          const row = document.createElement("div");
          row.className = "mcp-tool-row";
          const tn = document.createElement("span");
          tn.className = "mcp-tool-name";
          tn.textContent = t.fullName || t.name || "";
          tn.title = t.description || "";
          row.appendChild(tn);
          if (t.description) {
            const td = document.createElement("span");
            td.className = "mcp-tool-desc";
            td.textContent = t.description;
            row.appendChild(td);
          }
          tools.appendChild(row);
        }
      } else {
        tools.appendChild(
          EmsoderDom.emptyState(
            s.status === "running" ? "暂无工具（server 未返回）" : "连接后自动加载工具"
          )
        );
      }
      const toggleTools = (e) => {
        if (e.target.closest(".mcp-server-actions")) return;
        tools.hidden = !tools.hidden;
      };
      card.addEventListener("click", toggleTools);
      card.appendChild(tools);

      list.appendChild(card);
    }
    sideBody.appendChild(list);
    const hint = document.createElement("div");
    hint.className = "mcp-side-hint";
    hint.textContent =
      "MCP 工具（mcp__ 前缀）会自动加入 Agent 工具列表；支持 stdio 与 streamable HTTP。";
    sideBody.appendChild(hint);
  }

  async function refreshMcpSideIfVisible() {
    if (state.sideView !== "mcp") return;
    try {
      await renderMcpSide();
    } catch {
      /* ignore */
    }
  }

  // ---------- Chat ----------
  function clearWelcome() {
    messagesEl.querySelector(".welcome")?.remove();
  }

  function branchMetaMap(list, branchMeta) {
    const map = new Map();
    for (const b of branchMeta || []) map.set(b.id, b);
    return map;
  }

  function addMsg(role, text, toolName, opts = {}) {
    clearWelcome();

    // tool / reasoning → collapsible details (default collapsed)
    // tool 在 makeFoldDetails 中已隐藏，不进入聊天区
    if (role === "tool" || role === "reasoning") {
      const label =
        role === "reasoning"
          ? "思考过程"
          : toolName
            ? `工具 · ${toolName}`
            : "工具调用";
      const details = makeFoldDetails(
        role === "reasoning" ? "reasoning" : "tool",
        label,
        text,
        toolName || "",
        { noMount: !!opts.noMount || role === "tool" }
      );
      if (opts.messageId) details.dataset.mid = opts.messageId;
      if (opts.forceOpen === true) details.open = true;
      if (role !== "tool") {
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "msg-btn fold-copy";
        copyBtn.textContent = "复制";
        copyBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          copyText(text || "");
        };
        details.querySelector("summary")?.appendChild(copyBtn);
      }
      if (opts.noMount || role === "tool") return details;
      return details.querySelector(".fold-body");
    }

    // 助手占位「调用工具: xxx」不展示（历史重放 / 虚拟列表）
    if (role === "assistant" && isToolCallPlaceholderText(text)) {
      const dummy = document.createElement("div");
      dummy.className = "msg assistant hide-tool-call";
      dummy.hidden = true;
      dummy.style.display = "none";
      dummy.dataset.role = "assistant";
      dummy.dataset.raw = text || "";
      if (opts.messageId) dummy.dataset.mid = opts.messageId;
      if (typeof opts.tocIndex === "number") dummy.dataset.tocIndex = String(opts.tocIndex);
      return dummy;
    }

    const div = document.createElement("div");
    div.className = "msg " + (role === "error" ? "error" : role);
    if (opts.messageId) div.dataset.mid = opts.messageId;
    div.dataset.role = role;
    div.dataset.raw = text || "";

    const roleEl = document.createElement("div");
    roleEl.className = "role";
    const left = document.createElement("span");
    left.textContent = toolName ? "tool · " + toolName : role;
    roleEl.appendChild(left);

    const right = document.createElement("span");
    right.className = "msg-actions";
    if (role === "assistant") {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "EMSoder";
      right.appendChild(tag);
    }
    // branch navigator on forked messages
    if (opts.siblingCount > 1) {
      const nav = document.createElement("span");
      nav.className = "branch-nav";
      const prev = document.createElement("button");
      prev.type = "button";
      prev.className = "branch-btn";
      prev.title = "上一个分支";
      prev.textContent = "‹";
      prev.onclick = (e) => {
        e.stopPropagation();
        switchBranchAt(opts.messageId, "prev");
      };
      const label = document.createElement("span");
      label.className = "branch-label";
      label.textContent =
        (opts.siblingIndex + 1) + "/" + opts.siblingCount;
      const next = document.createElement("button");
      next.type = "button";
      next.className = "branch-btn";
      next.title = "下一个分支";
      next.textContent = "›";
      next.onclick = (e) => {
        e.stopPropagation();
        switchBranchAt(opts.messageId, "next");
      };
      nav.appendChild(prev);
      nav.appendChild(label);
      nav.appendChild(next);
      right.appendChild(nav);
    }
    if (role === "user" && opts.messageId) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "msg-btn";
      editBtn.title = "编辑并重新发送（保留旧回答为分支）";
      editBtn.textContent = "编辑";
      editBtn.onclick = (e) => {
        e.stopPropagation();
        beginEditMessage(opts.messageId, text);
      };
      right.appendChild(editBtn);
    }
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "msg-btn";
    copyBtn.title = "复制";
    copyBtn.textContent = "复制";
    copyBtn.onclick = (e) => {
      e.stopPropagation();
      copyText(text || "");
    };
    right.appendChild(copyBtn);
    roleEl.appendChild(right);

    const body = document.createElement("div");
    body.className = "body";
    if (opts.markdown && role === "assistant") setMsgBody(body, text, true);
    else body.textContent = text;

    div.appendChild(roleEl);
    div.appendChild(body);
    if (opts.tocIndex != null) div.dataset.tocIndex = String(opts.tocIndex);
    if (!div.dataset.tocId) {
      div.dataset.tocId = opts.messageId || `live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    }
    if (opts.noMount) return div;
    getChatMount().appendChild(div);
    scrollMessagesEnd();
    // 新消息进目录（用户 / AI / 错误）
    if (role === "user" || role === "assistant" || role === "error") {
      try {
        refreshChatToc();
      } catch {
        /* ignore */
      }
    }
    return body;
  }

  const copyText = (t) => EmsoderDom.copyText(t);

  async function switchBranchAt(messageId, direction) {
    if (state.generating) {
      toast("生成中，请先停止", true);
      return;
    }
    try {
      const session = await emsoder.switchBranch(messageId, direction);
      state.branchMeta = session.branchMeta || [];
      renderHistory(session.messages || [], session.branchMeta);
      renderChatChanges(session.fileChanges || [], session.id || null);
      toast("已切换分支");
    } catch (e) {
      toast(e.message || e, true);
    }
  }

  function beginEditMessage(messageId, content) {
    if (state.generating) {
      toast("生成中，请先停止", true);
      return;
    }
    state.editMessageId = messageId;
    inputEl.value = content || "";
    updateEditBanner();
    inputEl.focus();
    toast("编辑模式：发送将创建新分支，旧回答保留");
  }

  function cancelEditMode() {
    state.editMessageId = null;
    updateEditBanner();
  }

  function updateEditBanner() {
    let bar = $("editBanner");
    if (!state.editMessageId) {
      bar?.classList.remove("show");
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "editBanner";
      bar.className = "edit-banner";
      const composer = $("chatComposer") || inputEl.parentElement;
      composer?.parentElement?.insertBefore(bar, composer);
    }
    bar.innerHTML =
      '<span>编辑并重新发送 · 将新建分支并保留历史回答</span><button type="button" class="btn" id="btnCancelEdit">取消</button>';
    bar.classList.add("show");
    $("btnCancelEdit")?.addEventListener("click", () => {
      cancelEditMode();
      toast("已取消编辑");
    });
  }

  function ensureChatVlist() {
    if (chatVlist) return chatVlist;
    if (!window.EmsoderChatVirtual?.createChatVirtualList) return null;
    chatVlist = EmsoderChatVirtual.createChatVirtualList(messagesEl, {
      renderItem: (m, _idx) => {
        // 虚拟列表窗口内也不渲染工具调用 / 占位
        if (shouldHideFromChatUi(m?.role, m?.content)) return null;
        const meta = branchMetaMap(
          state._histList || [],
          state._histMeta || state.branchMeta
        );
        const b = meta.get(m.id) || {};
        const opts = {
          messageId: m.id,
          siblingIndex: b.siblingIndex || 0,
          siblingCount: b.siblingCount || 1,
          markdown: m.role === "assistant",
          noMount: true,
          tocIndex: _idx,
        };
        if (m.role === "assistant") {
          return addMsg("assistant", m.content, null, opts);
        }
        return addMsg(m.role, m.content, m.toolName, opts);
      },
    });
    return chatVlist;
  }

  function renderHistory(list, branchMeta) {
    if (!list?.length) {
      chatVlist?.clear?.();
      state._histList = [];
      messagesEl.innerHTML = `
        <div class="welcome">
          <div class="logo-lg"><div class="e-tiles"><div class="tile v"></div><div class="tile th"></div><div class="tile mh"></div><div class="tile bh"></div></div></div>
          <h2>今天想写点什么？</h2>
          <div>Agent · 终端 · Git · 项目规则 · Monaco</div>
          <div class="free-badge">FREE · NO CREDITS · BYOK</div>
          <div class="welcome-tip">输入 @path 引用文件；右键消息可复制；用户消息可编辑重发并保留分支</div>
        </div>`;
      refreshChatToc();
      return;
    }
    const meta = branchMetaMap(list, branchMeta || state.branchMeta);
    state._histList = list;
    state._histMeta = branchMeta || state.branchMeta;
    const vl = ensureChatVlist();
    if (vl) {
      vl.setItems(list);
      refreshChatToc();
      return;
    }
    // fallback：无虚拟列表模块时全量渲染
    messagesEl.innerHTML = "";
    list.forEach((m, i) => {
      const b = meta.get(m.id) || {};
      const opts = {
        messageId: m.id,
        siblingIndex: b.siblingIndex || 0,
        siblingCount: b.siblingCount || 1,
        markdown: m.role === "assistant",
        tocIndex: i,
      };
      if (m.role === "assistant") {
        addMsg("assistant", m.content, null, opts);
      } else {
        addMsg(m.role, m.content, m.toolName, opts);
      }
    });
    refreshChatToc();
  }

  /** 本轮 Agent 写盘摘要 UI（对齐 Quest Changes） */
  function renderChatChanges(fileChanges, sessionId = null) {
    if (Array.isArray(fileChanges)) state.fileChanges = fileChanges;
    if (sessionId !== null) state.fileChangesSessionId = sessionId || null;
    const box = $("chatChanges");
    const listEl = $("chatChangesList");
    const countEl = $("chatChangesCount");
    if (!box || !listEl) return;
    const files = state.fileChanges || [];
    if (!files.length) {
      box.hidden = true;
      listEl.innerHTML = "";
      if (countEl) countEl.textContent = "0";
      return;
    }
    box.hidden = false;
    const active = files.filter((f) => !f.rejected);
    if (countEl) countEl.textContent = String(active.length || files.length);
    listEl.innerHTML = "";
    for (const f of files) {
      const row = document.createElement("div");
      row.className = "chat-change-row" + (f.rejected ? " rejected" : "");
      row.innerHTML =
        `<span class="kind-badge"></span>` +
        `<span class="path" title=""></span>` +
        `<button type="button" class="tb-mini" data-a="diff">对比</button>` +
        `<button type="button" class="tb-mini" data-a="open">打开</button>` +
        `<button type="button" class="tb-mini" data-a="reject" ${
          f.rejected ? "disabled" : ""
        }>撤销</button>`;
      const kindEl = row.querySelector(".kind-badge");
      kindEl.textContent = f.kind || "edit";
      const pathEl = row.querySelector(".path");
      pathEl.textContent = f.relative || f.path;
      pathEl.title = f.path || "";
      const open = () => {
        if (f.path) openFile(f.path);
      };
      pathEl.onclick = open;
      row.querySelector('[data-a="open"]').onclick = open;
      row.querySelector('[data-a="diff"]').onclick = () => showFileChangeDiff(f);
      row.querySelector('[data-a="reject"]').onclick = async () => {
        if (f.rejected) return;
        if (!(await EmsoderDom.showConfirm("回滚该文件到本轮写前内容？"))) return;
        try {
          const sessionId = state.fileChangesSessionId || null;
          const r = await emsoder.rejectAgentChange(f.path, sessionId);
          renderChatChanges(r.fileChanges || [], sessionId);
          if (r?.ok === false) {
            toast(r?.code === "STALE_FILE" ? "文件已被你或其他工具改过，未撤销" : (r?.error || "撤销失败"), true);
            return;
          }
          if (f.path && state.tabs.some((t) => t.path === f.path)) {
            try {
              const file = await emsoder.readFile(f.path);
              const tab = state.tabs.find((t) => t.path === f.path);
              if (tab && file) {
                tab.content = file.content;
                tab.original = file.content;
                tab.dirty = false;
                if (state.activePath === f.path && window.EmsoderEditor) {
                  EmsoderEditor.setValue(file.content);
                }
                renderTabs();
              }
            } catch {
              /* 创建类回滚可能已删文件 */
            }
          }
          toast("已撤销");
        } catch (err) {
          toast(err.message || String(err), true);
        }
      };
      listEl.appendChild(row);
    }
  }

  async function showFileChangeDiff(f) {
    if (!f?.path) return;
    try {
      const r = await emsoder.getAgentFileChangeDiff(f.path, state.fileChangesSessionId || null);
      if (!r?.ok) {
        toast(r?.error || "无法加载对比", true);
        return;
      }
      const title = $("diffModalTitle");
      const body = $("diffModalBody");
      const meta = $("diffModalMeta");
      if (title) title.textContent = r.relative || r.path || "对比";
      if (meta) {
        meta.textContent =
          (r.kind || "edit") +
          (r.truncated ? " · 内容已截断" : "") +
          (r.rejected ? " · 已撤销" : "");
      }
      if (body) {
        body.textContent = r.diff || "(无差异)";
        body.classList.add("diff-pre");
      }
      openModal("modalFileDiff");
    } catch (e) {
      toast(e.message || String(e), true);
    }
  }

  async function sendMessage(prefill) {
    const typed = (prefill != null ? prefill : inputEl.value).trim();
    const pack = buildAttachmentPayload();
    let extraAttachments = [];
    if (state.workspace && /\s@[^\s@]/.test(typed)) {
      try {
        extraAttachments = await resolveAtMentions(typed);
      } catch { /* ignore */ }
    }
    const modelText = [typed, pack.modelText].filter(Boolean).join("\n\n");
    const displayText = [typed, pack.displayText].filter(Boolean).join("\n\n");
    if (!modelText) return;
    if (!state.config?.activeModel) {
      toast("请先选择模型", true);
      showModels();
      return;
    }
    if (prefill == null) inputEl.value = "";
    const attachments = [...(pack.attachments || []), ...extraAttachments];
    if (state.attachments?.length) {
      state.attachments = [];
      renderAttachments();
    }

    // Ensure a PTY exists so agent tools can mirror output
    EmsoderPanels.ensureTerm?.().catch(() => {});

    const editorCtx = {
      workspaceRoot: state.workspace,
      activeFile: state.activePath || "",
      selection: getSelectionOrEmpty(),
      openTabs: state.tabs.map((t) => t.path),
      language: state.monacoReady ? EmsoderEditor.getLanguage() : "",
      cursorLine: state.monacoReady ? EmsoderEditor.getCursorLine() : undefined,
      attachments,
      displayText,
    };

    if (state.editMessageId) {
      if (state.generating) {
        toast("生成中请先停止再编辑重发", true);
        return;
      }
      const mid = state.editMessageId;
      cancelEditMode();
      setGenerating(true, "生成中");
      emsoder
        .branchEdit({
          messageId: mid,
          text: modelText,
          displayText,
          attachments,
          ...editorCtx,
        })
        .catch((e) => {
          setGenerating(false, "失败");
          toast(e.message || e, true);
        });
      return;
    }

    const wasBusy = state.generating || state.queueDepth > 0;
    if (wasBusy) {
      state.queueDepth += 1;
      setQueueDepth(state.queueDepth);
      toast("已加入任务队列");
    } else {
      setGenerating(true, "生成中");
    }
    emsoder.sendAgent({
      text: modelText,
      displayText,
      attachments,
      ...editorCtx,
    });
  }

  // Context menu on chat messages
  const hideMsgMenu = () => EmsoderDom.hideCtxMenu("msgCtxMenu");

  function showMsgMenu(x, y, items) {
    EmsoderDom.showCtxMenu(x, y, items, "msgCtxMenu");
  }

  document.addEventListener("click", () => hideMsgMenu());
  document.addEventListener("contextmenu", (e) => {
    // chat message
    const msg = e.target.closest?.("#messages .msg");
    if (msg && messagesEl.contains(msg)) {
      e.preventDefault();
      const raw = msg.dataset.raw || msg.querySelector(".body")?.innerText || "";
      const role = msg.dataset.role || "";
      const mid = msg.dataset.mid || "";
      const items = [
        { label: "复制全文", run: () => copyText(raw) },
        { label: "复制选中", run: () => {
          const sel = window.getSelection()?.toString() || "";
          copyText(sel || raw);
        } },
      ];
      if (role === "user" && mid) {
        items.push({ sep: true });
        items.push({
          label: "编辑并重新发送（新分支）",
          run: () => beginEditMessage(mid, raw),
        });
      }
      if (role === "user" && mid) {
        items.push({
          label: "上一个分支",
          run: () => switchBranchAt(mid, "prev"),
        });
        items.push({
          label: "下一个分支",
          run: () => switchBranchAt(mid, "next"),
        });
      }
      showMsgMenu(e.clientX, e.clientY, items);
      return;
    }
    // chat input / textarea paste menu
    if (e.target === inputEl || e.target?.id === "input") {
      e.preventDefault();
      showMsgMenu(e.clientX, e.clientY, [
        {
          label: "粘贴",
          run: async () => {
            try {
              const t = await navigator.clipboard.readText();
              const start = inputEl.selectionStart || 0;
              const end = inputEl.selectionEnd || 0;
              const v = inputEl.value;
              inputEl.value = v.slice(0, start) + t + v.slice(end);
              inputEl.selectionStart = inputEl.selectionEnd = start + t.length;
              inputEl.focus();
            } catch {
              toast("无法读取剪贴板，请用 Ctrl+V", true);
            }
          },
        },
        {
          label: "复制",
          run: () => {
            const sel = inputEl.value.slice(
              inputEl.selectionStart || 0,
              inputEl.selectionEnd || 0
            );
            copyText(sel || inputEl.value);
          },
        },
        {
          label: "全选",
          run: () => {
            inputEl.focus();
            inputEl.select();
          },
        },
        {
          label: "清空输入",
          run: () => {
            inputEl.value = "";
            inputEl.focus();
          },
        },
      ]);
    }
  });

  // ---------- Providers ----------
  async function showProviders() {
    const list = await emsoder.listProviders();
    const box = $("providerList");
    box.innerHTML = "";
    for (const p of list) {
      const el = document.createElement("div");
      el.className = "list-item";
      el.innerHTML = `
        <div class="meta">
          <div class="name">${escapeHtml(p.name)} ${p.enabled ? "" : "(禁用)"}</div>
          <div class="desc">${escapeHtml(p.type)} · ${escapeHtml(p.baseUrl)}</div>
        </div>
        <div class="list-actions">
          <button class="btn" data-act="edit">编辑</button>
          <button class="btn" data-act="test">测试</button>
          <button class="btn" data-act="refresh">刷新模型</button>
          <button class="btn danger" data-act="del">删</button>
        </div>`;
      el.querySelector('[data-act="edit"]').onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openEditProvider(p);
      };
      el.querySelector('[data-act="test"]').onclick = async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const btn = ev.currentTarget;
        if (!btn || btn.disabled || btn.dataset.busy === "1") return;
        btn.dataset.busy = "1";
        setBusyButton(btn, true, "测试中…");
        const release = guardBusyButton(btn, "测试", 20000);
        toast("正在测试 " + p.name + " …");
        try {
          const r = await withUiTimeout(emsoder.testProvider(p.id), 18000, "测试");
          toast((r?.ok ? "✓ " : "✗ ") + (r?.message || "无结果"), !r?.ok);
        } catch (e) {
          toast("测试失败: " + (e?.message || e), true);
        } finally {
          release();
          btn.dataset.busy = "0";
          setBusyButton(btn, false, null, "测试");
        }
      };
      el.querySelector('[data-act="refresh"]').onclick = async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const btn = ev.currentTarget;
        if (!btn || btn.disabled || btn.dataset.busy === "1") return;
        btn.dataset.busy = "1";
        setBusyButton(btn, true, "刷新中…");
        const release = guardBusyButton(btn, "刷新模型", 20000);
        toast("正在从 API 拉取模型列表…");
        try {
          const updated = await withUiTimeout(
            emsoder.refreshModels(p.id),
            18000,
            "刷新模型"
          );
          // 主进程现在失败也返回 {ok:false,error}，不再 throw
          if (updated && updated.ok === false) {
            toast("刷新失败: " + (updated.error || "未知错误"), true);
          } else {
            const models = updated?.models || [];
            toast(
              models.length
                ? "已刷新 " + models.length + " 个模型: " + models.slice(0, 6).join(", ")
                : "未返回模型列表（可手动填写）",
              !models.length
            );
            // 若当前正在编辑该服务商，立刻把模型列表写回输入框
            const editingId = $("pfId")?.value?.trim();
            if (
              models.length &&
              editingId &&
              (editingId === p.id || editingId === updated?.id)
            ) {
              $("pfModels").value = models.join(",");
            }
          }
        } catch (e) {
          toast("刷新失败: " + (e?.message || e), true);
        } finally {
          release();
          btn.dataset.busy = "0";
          setBusyButton(btn, false, null, "刷新模型");
          // 仅服务商列表弹窗打开时才重绘；若正在编辑弹窗，不要把编辑框盖掉
          try {
            if ($("modalProviders")?.classList.contains("show")) await showProviders();
          } catch {
            /* ignore redraw errors */
          }
        }
      };
      el.querySelector('[data-act="del"]').onclick = async () => {
        if (!(await EmsoderDom.showConfirm("删除 " + p.name + "？"))) return;
        state.config = await emsoder.removeProvider(p.id);
        refreshModelChips();
        showProviders();
      };
      box.appendChild(el);
    }
    openModal("modalProviders");
  }

  // Provider presets are loaded from main process (config.js PROVIDER_PRESETS) at init.
  // This avoids maintaining two copies. Populated by loadProviderPresets() below.
  let PROVIDER_PRESETS = {};

  async function loadProviderPresets() {
    try {
      PROVIDER_PRESETS = (await emsoder.getProviderPresets()) || {};
    } catch {
      /* ignore — applyProviderPreset will silently skip on missing key */
    }
  }

  function applyProviderPreset(key) {
    const preset = PROVIDER_PRESETS[key];
    if (!preset) return;
    if (!$("pfId").disabled) $("pfId").value = preset.id;
    $("pfName").value = preset.name;
    $("pfType").value = preset.type;
    $("pfBaseUrl").value = preset.baseUrl;
    if (preset.apiKey) $("pfApiKey").value = preset.apiKey;
    $("pfModels").value = preset.models;
    $("pfEnabled").value = "true";
  }

  function openEditProvider(p) {
    $("editProviderTitle").textContent = p ? "编辑服务商" : "添加第三方模型服务商";
    $("pfPreset").value = "";
    $("pfId").value = p?.id || "";
    $("pfId").disabled = !!p;
    $("pfName").value = p?.name || "";
    $("pfType").value = p?.type || "openai";
    $("pfBaseUrl").value = p?.baseUrl || "https://api.openai.com/v1";
    $("pfApiKey").value = p?.apiKey || "";
    // 打开编辑时默认隐藏 Key
    const keyInput = $("pfApiKey");
    if (keyInput) keyInput.type = "password";
    const eye = $("btnToggleApiKey");
    if (eye) {
      eye.textContent = "显示";
      eye.setAttribute("aria-pressed", "false");
    }
    // 占位符 model-a,model-b 不写入；空列表显示空，方便刷新后回填
    const models = Array.isArray(p?.models) ? p.models.filter(Boolean) : [];
    $("pfModels").value = models.join(",");
    $("pfModels").placeholder = models.length
      ? "model-a,model-b"
      : "点列表里的「刷新模型」自动填充，或手动填写模型 id";
    $("pfEnabled").value = p?.enabled === false ? "false" : "true";
    openModal("modalEditProvider");
  }

  // API Key 显示 / 隐藏
  $("btnToggleApiKey")?.addEventListener("click", () => {
    const input = $("pfApiKey");
    const btn = $("btnToggleApiKey");
    if (!input || !btn) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.textContent = show ? "隐藏" : "显示";
    btn.setAttribute("aria-pressed", show ? "true" : "false");
  });

  // 编辑弹窗内：刷新模型并直接填入输入框，同时保存到配置
  $("btnRefreshModelsInEdit")?.addEventListener("click", async () => {
    const btn = $("btnRefreshModelsInEdit");
    if (!btn || btn.disabled || btn.dataset.busy === "1") return;
    const provider = await saveProviderFromForm(false, { setActive: false });
    if (!provider) return;
    btn.dataset.busy = "1";
    setBusyButton(btn, true, "刷新中…");
    const release = guardBusyButton(btn, "刷新并填入", 20000);
    try {
      const updated = await withUiTimeout(
        emsoder.refreshModels(provider.id),
        18000,
        "刷新模型"
      );
      if (updated?.ok === false) {
        toast("刷新失败: " + (updated.error || "未知错误"), true);
        return;
      }
      const models = (updated?.models || []).filter(Boolean);
      if (!models.length) {
        toast("未返回模型列表，可手动填写模型 id", true);
        return;
      }
      $("pfModels").value = models.join(",");
      // 再保存一次，把填入的 models 落盘
      await saveProviderFromForm(false, { setActive: false });
      toast("已填入 " + models.length + " 个模型");
      refreshModelChips();
      window.EmsoderApp.refreshQuestModels?.();
    } catch (e) {
      toast("刷新失败: " + (e?.message || e), true);
    } finally {
      release();
      btn.dataset.busy = "0";
      setBusyButton(btn, false, null, "刷新并填入");
    }
  });

  $("pfPreset")?.addEventListener("change", (e) => {
    applyProviderPreset(e.target.value);
  });

  async function saveProviderFromForm(closeAfter = true, opts = {}) {
    const setActive = opts.setActive !== false;
    const provider = {
      id: $("pfId").value.trim(),
      name: $("pfName").value.trim(),
      type: $("pfType").value,
      baseUrl: $("pfBaseUrl").value.trim().replace(/\/+$/, ""),
      apiKey: $("pfApiKey").value,
      models: $("pfModels").value.split(",").map((s) => s.trim()).filter(Boolean),
      enabled: $("pfEnabled").value === "true",
    };
    if (!provider.id || !provider.name || !provider.baseUrl) {
      toast("请填写 ID / 名称 / Base URL", true);
      return null;
    }
    const wasActive = state.config?.activeProviderId === provider.id;
    state.config = await emsoder.upsertProvider(provider);
    if (setActive && provider.models[0]) {
      // 只有用户明确保存，或当前服务商本来就是 active，才更新 active model
      const shouldSetActive = opts.forceActive === true || wasActive || !state.config?.activeProviderId;
      if (shouldSetActive) {
        const keep =
          state.config.activeModel && provider.models.includes(state.config.activeModel)
            ? state.config.activeModel
            : provider.models[0];
        state.config = await emsoder.setActiveProvider(provider.id, keep);
      }
    }
    refreshModelChips();
    window.EmsoderApp.refreshQuestModels?.();
    if (closeAfter) {
      closeModal("modalEditProvider");
      showProviders();
    }
    return provider;
  }

  $("btnAddProvider").onclick = () => openEditProvider(null);
  $("btnSaveProvider").onclick = () => saveProviderFromForm(true);
  $("btnTestProvider").onclick = async () => {
    const btn = $("btnTestProvider");
    if (!btn || btn.disabled || btn.dataset.busy === "1") return;
    const provider = await saveProviderFromForm(false, { setActive: false });
    if (!provider) return;
    btn.dataset.busy = "1";
    setBusyButton(btn, true, "测试中…");
    const release = guardBusyButton(btn, "测试", 20000);
    toast("正在测试连通性…");
    try {
      const r = await withUiTimeout(
        emsoder.testProvider(provider.id),
        18000,
        "测试"
      );
      toast((r?.ok ? "✓ " : "✗ ") + (r?.message || "无结果"), !r?.ok);
    } catch (e) {
      toast("测试失败: " + (e?.message || e), true);
    } finally {
      release();
      btn.dataset.busy = "0";
      setBusyButton(btn, false, null, "测试");
    }
  };

  async function showModels() {
    const list = await emsoder.listProviders();
    const box = $("modelList");
    const search = $("modelSearch");
    const countEl = $("modelSearchCount");
    const allModels = [];
    for (const p of list.filter((x) => x.enabled !== false)) {
      for (const m of p.models || []) {
        allModels.push({ provider: p, model: m });
      }
    }

    const render = () => {
      const q = String(search?.value || "").trim().toLowerCase();
      box.innerHTML = "";
      let shown = 0;
      for (const item of allModels) {
        const p = item.provider;
        const m = item.model;
        const hay = `${m} ${p.name} ${p.id} ${p.baseUrl}`.toLowerCase();
        if (q && !hay.includes(q)) continue;
        shown++;
        const el = document.createElement("div");
        el.className =
          "list-item" +
          (state.config?.activeProviderId === p.id && state.config?.activeModel === m
            ? " active"
            : "");
        el.innerHTML = `<div class="meta"><div class="name">${escapeHtml(m)}</div><div class="desc">${escapeHtml(p.name)} · ${escapeHtml(p.id)}</div></div>`;
        el.onclick = async () => {
          state.config = await emsoder.setActiveProvider(p.id, m);
          refreshModelChips();
          window.EmsoderApp.refreshQuestModels?.();
          closeModal("modalModels");
          toast(`已切换: ${p.name} / ${m}`);
        };
        box.appendChild(el);
      }
      if (countEl) countEl.textContent = String(shown) + "/" + String(allModels.length);
      if (!allModels.length) {
        box.innerHTML = '<div class="tree-empty">请先添加服务商并填写 models</div>';
      } else if (!shown) {
        box.innerHTML = '<div class="tree-empty">没有匹配的模型</div>';
      }
    };

    if (search) {
      search.value = "";
      search.oninput = render;
    }
    render();
    openModal("modalModels");
    setTimeout(() => search?.focus?.(), 60);
  }

  function refreshAutoApproveBtn() {
    const btn = $("btnAutoApprove");
    if (!btn) return;
    const on = !!state.config?.autoApproveSafe;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.textContent = on ? "自动授权 · 开" : "自动授权 · 关";
    btn.title = on
      ? "已开：读写文件/安全命令自动执行（git/npm/ls 等），仅高危险命令仍询问。点击关闭。"
      : "已关：多数工具会弹确认。点击开启，任务进行时少打断。";
  }

  function fillSettingsForm() {
    const c = state.config;
    if (!c) return;
    $("stAgentMode").value = c.agentMode ? "true" : "false";
    $("stTerminal").value = c.terminalRunMode || "askEveryTime";
    $("stAutoTools").value = c.autoRunTools ? "true" : "false";
    if ($("stAutoApproveSafe")) {
      $("stAutoApproveSafe").value = c.autoApproveSafe ? "true" : "false";
    }
    refreshAutoApproveBtn();
    if ($("stCollapseProcess")) {
      $("stCollapseProcess").value =
        c.collapseProcess === false ? "false" : "true";
    }
    $("stCompletion").value = c.completionEnabled === false ? "false" : "true";
    $("stLang").value = c.responseLanguage || "zh-cn";
    $("stMaxTokens").value = c.maxTokens ?? 8192;
    $("stTemp").value = c.temperature ?? 0.2;
    if ($("stAgentMaxRounds")) {
      $("stAgentMaxRounds").value = c.agentMaxRounds ?? 32;
    }
    if ($("stAgentAutoContinue")) {
      $("stAgentAutoContinue").value =
        c.agentAutoContinue === false || c.agentAutoContinue === 0
          ? 0
          : c.agentAutoContinue ?? 2;
    }
    $("stFont").value = c.fontSize || 14;
    $("stSystem").value = c.systemPrompt || "";
    $("stDeny").value = c.commandDenyList || "";
    if ($("stSkillsEnabled")) {
      $("stSkillsEnabled").value = c.skillsEnabled === false ? "false" : "true";
    }
    if ($("stSkillsPlugins")) {
      $("stSkillsPlugins").value =
        c.skillsIncludePlugins === false ? "false" : "true";
    }
    if ($("stMemoriesEnabled")) {
      $("stMemoriesEnabled").value = c.memoriesEnabled === true ? "true" : "false";
    }
    if ($("stMemoriesMaxCount")) {
      $("stMemoriesMaxCount").value = c.memoriesMaxCount ?? 500;
    }
    refreshSkillsSettingsList();
  }

  async function refreshSkillsSettingsList() {
    const box = $("stSkillsList");
    if (!box || !window.emsoder?.listSkills) return;
    box.innerHTML = '<div class="tree-empty">加载中…</div>';
    try {
      const r = await emsoder.listSkills();
      if (!r?.ok) {
        box.innerHTML =
          '<div class="tree-empty">' +
          escapeHtml(r?.error || "加载失败") +
          "</div>";
        return;
      }
      if (r.enabled === false) {
        box.innerHTML =
          '<div class="tree-empty">Skills 已关闭（保存设置后生效）</div>';
        return;
      }
      const skills = r.skills || [];
      if (!skills.length) {
        box.innerHTML =
          '<div class="tree-empty">未发现技能。目录：~/.zcode/skills、~/.agents/skills</div>';
        return;
      }
      box.innerHTML = "";
      for (const s of skills.slice(0, 80)) {
        const el = document.createElement("div");
        el.className = "list-item";
        el.style.padding = "6px 8px";
        const desc = (s.description || "").replace(/\s+/g, " ").slice(0, 100);
        el.innerHTML =
          `<div class="meta"><div class="name">${escapeHtml(s.name)}` +
          (s.disabled ? ' <span style="opacity:.6">关</span>' : "") +
          `</div><div class="desc">${escapeHtml(s.source || "")} · ${escapeHtml(
            desc
          )}</div></div>`;
        el.title = s.dir || s.id;
        el.onclick = async () => {
          try {
            await emsoder.setSkillDisabled(s.id || s.name, !s.disabled);
            state.config = await emsoder.getConfig();
            toast((s.disabled ? "已启用: " : "已禁用: ") + s.name);
            await refreshSkillsSettingsList();
          } catch (e) {
            toast(e.message || e, true);
          }
        };
        box.appendChild(el);
      }
      if (skills.length > 80) {
        const more = document.createElement("div");
        more.className = "tree-empty";
        more.textContent = `…共 ${skills.length} 个，仅显示前 80`;
        box.appendChild(more);
      }
    } catch (e) {
      box.innerHTML =
        '<div class="tree-empty">' + escapeHtml(e.message || e) + "</div>";
    }
  }

  $("btnRefreshSkills")?.addEventListener("click", () =>
    refreshSkillsSettingsList()
  );

  $("btnSaveSettings").onclick = async () => {
    state.config = await emsoder.updateConfig({
      agentMode: $("stAgentMode").value === "true",
      terminalRunMode: $("stTerminal").value,
      autoRunTools: $("stAutoTools").value === "true",
      autoApproveSafe: $("stAutoApproveSafe")
        ? $("stAutoApproveSafe").value === "true"
        : false,
      collapseProcess: $("stCollapseProcess")
        ? $("stCollapseProcess").value === "true"
        : true,
      completionEnabled: $("stCompletion").value === "true",
      responseLanguage: $("stLang").value,
      maxTokens: Number($("stMaxTokens").value) || 8192,
      temperature: Number($("stTemp").value) || 0.2,
      agentMaxRounds: Math.min(
        80,
        Math.max(4, Number($("stAgentMaxRounds")?.value) || 32)
      ),
      agentAutoContinue: Math.min(
        5,
        Math.max(0, Number($("stAgentAutoContinue")?.value) || 0)
      ),
      fontSize: Number($("stFont").value) || 14,
      systemPrompt: $("stSystem").value,
      commandDenyList: $("stDeny").value,
      skillsEnabled: $("stSkillsEnabled")
        ? $("stSkillsEnabled").value === "true"
        : true,
      skillsIncludePlugins: $("stSkillsPlugins")
        ? $("stSkillsPlugins").value === "true"
        : true,
      memoriesEnabled: $("stMemoriesEnabled")
        ? $("stMemoriesEnabled").value === "true"
        : false,
      memoriesMaxCount: $("stMemoriesMaxCount")
        ? Math.max(50, Math.min(5000, Number($("stMemoriesMaxCount").value) || 500))
        : 500,
    });
    refreshModelChips();
    refreshAutoApproveBtn();
    EmsoderEditor.applyConfig(state.config);
    await EmsoderEditor.enableCompletion(
      state.config.completionEnabled !== false,
      state.config.completionDebounceMs
    );
    closeModal("modalSettings");
    toast("设置已保存");
  };

  $("btnExportConfig")?.addEventListener("click", async () => {
    try {
      const r = await emsoder.exportConfig({ redactKeys: true });
      if (r?.canceled) return;
      if (!r?.ok) {
        toast(r?.error || "导出失败", true);
        return;
      }
      toast("已导出（API Key 已脱敏）: " + (r.path || ""));
    } catch (e) {
      toast(e.message || e, true);
    }
  });

  $("btnImportConfig")?.addEventListener("click", async () => {
    try {
      const r = await emsoder.importConfig();
      if (r?.canceled) return;
      if (!r?.ok) {
        toast(r?.error || "导入失败", true);
        return;
      }
      state.config = r.config || (await emsoder.getConfig());
      refreshModelChips();
      fillSettingsForm();
      EmsoderEditor.applyConfig?.(state.config);
      window.EmsoderApp.refreshQuestModels?.();
      toast("配置已导入");
    } catch (e) {
      toast(e.message || e, true);
    }
  });

  async function adjustFontSize(delta) {
    const cur = Number(state.config?.fontSize) || 14;
    const next = Math.min(28, Math.max(10, cur + delta));
    state.config = await emsoder.updateConfig({ fontSize: next });
    EmsoderEditor.applyConfig(state.config);
    if ($("stFont")) $("stFont").value = next;
    toast("字号 " + next);
  }

  function paletteCommands() {
    return [
      { id: "openFolder", label: "打开文件夹", hint: "Ctrl+O", run: () => $("btnOpenFolder")?.click() },
      { id: "save", label: "保存当前文件", hint: "Ctrl+S", run: () => saveActive() },
      { id: "providers", label: "管理服务商 / 第三方模型", hint: "", run: () => showProviders() },
      { id: "models", label: "选择模型", hint: "", run: () => showModels() },
      { id: "newChat", label: "新建对话", hint: "", run: () => $("btnNewChat")?.click() },
      { id: "quest", label: "打开 Quest 任务板", hint: "Ctrl+Shift+Q", run: () => EmsoderQuest?.open?.() },
      { id: "terminal", label: "打开终端", hint: "Ctrl+`", run: () => {
        $("bottomPanel")?.classList.remove("collapsed");
        EmsoderPanels.showTab("terminal");
      } },
      { id: "git", label: "打开 Git 面板", hint: "", run: () => {
        $("bottomPanel")?.classList.remove("collapsed");
        EmsoderPanels.showTab("git");
      } },
      { id: "problems", label: "打开问题面板", hint: "", run: () => {
        $("bottomPanel")?.classList.remove("collapsed");
        EmsoderPanels.showTab("problems");
      } },
      { id: "settings", label: "打开设置", hint: "", run: () => {
        fillSettingsForm();
        openModal("modalSettings");
      } },
      {
        id: "skills",
        label: "查看 Skills（zcode / agents）",
        hint: "",
        run: async () => {
          fillSettingsForm();
          openModal("modalSettings");
          await refreshSkillsSettingsList();
        },
      },
      { id: "exportConfig", label: "导出配置（脱敏）", hint: "", run: () => $("btnExportConfig")?.click() },
      { id: "importConfig", label: "导入配置", hint: "", run: () => $("btnImportConfig")?.click() },
      { id: "fontUp", label: "增大编辑器字号", hint: "Ctrl+=", run: () => adjustFontSize(1) },
      { id: "fontDown", label: "减小编辑器字号", hint: "Ctrl+-", run: () => adjustFontSize(-1) },
      { id: "toggleChat", label: "切换 AI 侧栏", hint: "Ctrl+Shift+L", run: () => {
        mainLayout.classList.toggle("chat-collapsed");
        EmsoderEditor.layout();
      } },
      { id: "inline", label: "Inline Edit", hint: "Ctrl+I", run: () => openInlineModal() },
      { id: "ide", label: "切换到 IDE 模式", hint: "", run: () => {
        EmsoderQuest?.setShellMode?.("ide");
        document.querySelector('.act-btn[data-view="explorer"]')?.click();
      } },
      { id: "questMode", label: "切换到 Quest 模式", hint: "", run: () => EmsoderQuest?.open?.() },
    ];
  }

  function openCommandPalette() {
    const input = $("paletteInput");
    const list = $("paletteList");
    if (!input || !list) return;
    input.value = "";
    list.dataset.selected = "0";
    renderPaletteList("");
    openModal("modalPalette");
    setTimeout(() => input.focus(), 30);
  }

  function renderPaletteList(q) {
    const list = $("paletteList");
    if (!list) return;
    const query = String(q || "").trim().toLowerCase();
    const items = paletteCommands().filter(
      (c) =>
        !query ||
        c.label.toLowerCase().includes(query) ||
        c.id.toLowerCase().includes(query)
    );
    list.innerHTML = "";
    if (!items.length) {
      list.innerHTML = '<div class="tree-empty">无匹配命令</div>';
      return;
    }
    items.forEach((c, i) => {
      const el = document.createElement("div");
      el.className = "list-item palette-item" + (i === 0 ? " active" : "");
      el.dataset.idx = String(i);
      el.innerHTML =
        '<div class="meta"><div class="name">' +
        escapeHtml(c.label) +
        '</div></div><span class="desc">' +
        escapeHtml(c.hint || "") +
        "</span>";
      el.onclick = () => {
        closeModal("modalPalette");
        try {
          c.run();
        } catch (e) {
          toast(e.message || e, true);
        }
      };
      list.appendChild(el);
    });
    list._items = items;
  }

  function movePaletteSelection(delta) {
    const list = $("paletteList");
    if (!list?._items?.length) return;
    const items = list.querySelectorAll(".palette-item");
    let cur = Number(list.dataset.selected || 0);
    items[cur]?.classList.remove("active");
    cur = (cur + delta + items.length) % items.length;
    list.dataset.selected = String(cur);
    items[cur]?.classList.add("active");
    items[cur]?.scrollIntoView({ block: "nearest" });
  }

  function runPaletteSelected() {
    const list = $("paletteList");
    const items = list?._items;
    if (!items?.length) return;
    const cur = Number(list.dataset.selected || 0);
    const cmd = items[cur];
    if (!cmd) return;
    closeModal("modalPalette");
    try {
      cmd.run();
    } catch (e) {
      toast(e.message || e, true);
    }
  }

  $("paletteInput")?.addEventListener("input", (e) => {
    $("paletteList").dataset.selected = "0";
    renderPaletteList(e.target.value);
  });
  $("paletteInput")?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      movePaletteSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      movePaletteSelection(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      runPaletteSelected();
    } else if (e.key === "Escape") {
      closeModal("modalPalette");
    }
  });

  let draftTimer = null;
  function scheduleDraftSave() {
    if (draftTimer) return;
    draftTimer = setTimeout(async () => {
      draftTimer = null;
      try {
        await flushActiveToTab();
        const dirty = state.tabs
          .filter((t) => t.dirty)
          .map((t) => ({
            path: t.path,
            name: t.name,
            content: t.content,
            original: t.original,
          }));
        if (dirty.length) await emsoder.saveDrafts(dirty);
        else await emsoder.clearDrafts();
      } catch {
        /* ignore */
      }
    }, 800);
  }

  async function maybeRestoreDrafts() {
    try {
      const data = await emsoder.loadDrafts();
      const drafts = data?.drafts || [];
      if (!drafts.length) return;
      if (
        !(await EmsoderDom.showConfirm(
          "发现 " + drafts.length + " 个未保存草稿（可能来自上次异常退出）。是否恢复？"
        ))
      ) {
        await emsoder.clearDrafts();
        return;
      }
      for (const d of drafts) {
        if (!d?.path) continue;
        let content = d.content || "";
        let original = d.original || "";
        try {
          const disk = await emsoder.readFile(d.path);
          if (disk?.content != null) original = disk.content;
        } catch {
          /* ignore */
        }
        const existing = state.tabs.find((t) => t.path === d.path);
        if (existing) {
          existing.content = content;
          existing.original = original;
          existing.dirty = content !== original;
        } else {
          state.tabs.push({
            path: d.path,
            name: d.name || basename(d.path),
            content,
            original,
            dirty: content !== original,
          });
        }
      }
      renderTabs();
      const first = state.tabs.find((t) => t.dirty) || state.tabs[0];
      if (first) await activateTab(first.path);
      toast("已恢复未保存草稿");
    } catch (e) {
      console.warn("restore drafts", e);
    }
  }

  $("modeSeg").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (!btn) return;
    state.config = await emsoder.updateConfig({
      agentMode: btn.dataset.mode === "agent",
    });
    refreshModelChips();
  });

  // ---------- Bindings ----------
  $("btnSend").onclick = () => sendMessage();
  $("btnAutoApprove")?.addEventListener("click", async () => {
    try {
      const next = !state.config?.autoApproveSafe;
      state.config = await emsoder.updateConfig({ autoApproveSafe: next });
      refreshAutoApproveBtn();
      if ($("stAutoApproveSafe")) {
        $("stAutoApproveSafe").value = next ? "true" : "false";
      }
      toast(
        next
          ? "自动授权已开：读写文件/安全命令自动跑，仅危险命令仍确认"
          : "自动授权已关：操作会弹确认"
      );
    } catch (e) {
      toast(e.message || e, true);
    }
  });
  $("btnAttach")?.addEventListener("click", () => addAttachmentsFromPicker());
  function stopAndClear() {
    if (state.generating || state.queueDepth > 0) {
      emsoder.stopAgent();
      setQueueDepth(0);
      setGenerating(false, "已停止");
      toast("已停止当前任务并清空队列");
    }
  }
  $("btnStop2")?.addEventListener("click", stopAndClear);
  $("btnStop")?.addEventListener("click", stopAndClear);

  async function applySessionUpdate(s) {
    state.branchMeta = s.branchMeta || [];
    state.activeSessionId = s.id || null;
    cancelEditMode();
    renderHistory(s.messages || [], s.branchMeta);
    renderChatChanges(s.fileChanges || [], s.id || null);
    updateChatHeader(s);
  }

  /** Chat header 同步当前会话标题/模式 */
  function updateChatHeader(s) {
    const titleEl = $("chatTitle");
    const subEl = $("chatSub");
    if (titleEl) titleEl.textContent = s?.title || "AI 助手";
    if (subEl) {
      subEl.textContent =
        s?.mode === "ask" ? "Ask · 只问答" : "Agent · 可读写文件";
    }
  }
  $("btnNewChat").onclick = async () => {
    try {
      applySessionUpdate(await emsoder.newSession());
      toast("已创建新会话");
      if (state.sideView === "sessions") await renderSessionsSide();
    } catch (e) {
      toast(e?.message || e || "创建失败", true);
    }
  };
  $("btnClearChat").onclick = async () => {
    if (!(await EmsoderDom.showConfirm("清空当前会话？（会话保留，标题重置为「新对话」）"))) return;
    try {
      applySessionUpdate(await emsoder.clearSession());
      toast("已清空会话");
      await refreshSessionsSideIfVisible();
    } catch (e) {
      toast(e.message || e, true);
    }
  };
  $("btnAcceptAllChanges")?.addEventListener("click", async () => {
    const files = state.fileChanges || [];
    if (!files.length) {
      toast("没有本轮改动");
      return;
    }
    if (!(await EmsoderDom.showConfirm("确认本轮改动并收起面板？（不会撤销文件）"))) return;
    try {
      const sessionId = state.fileChangesSessionId || null;
      const r = await emsoder.acceptAllAgentChanges(sessionId);
      renderChatChanges(r.fileChanges || [], sessionId);
      toast("已确认，面板已收起");
    } catch (err) {
      toast(err.message || String(err), true);
    }
  });
  $("btnRejectAllChanges")?.addEventListener("click", async () => {
    const active = (state.fileChanges || []).filter((f) => !f.rejected);
    if (!active.length) {
      toast("没有可撤销的改动");
      return;
    }
    if (!(await EmsoderDom.showConfirm(`回滚本轮 ${active.length} 个文件到写前内容？`))) return;
    try {
      const sessionId = state.fileChangesSessionId || null;
      const r = await emsoder.rejectAllAgentChanges(sessionId);
      renderChatChanges(r.fileChanges || [], sessionId);
      // 刷新已打开的标签
      for (const f of active) {
        if (!f.path || !state.tabs.some((t) => t.path === f.path)) continue;
        try {
          const file = await emsoder.readFile(f.path);
          const tab = state.tabs.find((t) => t.path === f.path);
          if (tab && file) {
            tab.content = file.content;
            tab.original = file.content;
            tab.dirty = false;
            if (state.activePath === f.path && window.EmsoderEditor) {
              EmsoderEditor.setValue(file.content);
            }
          }
        } catch {
          /* 新建文件被删 */
        }
      }
      renderTabs();
      const results = Array.isArray(r?.results) ? r.results : [];
      const failed = results.filter((x) => x && x.ok === false).length;
      const done = results.filter((x) => x && x.ok !== false).length;
      toast(failed ? `已撤销 ${done} 个，${failed} 个未撤销（文件已变化）` : "本轮改动已全部撤销", !!failed);
    } catch (err) {
      toast(err.message || String(err), true);
    }
  });
  $("btnOpenFolder").onclick = async () => {
    const p = await emsoder.openWorkspace();
    if (p) {
      state.workspace = p;
      _mentionCachePromise = null;
      $("workspacePath").textContent = p;
      state.expandedDirs.clear();
      // 打开文件夹后：若当前在资源管理器则刷新树，否则不抢侧栏
      if (state.sideView === "explorer") await renderExplorer();
      refreshGitBranch();
      indexWorkspaceLsp(false);
    }
  };
  $("btnRefreshTree").onclick = () => refreshCurrentSideView();
  $("btnProviders").onclick = showProviders;
  $("btnSelectModel").onclick = showModels;
  $("modelChip").onclick = showModels;
  $("sbModel").onclick = showModels;
  $("sbContext")?.addEventListener("click", () => refreshContextStats());
  $("sbCache")?.addEventListener("click", () => refreshContextStats());

  $("btnToggleChat").onclick = () => {
    mainLayout.classList.toggle("chat-collapsed");
    EmsoderEditor.layout();
  };
  $("btnToggleEditor")?.addEventListener("click", () => toggleEditorPanel());
  $("btnToggleEditor2")?.addEventListener("click", () => toggleEditorPanel());
  $("btnShowEditorFromChat")?.addEventListener("click", () => setEditorVisible(true));

  // 昼夜模式切换
  function applyTheme(mode) {
    document.body.setAttribute("data-theme", mode === "light" ? "light" : "dark");
    try { localStorage.setItem("emsoder-theme", mode); } catch {}
  }
  function toggleTheme() {
    const cur = document.body.getAttribute("data-theme") === "light" ? "light" : "dark";
    const next = cur === "light" ? "dark" : "light";
    applyTheme(next);
    // 同步到配置（持久化跨重启）
    try { emsoder?.updateConfig?.({ theme: next }); } catch {}
    toast(next === "light" ? "已切换到白天模式" : "已切换到夜晚模式");
  }
  $("btnThemeToggle")?.addEventListener("click", toggleTheme);
  // 启动时恢复主题：优先 localStorage，其次配置
  (async () => {
    try {
      const saved = localStorage.getItem("emsoder-theme");
      if (saved === "light" || saved === "dark") { applyTheme(saved); return; }
      const cfg = await emsoder?.getConfig?.();
      if (cfg?.theme === "light" || cfg?.theme === "dark") applyTheme(cfg.theme);
    } catch {}
  })();

  // 对话目录：默认开，可关
  $("btnToggleChatToc")?.addEventListener("click", () => {
    const toc = $("chatToc");
    const next = !!(toc && toc.hidden);
    setChatTocVisible(next);
    if (next) refreshChatToc();
  });
  try {
    const tocPref = localStorage.getItem("emsoder.chatToc");
    setChatTocVisible(tocPref !== "0");
  } catch {
    setChatTocVisible(true);
  }
  refreshChatToc();

  const toggleBottom = () => {
    $("bottomPanel")?.classList.toggle("collapsed");
    EmsoderEditor.layout();
  };
  $("btnToggleBottom").onclick = () => {
    toggleBottom();
    window.EmsoderResize?.syncBottomResizerVisibility?.();
  };
  $("btnToggleBottom2")?.addEventListener("click", () => {
    toggleBottom();
    window.EmsoderResize?.syncBottomResizerVisibility?.();
  });

  function openInlineModal() {
    if (!state.activePath) {
      toast("请先打开一个文件", true);
      return;
    }
    $("inlineInstruction").value = "";
    openModal("modalInline");
    setTimeout(() => $("inlineInstruction").focus(), 50);
  }

  async function runInlineEdit(instruction) {
    if (!state.activePath || !instruction?.trim()) return;
    let code = EmsoderEditor.getValue();
    const sel = EmsoderEditor.getSelectionText();
    if (sel) code = sel;
    $("sbStatus").textContent = "Inline Edit…";
    try {
      const r = await emsoder.inlineEdit({
        instruction,
        code,
        file: state.activePath,
        language: EmsoderEditor.getLanguage(),
      });
      if (!r.code) {
        toast("模型返回为空", true);
        return;
      }
      EmsoderEditor.replaceSelectionOrAll(r.code);
      await flushActiveToTab();
      renderTabs();
      toast("Inline Edit 完成");
    } catch (err) {
      toast(err.message || err, true);
    }
  }

  $("btnInlineEdit").onclick = openInlineModal;
  $("btnRunInline").onclick = async () => {
    const instruction = $("inlineInstruction").value.trim();
    if (!instruction) {
      toast("请填写修改说明", true);
      return;
    }
    closeModal("modalInline");
    await runInlineEdit(instruction);
  };

  $("btnAddSelection").onclick = () => addSelectionToChat("请基于选中代码：");
  $("btnAddSelection2").onclick = () => addSelectionToChat("请基于选中代码：");
  $("btnExplain").onclick = () => {
    const sel = getSelectionOrEmpty();
    if (!sel.trim()) {
      toast("请先选中代码", true);
      return;
    }
    sendMessage(
      `请解释以下代码的作用、关键逻辑和潜在问题：\n\`\`\`${EmsoderEditor.getLanguage()}\n${sel}\n\`\`\``
    );
  };

  inputEl.addEventListener("keydown", (e) => {
    const m = state.mention;
    // Mention popup keyboard nav
    if (m.visible) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        m.index = Math.min(m.index + 1, m.items.length - 1);
        renderMentionList();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        m.index = Math.max(m.index - 1, 0);
        renderMentionList();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        selectMentionAt(m.index);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideMentionPopup();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      hideMentionPopup();
      sendMessage();
    }
  });

  // Debounce @ mention trigger: avoids IPC + 600-item filter on every keystroke
  let _atDebounceTimer = null;
  inputEl.addEventListener("input", () => {
    clearTimeout(_atDebounceTimer);
    _atDebounceTimer = setTimeout(detectAtTrigger, 80);
  });

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      openCommandPalette();
      return;
    }
    if (e.ctrlKey && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      adjustFontSize(1);
      return;
    }
    if (e.ctrlKey && e.key === "-") {
      e.preventDefault();
      adjustFontSize(-1);
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveActive();
    }
    if (e.ctrlKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      $("btnOpenFolder").click();
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      mainLayout.classList.toggle("chat-collapsed");
      EmsoderEditor.layout();
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === "\\" || e.code === "Backslash")) {
      e.preventDefault();
      toggleEditorPanel();
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      addSelectionToChat("请基于选中代码：");
    }
    if (e.ctrlKey && e.key.toLowerCase() === "i") {
      e.preventDefault();
      openInlineModal();
    }
    if (e.ctrlKey && e.key === "j") {
      e.preventDefault();
      toggleBottom();
    }
    if (e.ctrlKey && e.key === "`") {
      e.preventDefault();
      $("bottomPanel")?.classList.remove("collapsed");
      EmsoderPanels.showTab("terminal");
      setTimeout(() => EmsoderPanels.resizeTerm?.(), 80);
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "q") {
      e.preventDefault();
      EmsoderQuest?.open?.();
    }
    if (e.key === "Escape" && state.generating) emsoder.stopAgent();
  });

  document.querySelectorAll(".act-btn[data-view]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      document
        .querySelectorAll(".act-btn[data-view]")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.sideView = btn.dataset.view;
      mainLayout.classList.remove("side-collapsed");
      if (state.sideView === "quest") {
        EmsoderQuest?.open?.();
        return;
      }
      // leave quest console when switching to other side views
      if (mainLayout.classList.contains("quest-mode") && state.sideView !== "quest") {
        mainLayout.classList.remove("quest-mode");
      }
      if (state.sideView === "explorer") await renderExplorer();
      else if (state.sideView === "sessions") await renderSessionsSide();
      else if (state.sideView === "search") renderSearchSide();
      else if (state.sideView === "git") renderGitSide();
      else if (state.sideView === "skills") await renderSkillsSide();
      else if (state.sideView === "memory") await renderMemorySide();
      else if (state.sideView === "mcp") await renderMcpSide();
      else if (state.sideView === "settings") {
        openModal("modalSettings");
        fillSettingsForm();
      }
    });
  });

  $("btnOpenQuest")?.addEventListener("click", () => {
    EmsoderQuest?.open?.();
  });
  $("btnSelectModel2")?.addEventListener("click", () => showModels());
  $("btnProviders2")?.addEventListener("click", () => showProviders());
  $("btnQuestStart2")?.addEventListener("click", () => {
    $("btnQuestStart")?.click();
  });
  $("sbQuest")?.addEventListener("click", () => EmsoderQuest?.open?.());

  $("actAccount").onclick = () =>
    toast("EMSoder · Monaco · 终端 · Git · 免费 BYOK");

  $("confirmAllow").onclick = () => {
    if (state.pendingConfirmId) {
      emsoder.respondConfirm(state.pendingConfirmId, true);
      state.pendingConfirmId = null;
    }
    $("confirmBar").classList.remove("show");
  };
  $("confirmDeny").onclick = () => {
    if (state.pendingConfirmId) {
      emsoder.respondConfirm(state.pendingConfirmId, false);
      state.pendingConfirmId = null;
    }
    $("confirmBar").classList.remove("show");
  };

  // ── Agent event handlers (one function per event type for readability) ──────
  function _onAgentQueue(msg) {
    setQueueDepth(msg.depth);
    if (msg.running && !state.generating && msg.depth > 0) {
      setGenerating(true, "排队任务启动");
    } else if (!msg.running && msg.depth === 0 && !state.generating) {
      setGenerating(false, "就绪");
    }
  }
  function _onAgentError(msg) {
    finishReasoningFold();
    finalizeStreamingBubble(true);
    state.activeToolRow = null;
    const errText = msg.text || "error";
    addMsg("error", errText + (msg.hint ? "\n" + msg.hint : ""));
    setGenerating(false, "失败");
    toast(errText, true);
    if (msg.action === "providers") setTimeout(() => showProviders(), 200);
    else if (msg.action === "models") setTimeout(() => showModels(), 200);
  }
  function _onAgentStatus(msg) {
    if (state.generating) {
      setTaskProgress(true, msg.text || "任务进行中");
    } else {
      if ($("statusText")) { $("statusText").textContent = msg.text || "就绪"; $("statusText").className = "status-idle"; }
      if ($("sbStatus")) $("sbStatus").textContent = msg.text || "就绪";
    }
  }
  // agent 写盘事件合并：burst 内（300ms）只做一次 git/资源管理器/mention 刷新，
  // 避免每次写文件都触发 6 个 git 子进程 + 整树重绘
  let _fsChangeTimer = null;
  let _fsChangePendingTabs = new Set();
  function _onAgentFsChange(msg) {
    if (msg.path) _fsChangePendingTabs.add(msg.path);
    if (_fsChangeTimer) return;
    _fsChangeTimer = setTimeout(async () => {
      _fsChangeTimer = null;
      const paths = [..._fsChangePendingTabs];
      _fsChangePendingTabs = new Set();
      // Invalidate @ mention file list so new/deleted files appear immediately
      _mentionCachePromise = null;
      state.mention.ts = 0;
      for (const p of paths) {
        if (!state.tabs.some((t) => t.path === p)) continue;
        try {
          const f = await emsoder.readFile(p);
          const tab = state.tabs.find((t) => t.path === f.path);
          if (!tab) continue;
          if (tab.dirty && state.activePath === f.path) {
            toast("磁盘已更新，本地有未保存修改，未自动覆盖", true);
            continue;
          }
          tab.content = f.content;
          tab.original = f.content;
          tab.dirty = false;
          if (state.activePath === f.path) {
            await EmsoderEditor.openDocument({ path: f.path, content: f.content });
          }
          renderTabs();
        } catch {
          /* 文件可能被删除 */
        }
      }
      if (state.sideView === "explorer") renderExplorer();
      EmsoderPanels.refreshGit?.();
      refreshGitBranch();
    }, 300);
  }

  emsoder.onAgentEvent((msg) => {
    switch (msg.type) {
      case "queue":          _onAgentQueue(msg); break;
      case "branch":
        if (msg.session) { state.branchMeta = msg.session.branchMeta || []; renderHistory(msg.session.messages || [], msg.session.branchMeta); }
        break;
      case "user":           addMsg("user", msg.text, null, { messageId: msg.messageId || "" }); break;
      case "assistant_start":
        resetStreamUi(); state.streamingEl = addMsg("assistant", ""); setGenerating(true, "生成中"); break;
      case "assistant_delta":
        finishReasoningFold();
        if (!state.streamingEl) state.streamingEl = addMsg("assistant", "");
        state.streamingRaw += msg.text || "";
        scheduleStreamingDom(); break;
      case "reasoning_delta":
        finalizeStreamingBubble(true); ensureReasoningFold();
        state.reasoningRaw += msg.text || "";
        scheduleReasoningDom(); setGenerating(true, "思考中"); break;
      case "tool_start":
        finishReasoningFold(); finalizeStreamingBubble(true);
        state.activeToolRow = addToolFold("start", msg.name, "→ " + (msg.name || "") + "\n" + (msg.args || ""));
        setGenerating(true, "工具 · " + (msg.name || "running")); break;
      case "tool_end":       updateToolFoldEnd(msg.name, msg.result || ""); break;
      case "file_changes":   renderChatChanges(msg.fileChanges || [], msg.sessionId || null); break;
      case "assistant_done":
        finishReasoningFold(); finalizeStreamingBubble(true);
        state.activeToolRow = null; setGenerating(false, "完成");
        try { refreshChatToc(); } catch { /* ignore */ }
        break;
      case "session":
        if (msg.session) {
          state.branchMeta = msg.session.branchMeta || [];
          state.activeSessionId = msg.session.id || null;
          updateChatHeader(msg.session);
          if (Array.isArray(msg.session.fileChanges)) renderChatChanges(msg.session.fileChanges, msg.session.id || null);
          if (!state.generating) renderHistory(msg.session.messages || [], msg.session.branchMeta);
          else try { refreshChatToc(); } catch { /* ignore */ }
          // 侧栏数据已由主进程下发：静默刷新会话列表（标题/消息数/排序）
          if (Array.isArray(msg.sessions)) refreshSessionsSideIfVisible();
        }
        break;
      case "error":          _onAgentError(msg); break;
      case "status":         _onAgentStatus(msg); break;
      case "context_stats":  updateContextStatsUI(msg.stats); break;
      case "fs_change":      _onAgentFsChange(msg); break;
    }
  });

  emsoder.onConfirm((data) => {
    state.pendingConfirmId = data.id;
    $("confirmMsg").textContent = data.message;
    $("confirmBar").classList.add("show");
  });

  emsoder.onMcpEvent?.((msg) => {
    // server 状态/工具列表变化 → 静默刷新 MCP 侧栏
    if (state.sideView === "mcp") refreshMcpSideIfVisible();
  });

  emsoder.onMenu("save", saveActive);
  emsoder.onMenu("toggleSidebar", () => {
    mainLayout.classList.toggle("chat-collapsed");
    EmsoderEditor.layout();
  });
  emsoder.onMenu("toggleBottom", toggleBottom);
  emsoder.onMenu("showTerminal", () => {
    $("bottomPanel")?.classList.remove("collapsed");
    EmsoderPanels.showTab("terminal");
  });
  emsoder.onMenu("showGit", () => {
    $("bottomPanel")?.classList.remove("collapsed");
    EmsoderPanels.showTab("git");
  });
  emsoder.onMenu("showProblems", () => {
    $("bottomPanel")?.classList.remove("collapsed");
    EmsoderPanels.showTab("problems");
  });
  emsoder.onMenu("showDebug", () => {
    $("bottomPanel")?.classList.remove("collapsed");
    EmsoderPanels.showTab("debug");
    // prefill program with active file
    if (state.activePath && /\.(c?js|mjs)$/i.test(state.activePath)) {
      const input = $("debugProgram");
      if (input && !input.value) input.value = state.activePath;
    }
  });
  emsoder.onMenu("reindexLsp", () => indexWorkspaceLsp(false));
  emsoder.onMenu("newChat", () => $("btnNewChat").click());
  emsoder.onMenu("selectModel", showModels);
  emsoder.onMenu("providers", showProviders);
  emsoder.onMenu("addSelection", () => addSelectionToChat("请基于选中代码："));
  emsoder.onMenu("explainSelection", () => $("btnExplain").click());
  emsoder.onMenu("inlineEdit", openInlineModal);
  emsoder.onMenu("genCommit", async () => {
    $("bottomPanel")?.classList.remove("collapsed");
    EmsoderPanels.showTab("git");
    $("btnGenCommit")?.click();
  });

  emsoder.onWorkspaceChanged(async (p) => {
    state.workspace = p;
    _mentionCachePromise = null;
    $("workspacePath").textContent = p || "未打开工作区";
    state.expandedDirs.clear();
    // 工作区变更时只刷新当前侧栏，避免把会话/搜索等打回资源管理器
    if (state.sideView === "explorer") await renderExplorer();
    else await refreshCurrentSideView();
    refreshGitBranch();
    EmsoderPanels.renderRules?.();
    indexWorkspaceLsp(true);
  });

  emsoder.onOpenFiles(async (files) => {
    for (const f of files || []) await openFile(f);
  });

  emsoder.onBeforeClose(async () => {
    await flushActiveToTab();
    scheduleDraftSave();
    if (hasDirtyTabs() && !(await EmsoderDom.showConfirm("有未保存的文件，确定退出？"))) return;
    if (state.generating) {
      if (!(await EmsoderDom.showConfirm("AI 正在生成，确定退出？"))) return;
      await emsoder.stopAgent();
    }
    try {
      if (hasDirtyTabs()) {
        await emsoder.saveDrafts(
          state.tabs
            .filter((t) => t.dirty)
            .map((t) => ({
              path: t.path,
              name: t.name,
              content: t.content,
              original: t.original,
            }))
        );
      } else {
        await emsoder.clearDrafts();
      }
    } catch {
      /* ignore */
    }
    await emsoder.allowClose();
  });

  async function refreshGitBranch() {
    try {
      const st = await emsoder.gitStatus();
      $("sbBranch").textContent = st.isRepo ? st.branch || "git" : "no-git";
    } catch {
      $("sbBranch").textContent = "git";
    }
  }

  async function init() {
    try {
      EmsoderPanels.init();
      loadProviderPresets(); // fire-and-forget; presets arrive before user opens the modal
      wireSkillInstallModal();
      EmsoderQuest?.init?.();
      // 默认 IDE 界面（不再默认进 Quest）
      EmsoderQuest?.bootDefault?.();
      try {
        const pref = localStorage.getItem("emsoder.ideEditorVisible");
        setEditorVisible(pref === "1", false);
      } catch {
        setEditorVisible(false, false);
      }
      syncEditorToggleUI();
      EmsoderEditor.setOnChange(() => {
        const tab = state.tabs.find((t) => t.path === state.activePath);
        if (!tab) return;
        tab.content = EmsoderEditor.getValue();
        const dirty = tab.content !== tab.original;
        // 仅 dirty 状态翻转时重绘 tab DOM，避免每次按键全量重建
        if (dirty !== tab.dirty) {
          tab.dirty = dirty;
          renderTabs();
        }
        scheduleDraftSave();
      });

      const st = await emsoder.getState();
      state.config = st.config;
      state.workspace = st.workspace || "";
      $("workspacePath").textContent = state.workspace || "未打开工作区";
      refreshModelChips();
      refreshAutoApproveBtn();
      refreshContextStats();
      if (st.session) {
        state.branchMeta = st.session.branchMeta || [];
        state.activeSessionId = st.session.id || null;
        renderHistory(st.session.messages || [], st.session.branchMeta);
        renderChatChanges(st.session.fileChanges || [], st.session.id || null);
        updateChatHeader(st.session);
      } else {
        renderChatChanges([], null);
        updateChatHeader(null);
      }
      // 启动默认侧栏：会话置顶
      state.sideView = "sessions";
      document
        .querySelectorAll(".act-btn[data-view]")
        .forEach((b) => b.classList.remove("active"));
      document
        .querySelector('.act-btn[data-view="sessions"]')
        ?.classList.add("active");
      await renderSessionsSide();
      await refreshGitBranch();
      await maybeRestoreDrafts();

      // LSP navigation from problems / definition results
      if (window.EmsoderLsp) {
        window.EmsoderLsp.onNavigate = (filePath, line, column) => {
          openFile(filePath, line, column);
        };
      }

      // warm monaco + LSP in background
      EmsoderEditor.ensure()
        .then(async () => {
          state.monacoReady = true;
          EmsoderEditor.applyConfig(state.config);
          await EmsoderEditor.enableCompletion(
            state.config?.completionEnabled !== false,
            state.config?.completionDebounceMs
          );
          // 全语言关键词补全（零依赖，不覆盖 TS/JS 等内置）
          try {
            window.EmsoderLangSuggest?.init?.();
          } catch {
            /* ignore */
          }
          if (state.workspace) {
            // delay slightly so UI paints first
            setTimeout(() => indexWorkspaceLsp(true), 400);
          }
        })
        .catch((e) => console.warn("monaco warm failed", e));

      if (state.config?.showBottomPanel === false) {
        $("bottomPanel")?.classList.add("collapsed");
      }
      if (state.config?.bottomPanelTab) {
        EmsoderPanels.showTab(state.config.bottomPanelTab);
      }

      if (!state.config?.activeModel) toast("先配置服务商和模型，才能对话");
    } catch (e) {
      console.error(e);
      toast("初始化失败: " + (e.message || e), true);
    }
  }

  init();
})();
