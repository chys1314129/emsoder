/* EmsoderPermission: permission-mode popup menu (confirm / auto_edit / plan / full).
   Depends on: EmsoderState (state, $), emsoder, EmsoderDom (toast),
   EmsoderReasoningMenu (close, for popup mutual-exclusion). */
(() => {
  const { state, $ } = EmsoderState;
  const toast = (...a) => EmsoderDom.toast(...a);

  const PERMISSION_CYCLE = ["confirm", "auto_edit", "plan", "full", "unrestricted"];
  const PERMISSION_META = {
    confirm: {
      label: "变更前确认",
      desc: "改文件前先问我",
      title: "改文件前先问我。终端命令也会确认。点击选择权限。",
    },
    auto_edit: {
      label: "自动编辑",
      desc: "自动编辑文件",
      title: "自动编辑文件。终端命令仍会确认（除非设置里开了安全命令自动）。点击选择权限。",
    },
    plan: {
      label: "计划模式",
      desc: "编辑前先出计划",
      title: "编辑前先出计划，不直接改文件/跑命令。点击选择权限。",
    },
    full: {
      label: "高危才询问",
      desc: "只有高危命令才问",
      title: "自动改文件，安全命令自动执行，只有高危命令才问你。点击选择权限。",
    },
    unrestricted: {
      label: "完全授权",
      desc: "不问，模型自己判断",
      title: "不问你。文件和终端都由模型自己判断并继续。点击选择权限。",
    },
  };

  function normalizePermissionModeUi(v) {
    const s = String(v || "").toLowerCase().trim();
    return PERMISSION_CYCLE.includes(s) ? s : "auto_edit";
  }

  function refreshPermissionBtn() {
    const btn = $("btnPermissionMode") || $("btnAutoApprove");
    if (!btn) return;
    const mode = normalizePermissionModeUi(
      state.config?.permissionMode
    );
    const meta = PERMISSION_META[mode] || PERMISSION_META.auto_edit;
    btn.textContent = meta.label;
    btn.title = meta.title;
    btn.dataset.mode = mode;
    btn.classList.toggle("on", mode === "auto_edit" || mode === "full" || mode === "unrestricted");
    btn.classList.toggle("plan", mode === "plan");
    btn.classList.toggle("confirm-mode", mode === "confirm");
    btn.setAttribute(
      "aria-pressed",
      mode === "auto_edit" || mode === "full" || mode === "unrestricted" ? "true" : "false"
    );
    // 同步菜单勾选
    const menu = $("permMenu");
    if (menu) {
      menu.querySelectorAll(".perm-item[data-mode]").forEach((el) => {
        const on = el.dataset.mode === mode;
        el.classList.toggle("active", on);
        el.setAttribute("aria-checked", on ? "true" : "false");
      });
    }
  }

  function closePermissionMenu() {
    const menu = $("permMenu");
    const btn = $("btnPermissionMode");
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function openPermissionMenu() {
    const menu = $("permMenu");
    const btn = $("btnPermissionMode");
    if (!menu || !btn) return;
    try {
      window.EmsoderReasoningMenu?.close?.();
    } catch {
      /* ignore */
    }
    refreshPermissionBtn();
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    // 焦点到当前项，方便键盘
    const cur =
      menu.querySelector(".perm-item.active") ||
      menu.querySelector(".perm-item");
    cur?.focus?.();
  }

  function togglePermissionMenu() {
    const menu = $("permMenu");
    if (!menu) return;
    if (menu.hidden) openPermissionMenu();
    else closePermissionMenu();
  }

  async function setPermissionMode(next) {
    const mode = normalizePermissionModeUi(next);
    state.config = await emsoder.updateConfig({ permissionMode: mode });
    refreshPermissionBtn();
    if ($("stPermissionMode")) $("stPermissionMode").value = mode;
    const meta = PERMISSION_META[mode] || PERMISSION_META.auto_edit;
    toast(`权限：${meta.label}`);
    closePermissionMenu();
  }

  // 兼容旧名
  function refreshAutoApproveBtn() {
    refreshPermissionBtn();
  }

  window.EmsoderPermission = {
    CYCLE: PERMISSION_CYCLE,
    META: PERMISSION_META,
    normalize: normalizePermissionModeUi,
    refresh: refreshPermissionBtn,
    refreshAutoApprove: refreshAutoApproveBtn,
    close: closePermissionMenu,
    open: openPermissionMenu,
    toggle: togglePermissionMenu,
    setMode: setPermissionMode,
  };
})();
