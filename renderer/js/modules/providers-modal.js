/* EmsoderProviders: providers modal (list / edit / test / refresh-models).
   Depends on: EmsoderState (state, $), emsoder, EmsoderDom (escapeHtml/toast/openModal/closeModal/showConfirm).
   setBusyButton / withUiTimeout / guardBusyButton live here (only used by this module).
   refreshModelChips() stays in app.js -> window.EmsoderApp?.refreshModelChips?.(). */
(() => {
  const { state, $ } = EmsoderState;
  const escapeHtml = (s) => EmsoderDom.escapeHtml(s);
  const toast = (...a) => EmsoderDom.toast(...a);
  const openModal = (id) => EmsoderDom.openModal(id);
  const closeModal = (id) => EmsoderDom.closeModal(id);

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

  async function showProviders() {
    const toggle = $("keylessFallbackToggle");
    if (toggle) toggle.checked = state.config?.keylessFallbackEnabled === true;
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
        window.EmsoderApp?.refreshModelChips?.();
        showProviders();
      };
      box.appendChild(el);
    }
    openModal("modalProviders");
  }

  // Provider presets are loaded from main process (config.js PROVIDER_PRESETS) at init.
  // This avoids maintaining two copies. Populated by loadProviderPresets() below.
  let PROVIDER_PRESETS = {};
  let providerExtras = {};

  function keylessNotice() {
    let pollinations = false;
    try { pollinations = ["text.pollinations.ai", "gen.pollinations.ai"].includes(new URL($("pfBaseUrl").value).hostname); } catch { /* incomplete input */ }
    const notice = $("pfKeylessNotice");
    if (notice) notice.hidden = !pollinations;
    if (pollinations) $("pfApiKey").placeholder = "旧文本通道留空即可；新 gen 端点需自己的 Key";
  }
  $("pfBaseUrl")?.addEventListener("input", keylessNotice);
  $("keylessFallbackToggle")?.addEventListener("change", async (event) => {
    const toggle = event.target;
    const enabled = toggle.checked;
    toggle.disabled = true;
    try {
      state.config = await emsoder.updateConfig({ keylessFallbackEnabled: enabled });
      toast(enabled ? "已开启第三方无密钥兜底" : "已关闭无密钥自动兜底");
    } catch (e) {
      toggle.checked = !enabled;
      toast("保存失败: " + (e?.message || e), true);
    } finally { toggle.disabled = false; }
  });

  async function loadProviderPresets() {
    try {
      PROVIDER_PRESETS = (await emsoder.getProviderPresets()) || {};
    } catch {
      /* ignore - applyProviderPreset will silently skip on missing key */
    }
  }

  function applyProviderPreset(key) {
    const preset = PROVIDER_PRESETS[key];
    if (!preset) return;
    if (!$("pfId").disabled) $("pfId").value = preset.id;
    $("pfName").value = preset.name;
    $("pfType").value = preset.type;
    $("pfBaseUrl").value = preset.baseUrl;
    // A keyless preset must never retain a key typed for another provider.
    $("pfApiKey").value = preset.apiKey || "";
    providerExtras = { chatPath: preset.chatPath, keyless: preset.keyless === true, timeoutMs: preset.timeoutMs, resetAuth: true };
    for (const id of ["pfOAuthAuthorizeUrl", "pfOAuthTokenUrl", "pfOAuthClientId", "pfOAuthScopes"]) $(id).value = "";
    $("pfModels").value = preset.models;
    $("pfEnabled").value = "true";
    keylessNotice();
  }

  function openEditProvider(p) {
    providerExtras = { chatPath: p?.chatPath, keyless: p?.keyless === true, timeoutMs: p?.timeoutMs };
    $("editProviderTitle").textContent = p ? "编辑服务商" : "添加第三方模型服务商";
    $("pfPreset").value = "";
    $("pfId").value = p?.id || "";
    $("pfId").disabled = !!p;
    $("pfName").value = p?.name || "";
    $("pfType").value = p?.type || "openai";
    $("pfBaseUrl").value = p?.baseUrl || "https://api.openai.com/v1";
    // API key values stay in the main process. Empty input means preserve;
    // entering a value replaces it through providers:upsert.
    $("pfApiKey").value = "";
    $("pfApiKey").placeholder = p?.apiKeyConfigured ? "已配置（输入新值以替换）" : "未配置";
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
    // OAuth（Pi provider）
    const oauth = p?.oauth && typeof p.oauth === "object" ? p.oauth : {};
    $("pfOAuthAuthorizeUrl").value = oauth.authorizeUrl || "";
    $("pfOAuthTokenUrl").value = oauth.tokenUrl || "";
    $("pfOAuthClientId").value = oauth.clientId || "";
    $("pfOAuthScopes").value = oauth.scopes || "";
    const st = $("pfOAuthStatus");
    if (st) st.textContent = p?.oauthConnected ? "已授权（token 已保存）" : (p?.oauthConfigured ? "已配置，点「OAuth 登录」完成授权" : "");
    keylessNotice();
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
      window.EmsoderApp?.refreshModelChips?.();
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
      ...providerExtras,
      id: $("pfId").value.trim(),
      name: $("pfName").value.trim(),
      type: $("pfType").value,
      baseUrl: $("pfBaseUrl").value.trim().replace(/\/+$/, ""),
      apiKey: $("pfApiKey").value,
      models: $("pfModels").value.split(",").map((s) => s.trim()).filter(Boolean),
      enabled: $("pfEnabled").value === "true",
    };
    // OAuth（Pi provider）：三项齐全才写入
    const oauth = {
      authorizeUrl: $("pfOAuthAuthorizeUrl")?.value.trim() || "",
      tokenUrl: $("pfOAuthTokenUrl")?.value.trim() || "",
      clientId: $("pfOAuthClientId")?.value.trim() || "",
      scopes: $("pfOAuthScopes")?.value.trim() || "",
    };
    if (oauth.authorizeUrl && oauth.tokenUrl && oauth.clientId) provider.oauth = oauth;
    if (!provider.id || !provider.name || !provider.baseUrl) {
      toast("请填写 ID / 名称 / Base URL", true);
      return null;
    }
    const wasActive = state.config?.activeProviderId === provider.id;
    state.config = await emsoder.upsertProvider(provider);
    delete providerExtras.resetAuth;
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
    window.EmsoderApp?.refreshModelChips?.();
    window.EmsoderApp.refreshQuestModels?.();
    if (closeAfter) {
      closeModal("modalEditProvider");
      showProviders();
    }
    return provider;
  }

  $("btnAddProvider").onclick = () => openEditProvider(null);

  // OAuth 登录：先保存 OAuth 配置，再打开系统浏览器走授权码 + PKCE 流程
  $("btnOAuthLogin")?.addEventListener("click", async () => {
    const btn = $("btnOAuthLogin");
    const st = $("pfOAuthStatus");
    const provider = await saveProviderFromForm(false, { setActive: false });
    if (!provider) return;
    if (!provider.oauth) {
      toast("请先填 authorizeUrl / tokenUrl / clientId 再点 OAuth 登录", true);
      return;
    }
    if (btn) btn.disabled = true;
    if (st) st.textContent = "等待浏览器授权…（完成授权后回到本窗口）";
    try {
      const r = await emsoder.oauthLogin(provider.id);
      if (r?.ok) {
        state.config = await emsoder.getConfig();
        if (st) st.textContent = "已授权（token 已保存）";
        toast("OAuth 授权成功");
      } else {
        if (st) st.textContent = "授权失败: " + (r?.error || "未知错误");
        toast(r?.error || "OAuth 授权失败", true);
      }
    } catch (e) {
      if (st) st.textContent = "授权失败: " + (e?.message || e);
      toast(e?.message || e || "OAuth 授权失败", true);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

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

  window.EmsoderProviders = {
    show: showProviders,
    loadPresets: loadProviderPresets,
    applyPreset: applyProviderPreset,
    openEdit: openEditProvider,
    saveFromForm: saveProviderFromForm,
    setBusyButton,
    guardBusyButton,
    withUiTimeout,
  };
})();
