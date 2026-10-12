/* EmsoderMcpSide: MCP server sidebar + edit modal.
   Depends on: EmsoderState (state, $), emsoder, EmsoderDom (toast/openModal/closeModal/emptyState/showConfirm). */
(() => {
  const { state, $ } = EmsoderState;
  const toast = (...a) => EmsoderDom.toast(...a);
  const openModal = (id) => EmsoderDom.openModal(id);
  const closeModal = (id) => EmsoderDom.closeModal(id);
  const sideBody = $("sideBody");
  const sideTitle = $("sideTitle");

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
    // MCP list deliberately exposes names only; masked values preserve existing
    // main-process secrets when the user saves unrelated fields.
    $("mpHeaders").value = (server?.headerNames || Object.keys(server?.headers || {}))
      .map((k) => k + ": ***")
      .join("\n");
    $("mpEnv").value = (server?.envKeys || Object.keys(server?.env || {}))
      .map((k) => k + "=***")
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

  window.EmsoderMcpSide = {
    render: renderMcpSide,
    refreshIfVisible: refreshMcpSideIfVisible,
    openEdit: openMcpEdit,
    syncFormType: syncMcpFormType,
    parseHeaderLines,
    parseEnvLines,
    PRESETS: MCP_PRESETS,
    STATUS_LABEL: mcpStatusLabel,
  };
})();
