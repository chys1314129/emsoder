/* EmsoderSidePanels: file tree / sessions / git side views.
   Depends on: EmsoderState (state, $), emsoder, EmsoderDom (toast/escapeHtml/openModal/
   emptyState/showConfirm), EmsoderTabs (openFile), EmsoderPanels, EmsoderSearchSide,
   EmsoderSkillsSide, EmsoderMemorySide, EmsoderMcpSide, EmsoderQuest, EmsoderSettings.
   EmsoderApp (applySessionUpdate/renderHistory/renderChatChanges - stay in app.js). */
(() => {
  const { state, $ } = EmsoderState;
  const toast = (...a) => EmsoderDom.toast(...a);
  const escapeHtml = (s) => EmsoderDom.escapeHtml(s);
  const openModal = (id) => EmsoderDom.openModal(id);
  const sideBody = $("sideBody");
  const sideTitle = $("sideTitle");

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
          window.EmsoderTabs?.openFile?.(e.path);
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
    if (view === "search") return EmsoderSearchSide.render();
    if (view === "git") return renderGitSide();
    if (view === "skills") return EmsoderSkillsSide.render();
    if (view === "memory") return EmsoderMemorySide.render();
    if (view === "mcp") return EmsoderMcpSide.render();
    if (view === "env") return EmsoderEnvSide.render();
    if (view === "settings") {
      openModal("modalSettings");
      EmsoderSettings.fill();
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
            window.EmsoderApp?.applySessionUpdate?.(r.session);
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
        window.EmsoderApp?.applySessionUpdate?.(active);
      } else {
        state.branchMeta = [];
        window.EmsoderApp?.renderHistory?.([], []);
        window.EmsoderApp?.renderChatChanges?.([], null);
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
        window.EmsoderApp?.applySessionUpdate?.(await emsoder.newSession());
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
      const run = item.runStatus || "idle";
      if (run === "running" || run === "stopped" || run === "review") {
        const st = document.createElement("span");
        st.className = "session-run-badge " + run;
        st.textContent =
          run === "running" ? "跑" : run === "stopped" ? "停" : "待审";
        titleRow.appendChild(st);
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
        // Switching sessions no longer blocked while a task runs: the running
        // turn is pinned to its own session in the backend, so we can freely
        // view another session and come back.
        await emsoder.setActiveSession(item.id);
        const session = await emsoder.getSession();
        window.EmsoderApp?.applySessionUpdate?.(session);
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
            window.EmsoderApp?.renderHistory?.(active.messages || [], active.branchMeta);
            window.EmsoderApp?.renderChatChanges?.(active.fileChanges || [], active.id || null);
          } else {
            state.branchMeta = [];
            window.EmsoderApp?.renderHistory?.([], []);
            window.EmsoderApp?.renderChatChanges?.([], null);
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

  window.EmsoderSidePanels = {
    loadTree,
    renderExplorer,
    refreshCurrentSideView,
    formatRelativeTime,
    renderGitSide,
    beginRenameSession,
    deleteSessionItem,
    renderSessionsSide,
    refreshSessionsSideIfVisible,
  };
})();
