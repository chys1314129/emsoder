/* EmsoderPalette: Ctrl+Shift+P command palette.
   Depends on: EmsoderState ($), EmsoderDom (escapeHtml/openModal/closeModal/toast),
   EmsoderEditor/EmsoderPanels/EmsoderQuest.
   App-only functions are reached defensively via window.EmsoderApp?.fn?.()
   (app.js loads last; these run at user-click time, not at load time). */
(() => {
  const $ = EmsoderState.$;
  const escapeHtml = (s) => EmsoderDom.escapeHtml(s);
  const openModal = (id) => EmsoderDom.openModal(id);
  const closeModal = (id) => EmsoderDom.closeModal(id);
  const toast = (...a) => EmsoderDom.toast(...a);

  function paletteCommands() {
    return [
      { id: "openFolder", label: "打开文件夹", hint: "Ctrl+O", run: () => $("btnOpenFolder")?.click() },
      { id: "save", label: "保存当前文件", hint: "Ctrl+S", run: () => window.EmsoderApp?.saveActive?.() },
      { id: "providers", label: "管理服务商 / 第三方模型", hint: "", run: () => window.EmsoderApp?.showProviders?.() },
      { id: "models", label: "选择模型", hint: "", run: () => window.EmsoderApp?.showModels?.() },
      { id: "newChat", label: "新建对话", hint: "", run: () => $("btnNewChat")?.click() },
      { id: "terminal", label: "打开终端", hint: "Ctrl+`", run: () => {
        $("bottomPanel")?.classList.remove("collapsed");
        EmsoderPanels.showTab("terminal");
      } },
      { id: "git", label: "打开 Git 面板", hint: "", run: () => {
        $("bottomPanel")?.classList.remove("collapsed");
        EmsoderPanels.showTab("git");
      } },
      { id: "settings", label: "打开设置", hint: "", run: () => {
        window.EmsoderApp?.fillSettingsForm?.();
        openModal("modalSettings");
      } },
      {
        id: "skills",
        label: "查看 Skills（zcode / agents）",
        hint: "",
        run: async () => {
          window.EmsoderApp?.fillSettingsForm?.();
          openModal("modalSettings");
          await window.EmsoderApp?.refreshSkillsSettingsList?.();
        },
      },
      { id: "exportConfig", label: "导出配置（脱敏）", hint: "", run: () => $("btnExportConfig")?.click() },
      { id: "importConfig", label: "导入配置", hint: "", run: () => $("btnImportConfig")?.click() },
      { id: "exportLogs", label: "导出审计日志", hint: "", run: () => $("btnExportLogs")?.click() },
      { id: "fontUp", label: "增大编辑器字号", hint: "Ctrl+=", run: () => window.EmsoderApp?.adjustFontSize?.(1) },
      { id: "fontDown", label: "减小编辑器字号", hint: "Ctrl+-", run: () => window.EmsoderApp?.adjustFontSize?.(-1) },
      { id: "toggleChat", label: "切换 AI 侧栏", hint: "Ctrl+Shift+L", run: () => {
        $("mainLayout")?.classList.toggle("chat-collapsed");
        EmsoderEditor.layout();
      } },
      { id: "inline", label: "Inline Edit", hint: "Ctrl+I", run: () => window.EmsoderApp?.openInlineModal?.() },
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

  window.EmsoderPalette = {
    commands: paletteCommands,
    open: openCommandPalette,
    renderList: renderPaletteList,
    moveSelection: movePaletteSelection,
    runSelected: runPaletteSelected,
  };
})();
