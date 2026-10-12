/* EmsoderEnvSide: unified safe environment variables / credentials sidebar. */
(() => {
  const { state, $ } = EmsoderState;
  const esc = (s) => EmsoderDom.escapeHtml(s);
  const toast = (...args) => EmsoderDom.toast(...args);

  const GROUPS = [
    ["built-in", "内置服务 Key"],
    ["provider", "模型服务商"],
    ["custom", "自定义终端与技能变量"],
    ["mcp", "MCP 凭据概览"],
  ];

  async function refresh() {
    const body = $("sideBody");
    if (!body) return;
    $("sideTitle").textContent = "环境变量";
    body.innerHTML = '<div class="tree-empty">读取密钥状态…</div>';
    try {
      const r = await emsoder.listCredentials();
      render(r?.items || []);
    } catch (e) {
      body.innerHTML = `<div class="tree-empty">读取失败：${esc(e?.message || e)}</div>`;
    }
  }

  function render(items) {
    const body = $("sideBody");
    if (!body) return;
    const q = String(state.envSearch || "").trim().toLowerCase();
    const filtered = items.filter((x) => !q || `${x.label} ${x.keyName} ${x.source}`.toLowerCase().includes(q));
    body.innerHTML = `
      <div class="env-toolbar">
        <input id="envSearch" placeholder="搜索变量或密钥名称" value="${esc(state.envSearch || "")}" />
        <button class="btn" id="btnAddEnv">+ 自定义变量</button>
      </div>
      <div class="env-note">变量值不会显示。自定义变量仅用于新终端、Agent run_terminal 和 Skill 脚本，不用于 Provider、OAuth 或 MCP。</div>
    `;
    $("envSearch").addEventListener("input", (e) => { state.envSearch = e.target.value; render(items); });
    $("btnAddEnv").addEventListener("click", () => openEditor(null));
    for (const [group, title] of GROUPS) {
      const rows = filtered.filter((x) => x.group === group);
      if (!rows.length && !(group === "custom" && !q)) continue;
      const section = document.createElement("section");
      section.className = "env-group";
      section.innerHTML = `<h4>${title}<span>${rows.length}</span></h4>`;
      if (!rows.length) {
        section.innerHTML += '<div class="tree-empty">暂无自定义变量</div>';
      }
      for (const item of rows) section.appendChild(rowEl(item));
      body.appendChild(section);
    }
  }

  function rowEl(item) {
    const el = document.createElement("div");
    el.className = "env-row";
    const stateText = item.authState === "oauth" ? "OAuth 已连接" : item.configured ? "已配置" : "未配置";
    const keyMeta = item.group === "mcp"
      ? [item.envKeys?.length ? `env: ${item.envKeys.join(", ")}` : "", item.headerNames?.length ? `headers: ${item.headerNames.join(", ")}` : ""].filter(Boolean).join(" · ")
      : item.keyName || "";
    el.innerHTML = `
      <div class="env-row-main">
        <div class="env-row-label">${esc(item.label)} <span class="env-state ${item.configured ? "set" : ""}">${esc(stateText)}</span></div>
        <div class="env-row-meta">${esc(keyMeta || item.source || "")}</div>
        <div class="env-row-desc">${esc(item.description || "")}</div>
      </div>
      <div class="env-row-actions"></div>`;
    const actions = el.querySelector(".env-row-actions");
    if (item.group === "mcp") {
      const open = document.createElement("button"); open.className = "msg-btn"; open.textContent = "MCP 设置";
      open.onclick = () => { state.sideView = "mcp"; window.EmsoderMcpSide?.render?.(); };
      actions.appendChild(open);
    } else {
      const set = document.createElement("button"); set.className = "msg-btn"; set.textContent = item.configured ? "替换" : "配置";
      set.onclick = () => openEditor(item);
      actions.appendChild(set);
      if (item.configured) {
        const clear = document.createElement("button"); clear.className = "msg-btn danger"; clear.textContent = "清除";
        clear.onclick = async () => {
          const ok = await EmsoderDom.showConfirm(`确定清除「${item.label}」？不会显示旧值。`);
          if (!ok) return;
          try {
            await emsoder.clearCredential({ id: item.id });
            toast("已清除"); refresh();
          } catch (e) { toast(e?.message || e || "清除失败", true); }
        };
        actions.appendChild(clear);
      }
    }
    return el;
  }

  async function openEditor(item) {
    const custom = !item;
    const key = custom
      ? await EmsoderDom.showPrompt({
          title: "新增自定义变量",
          message: "输入变量名，例如 MY_TOKEN。变量只用于新终端、Agent run_terminal 和 Skill 脚本。",
          placeholder: "MY_TOKEN",
          confirmText: "下一步",
        })
      : null;
    if (custom && !String(key || "").trim()) return;
    const label = custom ? String(key).trim() : item.label;
    const value = await EmsoderDom.showPrompt({
      title: `${custom ? "设置" : "替换"} ${label}`,
      message: "输入新值。保存后不会再次显示该值。",
      type: "password",
      placeholder: "输入值",
      confirmText: "保存",
    });
    if (value == null) return;
    try {
      await emsoder.setCredential({ id: item?.id, key: custom ? label : undefined, value: String(value) });
      toast(custom ? "已新增变量；新终端和后续命令将使用它" : "已保存新值");
      refresh();
    } catch (e) { toast(e?.message || e || "保存失败", true); }
  }

  window.EmsoderEnvSide = { render: refresh };
})();
