/* EmsoderSkillsSide: skills sidebar (list/filter/batch) + install modal + detail view.
   Depends on: EmsoderState (state, $), emsoder, EmsoderDom (escapeHtml/toast/openModal/emptyState/showConfirm). */
(() => {
  const { state, $ } = EmsoderState;
  const escapeHtml = (s) => EmsoderDom.escapeHtml(s);
  const toast = (...a) => EmsoderDom.toast(...a);
  const openModal = (id) => EmsoderDom.openModal(id);
  const sideBody = $("sideBody");
  const sideTitle = $("sideTitle");

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
    return map[src] || escapeHtml(src || "");
  }

  function _skillIconClass(src) {
    // class 属性内只能放安全 token，防止恶意 source 逃逸属性注入
    const safe = String(src || "").replace(/[^a-zA-Z0-9_-]/g, "");
    return "skill-icon " + safe;
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

  window.EmsoderSkillsSide = {
    render: renderSkillsSide,
    toggleDisable: toggleSkillDisable,
    uninstall: uninstallSkill,
    openInstallModal: openSkillInstallModal,
    runInstall: runSkillInstallFromModal,
    cancelInstall: cancelSkillInstallFromModal,
    wireInstallModal: wireSkillInstallModal,
    showDetail: showSkillDetail,
    skillSourceLabel: _skillSourceLabel,
  };
})();
