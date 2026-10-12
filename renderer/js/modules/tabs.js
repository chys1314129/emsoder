/* EmsoderTabs: editor tab bar - render/activate/close/open/save + LSP index.
   Depends on: EmsoderState (state, $), emsoder, EmsoderDom (toast/basename/showConfirm),
   EmsoderEditor, EmsoderLsp, EmsoderPanels.
   EmsoderApp (setEditorVisible/isEditorCollapsed/getLocalBreakpoints - stay in app.js). */
(() => {
  const { state, $ } = EmsoderState;
  const toast = (...a) => EmsoderDom.toast(...a);
  const basename = (p) => EmsoderDom.basename(p);
  const tabsEl = $("tabs");
  const monacoHost = $("monacoEditor");
  const editorEmpty = $("editorEmpty");
  const sideBody = $("sideBody");
  const mainLayout = $("mainLayout");
  const inputEl = $("input");

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
    // 释放 Monaco model + LSP 索引，防止长期会话模型无限累积
    try {
      EmsoderEditor.disposeModel?.(filePath);
    } catch { /* ignore */ }
    if (state.activePath === filePath) {
      const next = state.tabs[idx] || state.tabs[idx - 1];
      if (next) await activateTab(next.path);
      else {
        state.activePath = null;
        monacoHost.classList.add("hidden");
        editorEmpty.classList.remove("hidden");
        $("sbFile").textContent = "-";
        $("editorLang").textContent = "-";
      }
    }
    renderTabs();
  }

  async function openFile(filePath, line, column) {
    if (window.EmsoderApp?.isEditorCollapsed?.()) window.EmsoderApp?.setEditorVisible?.(true);
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
      const bps = window.EmsoderApp?.getLocalBreakpoints?.(file.path);
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

  window.EmsoderTabs = {
    renderTabs,
    flushActiveToTab,
    activateTab,
    closeTab,
    openFile,
    indexWorkspaceLsp,
    saveActive,
    hasDirtyTabs,
    getSelectionOrEmpty,
    addSelectionToChat,
  };
})();
