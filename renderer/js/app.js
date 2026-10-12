/* global emsoder, EmsoderEditor, EmsoderPanels, EmsoderLsp, EmsoderDom, EmsoderChatVirtual */
(() => {
  const state = EmsoderState.state;

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

  /**
   * 贴底跟随（聊天滚动只走这一处出口）：
   * - force=true：发消息 / 新回答开始，强制到底
   * - 否则：仅当列表处于 stickBottom 时跟随，滚轮上翻后绝不拽回
   */
  function scrollMessagesEnd(force) {
    if (chatVlist?.isActive?.()) {
      if (force) chatVlist.scrollToEnd?.();
      else chatVlist.onLiveAppend?.();
      return;
    }
    if (!messagesEl) return;
    if (!force) {
      const dist =
        messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
      if (dist > 96) return;
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
      localStorage.setItem("emsoder.chatTocOn", on ? "1" : "0");
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
      EmsoderMarkdown.setMsgBody(state.streamingEl, state.streamingRaw, !!asMarkdown);
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

  const $ = EmsoderState.$;
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
    toggleBreakpoint,
    getActivePath: () => state.activePath || "",
    showProviders: () => EmsoderProviders.show(),
    showModels: () => showModels(),
    saveActive: (...a) => window.EmsoderTabs?.saveActive?.(...a),
    fillSettingsForm: () => EmsoderSettings.fill(),
    refreshSkillsSettingsList: () => EmsoderSettings.refreshSkillsList(),
    adjustFontSize: (d) => adjustFontSize(d),
    openInlineModal: () => EmsoderInlineEdit.open(),
    openFile: (...a) => window.EmsoderTabs?.openFile?.(...a),
    refreshModelChips: () => refreshModelChips(),
    flushActiveToTab: () => window.EmsoderTabs?.flushActiveToTab?.(),
    renderTabs: () => window.EmsoderTabs?.renderTabs?.(),
    hasDirtyTabs: () => window.EmsoderTabs?.hasDirtyTabs?.(),
    getSelectionOrEmpty: () => window.EmsoderTabs?.getSelectionOrEmpty?.(),
    refreshCurrentSideView: (...a) => window.EmsoderSidePanels?.refreshCurrentSideView?.(...a),
    refreshSessionsSideIfVisible: () => window.EmsoderSidePanels?.refreshSessionsSideIfVisible?.(),
    applySessionUpdate,
    renderHistory,
    renderChatChanges,
    setEditorVisible,
    isEditorCollapsed,
    getLocalBreakpoints: (path) => localBreakpoints.get(path),
    refreshQuestModels: () => {},
  };

  const toast = (...a) => EmsoderDom.toast(...a);

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
    syncComposerGate();
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

  function refreshModelChips() {
    const c = state.config;
    if (!c) return;
    $("modelChip").textContent = c.activeModel || "选择模型";
    EmsoderReasoningMenu.refresh();
    $("sbModel").textContent = `${c.providerName || "none"} / ${c.activeModel || "?"}`;
    EmsoderPermission.refresh();
    refreshWelcomeIfEmpty();
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
    if (opts.markdown && role === "assistant") EmsoderMarkdown.setMsgBody(body, text, true);
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

  async function mutateContext(method, messageId, extra = {}) {
    try {
      const payload = { sessionId: state.activeSessionId || null, messageId, ...extra };
      const result = await method(payload);
      if (!result?.ok) throw new Error(result?.error || "上下文操作失败");
      if (result.session) await applySessionUpdate(result.session);
      window.EmsoderSidePanels?.refreshSessionsSideIfVisible?.();
      return result;
    } catch (e) {
      toast(e?.message || e || "上下文操作失败", true);
      return null;
    }
  }

  async function editAssistantMessage(messageId, content) {
    const next = await EmsoderDom.showPrompt({
      title: "编辑助手回复",
      message: "保存后会创建安全分支，原回复仍可恢复。",
      value: content || "",
      placeholder: "输入修改后的助手回复",
      confirmText: "创建分支",
    });
    if (next == null) return;
    if (!String(next).trim()) { toast("回复不能为空", true); return; }
    const r = await mutateContext(emsoder.editAssistantContextMessage, messageId, { content: String(next) });
    if (r) toast("已创建修改后的助手分支");
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
          hasToolCalls: Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
          excludedFromContext: !!m.excludedFromContext,
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

  function chatHasMessages() {
    return !!(state._histList && state._histList.length);
  }

  function hasPendingReview() {
    return (state.fileChanges || []).some((f) => f && !f.rejected);
  }

  function welcomeState() {
    const hasWs = !!state.workspace;
    const hasModel = !!state.config?.activeModel;
    if (!hasWs && !hasModel) {
      return {
        title: "先准备两件事",
        body: "打开文件夹，再选模型。然后说话，文件会改，你审。",
        folder: true,
        providers: true,
      };
    }
    if (!hasWs) {
      return {
        title: "先打开文件夹",
        body: "要改文件，先打开一个文件夹。",
        folder: true,
        providers: false,
      };
    }
    if (!hasModel) {
      return {
        title: "还没模型",
        body: "点服务商，填自己的 Key 或本地模型。钥匙在你手里。",
        folder: false,
        providers: true,
      };
    }
    return {
      title: "今天想写点什么？",
      body: "说话，文件会改。你审。确认或撤销都在本轮改动里。",
      folder: false,
      providers: false,
    };
  }

  function paintWelcome() {
    const w = welcomeState();
    const actions = [];
    if (w.folder) {
      actions.push(
        '<button type="button" class="btn primary" data-welcome="folder">打开文件夹</button>'
      );
    }
    if (w.providers) {
      actions.push(
        '<button type="button" class="btn" data-welcome="providers">服务商</button>'
      );
    }
    messagesEl.innerHTML =
      `<div class="welcome">` +
      `<div class="logo-lg" aria-hidden="true">` +
      `<img class="logo-img" src="assets/logo.png" alt="" width="64" height="64" draggable="false" />` +
      `</div>` +
      `<h2>${escapeHtml(w.title)}</h2>` +
      `<div>${escapeHtml(w.body)}</div>` +
      (actions.length
        ? `<div class="welcome-actions">${actions.join("")}</div>`
        : "") +
      `</div>`;
  }

  function syncComposerGate() {
    const hasWs = !!state.workspace;
    const hasModel = !!state.config?.activeModel;
    const blockedModel = !hasModel;
    const blockedFolder = !hasWs;
    const reviewing = hasPendingReview() && !state.generating;
    const busy = !!state.generating || state.queueDepth > 0;
    let ph = "对话… Enter 发送，Shift+Enter 换行 · 输入 @ 可引用工作区文件";
    if (reviewing) ph = "先确认或撤销本轮改动。";
    else if (busy) ph = "生成中，做完后才能再发。";
    else if (blockedModel) ph = "还没模型。点顶栏「服务商」。";
    else if (blockedFolder) ph = "先打开文件夹，才能改文件。";
    if (inputEl) {
      inputEl.placeholder = ph;
      inputEl.disabled = reviewing;
    }
    const send = $("btnSend");
    const sendDisabled = !!(blockedModel || blockedFolder || reviewing || busy);
    const wasDisabled = send ? !!send.disabled : true;
    if (send) send.disabled = sendDisabled;
    if (wasDisabled && !sendDisabled && state.notifyWhenSendable) {
      state.notifyWhenSendable = false;
      if (state.config?.soundEnabled !== false) {
        try { EmsoderDom.playDoneChime?.(state.config?.soundVolume ?? 1.0); } catch { /* ignore */ }
      }
    }
    if (!sendDisabled) state.notifyWhenSendable = false;
    const gate = $("reviewGate");
    if (gate) gate.hidden = !reviewing;
    $("chatComposer")?.classList.toggle("hidden", reviewing);
    $("resizeChatComposer")?.classList.toggle("hidden", reviewing);
    $("chatPanel")?.classList.toggle("chat-empty", !chatHasMessages());
    $("chatPanel")?.classList.toggle("need-setup", !!(blockedModel || blockedFolder));
    $("chatPanel")?.classList.toggle("chat-reviewing", reviewing);
  }

  function refreshWelcomeIfEmpty() {
    if (chatHasMessages()) {
      syncComposerGate();
      return;
    }
    paintWelcome();
    refreshChatToc();
    syncComposerGate();
  }

  function renderHistory(list, branchMeta) {
    if (!list?.length) {
      chatVlist?.clear?.();
      state._histList = [];
      paintWelcome();
      refreshChatToc();
      syncComposerGate();
      return;
    }
    const meta = branchMetaMap(list, branchMeta || state.branchMeta);
    state._histList = list;
    state._histMeta = branchMeta || state.branchMeta;
    const vl = ensureChatVlist();
    if (vl) {
      vl.setItems(list);
      refreshChatToc();
      syncComposerGate();
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
    syncComposerGate();
  }

  /** 本轮 Agent 写盘：确认或撤销 */
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
      syncComposerGate();
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
        if (f.path) window.EmsoderTabs?.openFile?.(f.path);
      };
      pathEl.onclick = () => showFileChangeDiff(f);
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
                window.EmsoderTabs?.renderTabs?.();
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
    syncComposerGate();
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
        extraAttachments = await window.EmsoderMention?.resolveAtMentions?.(typed);
      } catch { /* ignore */ }
    }
    const modelText = [typed, pack.modelText].filter(Boolean).join("\n\n");
    const displayText = [typed, pack.displayText].filter(Boolean).join("\n\n");
    if (!modelText) return;
    if (!state.config?.activeModel) {
      toast("还没模型。先点服务商。", true);
      EmsoderProviders.show();
      refreshWelcomeIfEmpty();
      return;
    }
    if (!state.workspace) {
      toast("先打开文件夹，才能改文件。", true);
      $("btnOpenFolder")?.click();
      refreshWelcomeIfEmpty();
      return;
    }
    if (state.generating || state.queueDepth > 0) {
      toast("当前会话还在生成或排队。其他工作区可切换会话后并行执行。", true);
      syncComposerGate();
      return;
    }
    if (hasPendingReview()) {
      toast("先确认或撤销本轮改动。", true);
      syncComposerGate();
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
      sessionId: state.activeSessionId || null,
      workspaceRoot: state.workspace,
      activeFile: state.activePath || "",
      selection: window.EmsoderTabs?.getSelectionOrEmpty?.(),
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
      ...(state.config?.runMode === "plan" || state.config?.runMode === "goal"
        ? { runMode: state.config.runMode }
        : {}),
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
      const hist = (state._histList || []).find((m) => m.id === mid) || null;
      const hasToolCalls = !!(hist?.tool_calls && hist.tool_calls.length);
      if (mid && (role === "user" || role === "assistant")) {
        items.push({ sep: true });
        if (role === "user") {
          items.push({ label: "编辑并重新发送（新分支）", run: () => beginEditMessage(mid, raw) });
        } else if (!hasToolCalls) {
          items.push({ label: "编辑助手回复（新分支）", run: () => editAssistantMessage(mid, raw) });
        }
        if (hist?.excludedFromContext) {
          items.push({ label: "恢复到当前上下文", run: () => mutateContext(emsoder.restoreContextMessage, mid).then((r) => r && toast("已恢复分支到上下文")) });
        } else {
          items.push({ label: "从当前上下文移除", run: () => mutateContext(emsoder.excludeContextMessage, mid).then((r) => r && toast("已从后续上下文移除该分支")) });
        }
        for (const branch of (state.excludedBranches || []).filter((b) => b.parentId === mid)) {
          items.push({
            label: `恢复已移除分支：${branch.preview || "（空消息）"}`,
            run: () => mutateContext(emsoder.restoreContextMessage, branch.id).then((r) => r && toast("已恢复分支到上下文")),
          });
        }
        items.push({
          label: "永久删除此分支…",
          run: async () => {
            const ok = await EmsoderDom.showConfirm("将永久删除此消息及之后的所有回复、工具调用和分支。此操作不可恢复，确定继续？");
            if (ok) await mutateContext(emsoder.deleteContextMessage, mid, { confirmed: true });
          },
        });
      }
      if (role === "user" && mid) {
        items.push({ label: "上一个分支", run: () => switchBranchAt(mid, "prev") });
        items.push({ label: "下一个分支", run: () => switchBranchAt(mid, "next") });
      }
      showMsgMenu(e.clientX, e.clientY, items);
      return;
    }
    // Empty chat area: provide a recovery entry for branches removed from context.
    if (e.target.closest?.("#messages") && state.excludedBranches?.length) {
      e.preventDefault();
      showMsgMenu(e.clientX, e.clientY, state.excludedBranches.map((b) => ({
        label: `恢复已移除分支：${b.preview || "（空消息）"}`,
        run: () => mutateContext(emsoder.restoreContextMessage, b.id).then((r) => r && toast("已恢复分支到上下文")),
      })));
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

  $("btnSaveSettings").onclick = async () => {
    state.config = await emsoder.updateConfig({
      agentMode: true,
      agentBackend: $("stAgentBackend")?.value === "pi" ? "pi" : "emsoder",
      runMode: (() => {
        const v = $("stRunMode")?.value;
        return v === "plan" || v === "goal" ? v : "auto";
      })(),
      terminalRunMode: $("stTerminal").value,
      permissionMode: EmsoderPermission.normalize(
        $("stPermissionMode")?.value || state.config?.permissionMode
      ),
      collapseProcess: $("stCollapseProcess")
        ? $("stCollapseProcess").value === "true"
        : true,
      completionEnabled: $("stCompletion").value === "true",
      responseLanguage: $("stLang").value,
      maxTokens: Math.max(0, Math.floor(Number($("stMaxTokens").value) || 0)),
      temperature: Number($("stTemp").value) || 0.2,
      reasoningEffort: EmsoderReasoningMenu.normalize(
        $("stReasoningEffort")?.value || "medium"
      ),
      agentMaxRounds: (() => {
        const n = Number($("stAgentMaxRounds")?.value);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return Math.max(4, Math.floor(n));
      })(),
      agentAutoContinue: (() => {
        const raw = $("stAgentAutoContinue")?.value;
        if (raw === "" || raw == null) return -1;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) return -1;
        return Math.floor(n);
      })(),
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
      contextWindow: Math.max(0, Math.floor(Number($("stContextWindow")?.value) || 0)),
      autoCompressAt: (() => {
        const n = Number($("stAutoCompressAt")?.value);
        if (!Number.isFinite(n)) return 80;
        return Math.max(40, Math.min(99, Math.floor(n)));
      })(),
      soundEnabled: $("stSoundEnabled")
        ? $("stSoundEnabled").value === "true"
        : true,
      soundVolume: (() => {
        const n = Number($("stSoundVolume")?.value);
        if (!Number.isFinite(n)) return 1.0;
        return Math.max(0, Math.min(1, n));
      })(),
      floatingBallEnabled: $("stFloatingBall")
        ? $("stFloatingBall").value === "true"
        : false,
      imageProvider: $("stImageProvider")
        ? ($("stImageProvider").value === "unsplash" ? "unsplash" : "pexels")
        : "pexels",
      // 图片 Key：留空 = 不改动（主进程会忽略空串/***）
      pexelsApiKey: $("stPexelsKey") ? $("stPexelsKey").value.trim() : "",
      unsplashApiKey: $("stUnsplashKey") ? $("stUnsplashKey").value.trim() : "",
      imageGenBackend: $("stImageGenBackend")?.value || "modelscope",
      imageGenModel: $("stImageGenModel")?.value.trim() || "",
      imageGenBaseUrl: $("stImageGenBaseUrl")?.value.trim() || "",
      imageGenApiKey: $("stImageGenKey") ? $("stImageGenKey").value.trim() : "",
    });
    refreshModelChips();
    EmsoderPermission.refresh();
    EmsoderEditor.applyConfig(state.config);
    await EmsoderEditor.enableCompletion(
      state.config.completionEnabled !== false,
      state.config.completionDebounceMs
    );
    closeModal("modalSettings");
    toast("设置已保存");
  };

  $("btnTestImageGen")?.addEventListener("click", async () => {
    const result = $("stImageGenTestResult");
    const btn = $("btnTestImageGen");
    try {
      // Persist only the image-generation fields first; blank/masked Key stays protected by main IPC.
      state.config = await emsoder.updateConfig({
        imageGenBackend: $("stImageGenBackend")?.value || "modelscope",
        imageGenModel: $("stImageGenModel")?.value.trim() || "",
        imageGenBaseUrl: $("stImageGenBaseUrl")?.value.trim() || "",
        imageGenApiKey: $("stImageGenKey")?.value.trim() || "",
      });
      if (btn) { btn.disabled = true; btn.textContent = "生成测试图中…"; }
      if (result) result.textContent = "真实测试会消耗一次图片额度，请稍候…";
      const r = await emsoder.testImageGeneration?.();
      if (r?.ok) {
        if (result) result.textContent = `通过：${r.backend} · ${r.model} · ${r.bytes} bytes（临时图片已删除）`;
        toast("图片生成测试通过");
      } else {
        if (result) result.textContent = `失败：${r?.error || "未知错误"}`;
        toast(r?.error || "图片生成测试失败", true);
      }
    } catch (e) {
      if (result) result.textContent = `失败：${e.message || e}`;
      toast(e.message || e || "图片生成测试失败", true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "测试图片生成（消耗一次额度）"; }
    }
  });

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
      EmsoderSettings.fill();
      EmsoderEditor.applyConfig?.(state.config);
      window.EmsoderApp.refreshQuestModels?.();
      toast("配置已导入");
    } catch (e) {
      toast(e.message || e, true);
    }
  });

  $("btnExportLogs")?.addEventListener("click", async () => {
    try {
      const r = await emsoder.exportLogs();
      if (r?.canceled) return;
      if (!r?.ok) {
        toast(r?.error || "导出失败", true);
        return;
      }
      toast("日志已导出: " + (r.path || "") + "（" + (r.files || []).join(", ") + "）");
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

  // ---------- Bindings ----------
  messagesEl?.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-welcome]");
    if (!btn) return;
    const act = btn.getAttribute("data-welcome");
    if (act === "folder") $("btnOpenFolder")?.click();
    else if (act === "providers") EmsoderProviders.show();
  });
  $("btnSend").onclick = () => sendMessage();
  const permBtn = $("btnPermissionMode") || $("btnAutoApprove");
  permBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    EmsoderPermission.toggle();
  });
  $("permMenu")?.addEventListener("click", async (e) => {
    const item = e.target.closest?.(".perm-item[data-mode]");
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      await EmsoderPermission.setMode(item.dataset.mode);
    } catch (err) {
      toast(err?.message || err, true);
    }
  });
  // 点外面 / Esc 关闭
  document.addEventListener(
    "click",
    (e) => {
      const wrap = $("permWrap");
      if (!wrap || wrap.contains(e.target)) return;
      EmsoderPermission.close();
    },
    true
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") EmsoderPermission.close();
  });
  $("btnAttach")?.addEventListener("click", () => addAttachmentsFromPicker());
  function stopAndClear() {
    if (state.generating || state.queueDepth > 0) {
      state.notifyWhenSendable = false;
      emsoder.stopAgent({ sessionId: state.activeSessionId || null });
      setQueueDepth(0);
      setGenerating(false, "已停止");
      toast("已停止当前会话任务；其它工作区继续运行");
    }
  }
  $("btnStop2")?.addEventListener("click", stopAndClear);
  $("btnStop")?.addEventListener("click", stopAndClear);

  async function applySessionUpdate(s) {
    state.branchMeta = s.branchMeta || [];
    state.excludedBranches = s.excludedBranches || [];
    state.activeSessionId = s.id || null;
    if (s.workspaceRoot != null) {
      state.workspace = s.workspaceRoot || "";
      $("workspacePath").textContent = state.workspace || "未打开工作区";
    }
    cancelEditMode();
    renderHistory(s.messages || [], s.branchMeta);
    renderChatChanges(s.fileChanges || [], s.id || null);
    updateChatHeader(s);
    // Composer state follows the session we just switched to: only treat it as
    // "generating" if THIS session is the one currently running.
    const runtime = s?.id ? state.sessionRuntime.get(s.id) : null;
    const running = (s?.runStatus || "idle") === "running" || runtime?.state === "running";
    state.notifyWhenSendable = false;
    setQueueDepth(runtime?.state === "queued" ? 1 : 0);
    setGenerating(running, runtime?.state === "queued" ? "当前工作区任务排队中" : (running ? "生成中" : "就绪"));
  }

  /** Chat header 同步当前会话标题/模式 */
  function updateChatHeader(s) {
    const titleEl = $("chatTitle");
    const subEl = $("chatSub");
    if (titleEl) titleEl.textContent = s?.title || "AI 助手";
      if (subEl) {
      const run = s?.runStatus || "idle";
      const runLabel =
        run === "running"
          ? "跑"
          : run === "stopped"
            ? "停"
            : run === "review"
              ? "待审"
              : "";
      const base = "可读写文件";
      subEl.textContent = runLabel ? runLabel + " · " + base : base;
    }
  }
  $("btnNewChat").onclick = async () => {
    try {
      applySessionUpdate(await emsoder.newSession());
      toast("已创建新会话");
      if (state.sideView === "sessions") await window.EmsoderSidePanels?.renderSessionsSide?.();
    } catch (e) {
      toast(e?.message || e || "创建失败", true);
    }
  };
  $("btnClearChat").onclick = async () => {
    if (!(await EmsoderDom.showConfirm("清空当前会话？（会话保留，标题重置为「新对话」）"))) return;
    try {
      applySessionUpdate(await emsoder.clearSession());
      toast("已清空会话");
      await window.EmsoderSidePanels?.refreshSessionsSideIfVisible?.();
    } catch (e) {
      toast(e.message || e, true);
    }
  };

  $("btnCompressContext")?.addEventListener("click", async () => {
    if (state.generating || state.queueDepth > 0) {
      toast("生成中无法压缩，请先停止", true);
      return;
    }
    const ok = await EmsoderDom.showConfirm(
      "压缩当前会话上下文？\n\n会把较早对话收成摘要，并保留最近约 8 条可见消息原文。\n其它分支不会保留。生成中不可用。"
    );
    if (!ok) return;
    const btn = $("btnCompressContext");
    const prev = btn?.textContent;
    try {
      if (btn) {
        btn.disabled = true;
        btn.textContent = "压缩中…";
      }
      setGenerating(true, "压缩上下文");
      const r = await emsoder.compressSession({ keepRecent: 8 });
      if (!r?.ok) {
        toast(r?.error || "压缩失败", true);
        if (r?.session) applySessionUpdate(r.session);
        return;
      }
      if (r.session) applySessionUpdate(r.session);
      if (r.stats) EmsoderContextStats.update(r.stats);
      else {
        try {
          const st = await emsoder.getContextStats?.();
          if (st) EmsoderContextStats.update(st);
        } catch {
          /* ignore */
        }
      }
      toast(
        `已压缩：路径 ${r.pathCount || "?"} → ${r.afterCount || "?"} 条（保留 ${r.keptCount || 0}，摘要折叠 ${r.olderCount || 0}）`
      );
      await window.EmsoderSidePanels?.refreshSessionsSideIfVisible?.();
    } catch (e) {
      toast(e?.message || e || "压缩失败", true);
    } finally {
      setGenerating(false, "就绪");
      if (btn) {
        btn.disabled = false;
        btn.textContent = prev || "压缩上下文";
      }
    }
  });
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
      window.EmsoderTabs?.renderTabs?.();
      const results = Array.isArray(r?.results) ? r.results : [];
      const failed = results.filter((x) => x && x.ok === false).length;
      const done = results.filter((x) => x && x.ok !== false).length;
      toast(failed ? `已撤销 ${done} 个，${failed} 个未撤销（文件已变化）` : "本轮改动已全部撤销", !!failed);
    } catch (err) {
      toast(err.message || String(err), true);
    }
  });
  $("btnOpenFolder").onclick = async () => {
    const p = await emsoder.openWorkspace({ sessionId: state.activeSessionId || null });
    if (p) {
      state.workspace = p;
      window.EmsoderMention?.invalidateCache?.();
      $("workspacePath").textContent = p;
      state.expandedDirs.clear();
      // 打开文件夹后：若当前在资源管理器则刷新树，否则不抢侧栏
      if (state.sideView === "explorer") await window.EmsoderSidePanels?.renderExplorer?.();
      refreshGitBranch();
      refreshWelcomeIfEmpty();
    }
  };
  $("btnRefreshTree").onclick = () => window.EmsoderSidePanels?.refreshCurrentSideView?.();
  $("btnProviders").onclick = () => EmsoderProviders.show();
  $("btnSelectModel").onclick = showModels;
  $("modelChip").onclick = showModels;
  $("reasoningChip")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    EmsoderReasoningMenu.toggle();
  });
  $("reasonMenu")?.addEventListener("click", async (e) => {
    const item = e.target.closest?.(".reason-item[data-effort]");
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      await EmsoderReasoningMenu.setEffort(item.dataset.effort);
    } catch (err) {
      toast(err?.message || String(err), true);
    }
  });
  document.addEventListener(
    "click",
    (e) => {
      const wrap = $("reasonWrap");
      if (!wrap || wrap.contains(e.target)) return;
      EmsoderReasoningMenu.close();
    },
    true
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") EmsoderReasoningMenu.close();
  });
  $("sbModel").onclick = showModels;
  $("sbContext")?.addEventListener("click", () => EmsoderContextStats.openEditor());
  $("sbCache")?.addEventListener("click", () => EmsoderContextStats.refresh());

  $("btnToggleChat").onclick = () => {
    mainLayout.classList.toggle("chat-collapsed");
    EmsoderEditor.layout();
  };
  $("btnToggleEditor")?.addEventListener("click", () => toggleEditorPanel());
  $("btnToggleEditor2")?.addEventListener("click", () => toggleEditorPanel());
  $("btnShowEditorFromChat")?.addEventListener("click", () => setEditorVisible(true));

  // 昼夜模式切换
  function applyTheme(mode) {
    const m = mode === "light" ? "light" : "dark";
    document.body.setAttribute("data-theme", m);
    document.documentElement.setAttribute("data-theme", m);
    try { localStorage.setItem("emsoder-theme", m); } catch {}
    // 联动 Monaco 编辑器主题
    try {
      window.monaco?.editor?.setTheme?.(m === "light" ? "emsoder-light" : "emsoder-sky");
    } catch { /* monaco not ready yet */ }
    try {
      window.EmsoderPanels?.applyTheme?.();
    } catch { /* terminal not ready */ }
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

  // 对话目录：默认关，不抢改动条
  $("btnToggleChatToc")?.addEventListener("click", () => {
    const toc = $("chatToc");
    const next = !!(toc && toc.hidden);
    setChatTocVisible(next);
    if (next) refreshChatToc();
  });
  try {
    const tocPref = localStorage.getItem("emsoder.chatTocOn");
    setChatTocVisible(tocPref === "1");
  } catch {
    setChatTocVisible(false);
  }
  refreshChatToc();

  const toggleBottom = () => {
    $("bottomPanel")?.classList.toggle("collapsed");
    EmsoderEditor.layout();
    window.EmsoderResize?.syncBottomResizerVisibility?.();
    setTimeout(() => EmsoderPanels?.resizeTerm?.(), 80);
  };
  $("btnToggleBottom").onclick = () => toggleBottom();
  $("btnToggleBottom2")?.addEventListener("click", () => toggleBottom());

  $("btnAddSelection").onclick = () => window.EmsoderTabs?.addSelectionToChat?.("请基于选中代码：");
  $("btnAddSelection2").onclick = () => window.EmsoderTabs?.addSelectionToChat?.("请基于选中代码：");
  $("btnExplain").onclick = () => {
    const sel = window.EmsoderTabs?.getSelectionOrEmpty?.();
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
        window.EmsoderMention?.renderMentionList?.();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        m.index = Math.max(m.index - 1, 0);
        window.EmsoderMention?.renderMentionList?.();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        window.EmsoderMention?.selectMentionAt?.(m.index);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        window.EmsoderMention?.hideMentionPopup?.();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      window.EmsoderMention?.hideMentionPopup?.();
      sendMessage();
    }
  });

  // Debounce @ mention trigger: avoids IPC + 600-item filter on every keystroke
  let _atDebounceTimer = null;
  inputEl.addEventListener("input", () => {
    clearTimeout(_atDebounceTimer);
    _atDebounceTimer = setTimeout(() => window.EmsoderMention?.detectAtTrigger?.(), 80);
  });

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      EmsoderPalette.open();
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
      window.EmsoderTabs?.saveActive?.();
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
      window.EmsoderTabs?.addSelectionToChat?.("请基于选中代码：");
    }
    if (e.ctrlKey && e.key.toLowerCase() === "i") {
      e.preventDefault();
      EmsoderInlineEdit.open();
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
      mainLayout.classList.remove("quest-mode");
      if (state.sideView === "explorer") await window.EmsoderSidePanels?.renderExplorer?.();
      else if (state.sideView === "sessions") await window.EmsoderSidePanels?.renderSessionsSide?.();
      else if (state.sideView === "search") EmsoderSearchSide.render();
      else if (state.sideView === "git") window.EmsoderSidePanels?.renderGitSide?.();
      else if (state.sideView === "skills") await EmsoderSkillsSide.render();
      else if (state.sideView === "memory") await EmsoderMemorySide.render();
      else if (state.sideView === "mcp") await EmsoderMcpSide.render();
      else if (state.sideView === "env") await EmsoderEnvSide.render();
      else if (state.sideView === "settings") {
        openModal("modalSettings");
        EmsoderSettings.fill();
      }
    });
  });

  $("btnReviewAccept")?.addEventListener("click", () => $("btnAcceptAllChanges")?.click());
  $("btnReviewReject")?.addEventListener("click", () => $("btnRejectAllChanges")?.click());

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
    const tasks = Array.isArray(msg.tasks) ? msg.tasks : [];
    state.sessionRuntime.clear();
    for (const task of tasks) {
      if (task?.sessionId) state.sessionRuntime.set(task.sessionId, task);
    }
    const own = state.activeSessionId ? state.sessionRuntime.get(state.activeSessionId) : null;
    const ownQueued = own?.state === "queued" ? 1 : 0;
    setQueueDepth(ownQueued);
    if (own?.state === "running" && !state.generating) {
      setGenerating(true, "当前工作区任务运行中");
    } else if (!own && !state.generating) {
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
    if (msg.action === "providers") setTimeout(() => EmsoderProviders.show(), 200);
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
      window.EmsoderMention?.invalidateCache?.();
      for (const p of paths) {
        if (!state.tabs.some((t) => t.path === p)) continue;
        try {
          const f = await emsoder.readFile(p);
          const tab = state.tabs.find((t) => t.path === f.path);
          if (!tab) continue;
          // 任何有未保存修改的标签都不自动覆盖（含非活动标签），防止静默丢数据
          if (tab.dirty) {
            if (state.activePath === f.path) {
              toast("磁盘已更新，本地有未保存修改，未自动覆盖", true);
            }
            continue;
          }
          tab.content = f.content;
          tab.original = f.content;
          tab.dirty = false;
          if (state.activePath === f.path) {
            await EmsoderEditor.openDocument({ path: f.path, content: f.content });
          }
          window.EmsoderTabs?.renderTabs?.();
        } catch {
          /* 文件可能被删除 */
        }
      }
      if (state.sideView === "explorer") window.EmsoderSidePanels?.renderExplorer?.();
      EmsoderPanels.refreshGit?.();
      refreshGitBranch();
    }, 300);
  }

  // 主进程配置变更（设置保存/导入）实时同步到渲染层，避免静音/上下文窗口
  // 等设置因本地快照过期而失效。
  emsoder.onConfigChanged?.((fresh) => {
    if (!fresh || typeof fresh !== "object") return;
    state.config = fresh;
    try { window.EmsoderSettings?.fill?.(); } catch { /* ignore */ }
    if (state.sideView === "env") window.EmsoderEnvSide?.render?.();
    refreshModelChips();
    EmsoderPermission.refresh();
  });

  emsoder.onAgentEvent((msg) => {
    // A turn is pinned to the session it started in. If the user switched to a
    // different session while it runs, its streamed chunks must NOT touch the
    // visible chat DOM — only status/session bookkeeping applies. `session`,
    // `queue`, `context_stats`, `fs_change` are global and always processed.
    const perSession = new Set([
      "user", "assistant_start", "assistant_delta", "reasoning_delta",
      "tool_start", "tool_end", "file_changes", "assistant_done", "error", "status",
    ]);
    const msgSession = msg.sessionId || null;
    const onScreen = !msgSession || msgSession === state.activeSessionId;
    if (perSession.has(msg.type) && !onScreen) {
      // Background session's turn: keep status label / sidebar fresh, skip DOM.
      if (msg.type === "assistant_done") {
        window.EmsoderSidePanels?.refreshSessionsSideIfVisible?.();
      }
      return;
    }
    switch (msg.type) {
      case "queue":          _onAgentQueue(msg); break;
      case "branch":
        if (msg.session) { state.branchMeta = msg.session.branchMeta || []; renderHistory(msg.session.messages || [], msg.session.branchMeta); }
        break;
      case "user":
        addMsg("user", msg.text, null, { messageId: msg.messageId || "" });
        // 用户发出消息：强制贴底，方便看后续回答
        scrollMessagesEnd(true);
        break;
      case "assistant_start":
        resetStreamUi();
        state.streamingEl = addMsg("assistant", "");
        setGenerating(true, "生成中");
        scrollMessagesEnd(true);
        break;
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
        state.activeToolRow = null;
        state.notifyWhenSendable = msg.reason === "done" || !msg.reason;
        setGenerating(false, msg.reason === "stopped" ? "已停止" : msg.reason === "error" ? "失败" : "完成");
        try { refreshChatToc(); } catch { /* ignore */ }
        break;
      case "session":
        if (msg.session) {
          // Only rebind the visible chat if this update is for the session on
          // screen. A background turn finishing must not hijack the view.
          const sid = msg.session.id || null;
          if (!state.activeSessionId || sid === state.activeSessionId) {
            state.branchMeta = msg.session.branchMeta || [];
            state.activeSessionId = sid;
            updateChatHeader(msg.session);
            if (Array.isArray(msg.session.fileChanges)) renderChatChanges(msg.session.fileChanges, sid);
            if (!state.generating) renderHistory(msg.session.messages || [], msg.session.branchMeta);
            else try { refreshChatToc(); } catch { /* ignore */ }
          }
          // 侧栏数据已由主进程下发：静默刷新会话列表（标题/消息数/排序）
          if (Array.isArray(msg.sessions)) window.EmsoderSidePanels?.refreshSessionsSideIfVisible?.();
        }
        break;
      case "plan_ready":    showPlanApproval(msg.planText || "", msg.note || ""); break;
      case "error":          _onAgentError(msg); break;
      case "status":         _onAgentStatus(msg); break;
      case "context_stats":  EmsoderContextStats.update(msg.stats); break;
      case "fs_change":      _onAgentFsChange(msg); break;
    }
  });

  emsoder.onConfirm((data) => {
    state.pendingConfirmId = data.id;
    $("confirmMsg").textContent = data.message;
    $("confirmBar").classList.add("show");
  });

  // Pi plan 模式：计划审批栏
  function showPlanApproval(planText, note) {
    const bar = $("planBar");
    if (!bar) return;
    state.pendingPlan = planText;
    $("planMsg").textContent =
      (note ? note + "\n" : "") + (planText || "").slice(0, 2000) +
      ((planText || "").length > 2000 ? "…" : "");
    bar.classList.add("show");
  }
  function hidePlanApproval() {
    const bar = $("planBar");
    if (bar) bar.classList.remove("show");
    state.pendingPlan = null;
  }
  $("btnPlanApprove")?.addEventListener("click", () => {
    if (!state.pendingPlan) return;
    hidePlanApproval();
    setGenerating(true, "按计划执行中");
    emsoder.sendAgent({
      text: "批准计划：按上面的计划开始执行。",
      displayText: "✅ 批准计划，开始执行",
      planApproved: true,
      runMode: "plan",
    });
  });
  $("btnPlanReject")?.addEventListener("click", () => {
    hidePlanApproval();
    toast("已取消计划。你可以直接改需求再发。");
  });

  emsoder.onMcpEvent?.((msg) => {
    // server 状态/工具列表变化 → 静默刷新 MCP 侧栏
    if (state.sideView === "mcp") EmsoderMcpSide.refreshIfVisible();
  });

  emsoder.onMenu("save", () => window.EmsoderTabs?.saveActive?.());
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
  emsoder.onMenu("reindexLsp", () => window.EmsoderTabs?.indexWorkspaceLsp?.(false));
  emsoder.onMenu("newChat", () => $("btnNewChat").click());
  emsoder.onMenu("selectModel", showModels);
  emsoder.onMenu("providers", () => EmsoderProviders.show());
  emsoder.onMenu("addSelection", () => window.EmsoderTabs?.addSelectionToChat?.("请基于选中代码："));
  emsoder.onMenu("explainSelection", () => $("btnExplain").click());
  emsoder.onMenu("inlineEdit", () => EmsoderInlineEdit.open());
  emsoder.onMenu("genCommit", async () => {
    $("bottomPanel")?.classList.remove("collapsed");
    EmsoderPanels.showTab("git");
    $("btnGenCommit")?.click();
  });

  emsoder.onWorkspaceChanged(async (payload) => {
    const p = typeof payload === "string" ? payload : (payload?.workspaceRoot || "");
    const sessionId = typeof payload === "object" ? payload?.sessionId : null;
    // A background session changing root must not replace the visible workspace.
    if (sessionId && state.activeSessionId && sessionId !== state.activeSessionId) return;
    state.workspace = p;
    window.EmsoderMention?.invalidateCache?.();
    $("workspacePath").textContent = p || "未打开工作区";
    state.expandedDirs.clear();
    // 工作区变更时只刷新当前侧栏，避免把会话/搜索等打回资源管理器
    if (state.sideView === "explorer") await window.EmsoderSidePanels?.renderExplorer?.();
    else await window.EmsoderSidePanels?.refreshCurrentSideView?.();
    refreshGitBranch();
    EmsoderPanels.renderRules?.();
    refreshWelcomeIfEmpty();
  });

  emsoder.onOpenFiles(async (files) => {
    for (const f of files || []) await window.EmsoderTabs?.openFile?.(f);
  });

  emsoder.onBeforeClose(async () => {
    await window.EmsoderTabs?.flushActiveToTab?.();
    window.EmsoderDrafts?.scheduleDraftSave?.();
    if (window.EmsoderTabs?.hasDirtyTabs?.() && !(await EmsoderDom.showConfirm("有未保存的文件，确定退出？"))) return;
    if (state.generating) {
      if (!(await EmsoderDom.showConfirm("AI 正在生成，确定退出？"))) return;
      await emsoder.stopAgent();
    }
    try {
      if (window.EmsoderTabs?.hasDirtyTabs?.()) {
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
      EmsoderProviders.loadPresets(); // fire-and-forget; presets arrive before user opens the modal
      EmsoderSkillsSide.wireInstallModal();
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
          window.EmsoderTabs?.renderTabs?.();
        }
        window.EmsoderDrafts?.scheduleDraftSave?.();
      });

      const st = await emsoder.getState();
      state.config = st.config;
      state.workspace = st.workspace || "";
      $("workspacePath").textContent = state.workspace || "未打开工作区";
      refreshModelChips();
      EmsoderPermission.refresh();
      EmsoderContextStats.refresh();
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
      await window.EmsoderSidePanels?.renderSessionsSide?.();
      await refreshGitBranch();
      await window.EmsoderDrafts?.maybeRestoreDrafts?.();

      // LSP navigation from problems / definition results
      if (window.EmsoderLsp) {
        window.EmsoderLsp.onNavigate = (filePath, line, column) => {
          window.EmsoderTabs?.openFile?.(filePath, line, column);
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
          // 打开工作区不再自动全仓 LSP 索引（CUT-PARITY Step 4）
        })
        .catch((e) => console.warn("monaco warm failed", e));

      if (state.config?.showBottomPanel === false) {
        $("bottomPanel")?.classList.add("collapsed");
      }
      if (state.config?.bottomPanelTab) {
        const tab = state.config.bottomPanelTab;
        if (tab !== "debug" && tab !== "problems") {
          EmsoderPanels.showTab(tab);
        }
      }

      refreshWelcomeIfEmpty();
    } catch (e) {
      console.error(e);
      toast("初始化失败: " + (e.message || e), true);
    }
  }

  init();
})();
