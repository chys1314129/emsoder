/* EmsoderReasoningMenu: reasoning-effort popup menu (off / low / medium / high / ultra).
   Depends on: EmsoderState (state, $), emsoder, EmsoderDom (toast),
   EmsoderPermission (close, for popup mutual-exclusion). */
(() => {
  const { state, $ } = EmsoderState;
  const toast = (...a) => EmsoderDom.toast(...a);

  const REASONING_LABELS = {
    off: "关闭思考",
    low: "低",
    medium: "中",
    high: "高",
    ultra: "超高",
  };
  const REASONING_DESCS = {
    off: "不发送思考参数",
    low: "更快 · 浅思考",
    medium: "默认平衡",
    high: "更深入",
    ultra: "最长思考",
  };
  const REASONING_CYCLE = ["off", "low", "medium", "high", "ultra"];

  function normalizeReasoningEffort(v) {
    const s = String(v || "medium").toLowerCase().trim();
    if (s === "none") return "off";
    return REASONING_CYCLE.includes(s) ? s : "medium";
  }

  function refreshReasoningChip() {
    const btn = $("reasoningChip");
    if (!btn) return;
    const effort = normalizeReasoningEffort(state.config?.reasoningEffort);
    btn.textContent = `思考 · ${REASONING_LABELS[effort] || "中"}`;
    btn.title = `思考强度：关闭 / 低 / 中 / 高 / 超高（当前：${REASONING_LABELS[effort] || "中"}）。点击选择。`;
    btn.dataset.effort = effort;
    const menu = $("reasonMenu");
    if (menu) {
      menu.querySelectorAll(".reason-item[data-effort]").forEach((el) => {
        const on = el.dataset.effort === effort;
        el.classList.toggle("active", on);
        el.setAttribute("aria-checked", on ? "true" : "false");
      });
    }
  }

  function closeReasonMenu() {
    const menu = $("reasonMenu");
    const btn = $("reasoningChip");
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function openReasonMenu() {
    const menu = $("reasonMenu");
    const btn = $("reasoningChip");
    if (!menu || !btn) return;
    // 两个弹出菜单互斥
    try {
      window.EmsoderPermission?.close?.();
    } catch {
      /* ignore */
    }
    refreshReasoningChip();
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    const cur =
      menu.querySelector(".reason-item.active") ||
      menu.querySelector(".reason-item");
    cur?.focus?.();
  }

  function toggleReasonMenu() {
    const menu = $("reasonMenu");
    if (!menu) return;
    if (menu.hidden) openReasonMenu();
    else closeReasonMenu();
  }

  async function setReasoningEffort(next) {
    const effort = normalizeReasoningEffort(next);
    state.config = await emsoder.updateConfig({ reasoningEffort: effort });
    refreshReasoningChip();
    if ($("stReasoningEffort")) $("stReasoningEffort").value = effort;
    toast(`思考强度：${REASONING_LABELS[effort] || effort}`);
    closeReasonMenu();
  }

  window.EmsoderReasoningMenu = {
    LABELS: REASONING_LABELS,
    DESCS: REASONING_DESCS,
    CYCLE: REASONING_CYCLE,
    normalize: normalizeReasoningEffort,
    refresh: refreshReasoningChip,
    close: closeReasonMenu,
    open: openReasonMenu,
    toggle: toggleReasonMenu,
    setEffort: setReasoningEffort,
  };
})();
