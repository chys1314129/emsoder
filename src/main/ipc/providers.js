/** Provider CRUD / test / refresh-models / OAuth IPC handlers. */
const {
  saveConfig,
  getProviders,
  getEnabledProviders,
  getActiveProvider,
} = require("../../core/config");
const { testProvider, listRemoteModels } = require("../../providers");
const { publicProvider } = require("../credentialCatalog");
const {
  pkcePair,
  oauthConfigOf,
  exchangeCode,
  startAuthServer,
} = require("../../core/oauth");

function register(ipcMain, ctx) {
  const { cfg, publicConfig, assertTrustedSender } = ctx;

  /** Pi OAuth provider：系统浏览器授权码 + PKCE 登录，token 持久化到服务商配置。 */
  ipcMain.handle("providers:oauth-login", async (event, { providerId } = {}) => {
    assertTrustedSender?.(event);
    const raw = (Array.isArray(cfg.providers) ? cfg.providers : []).find((p) => p?.id === providerId);
    if (!raw || !oauthConfigOf(raw)) {
      return { ok: false, error: "该服务商未配置 OAuth（需要 authorizeUrl / tokenUrl / clientId）" };
    }
    let server;
    try {
      const { verifier, challenge } = pkcePair();
      const started = await startAuthServer();
      server = started.server;
      const url = new URL(raw.oauth.authorizeUrl);
      url.searchParams.set("client_id", raw.oauth.clientId);
      url.searchParams.set("redirect_uri", started.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      const scopes = raw.oauth.scopes || "";
      if (scopes) url.searchParams.set("scope", scopes);
      const { shell } = require("electron");
      shell.openExternal(url.toString());
      const { code, error } = await started.codePromise;
      if (!code || error) return { ok: false, error: String(error || "授权被取消") };
      const tokens = await exchangeCode(raw, code, verifier, started.redirectUri);
      raw.oauthTokens = tokens;
      saveConfig(cfg);
      return { ok: true, providerId, tokenType: tokens.tokenType, expiresAt: tokens.expiresAt || 0 };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      try { server?.close(); } catch { /* ignore */ }
    }
  });

  ipcMain.handle("providers:list", (event) => {
    assertTrustedSender?.(event);
    return (Array.isArray(cfg.providers) ? cfg.providers : []).map(publicProvider);
  });
  ipcMain.handle("providers:enabled", (event) => {
    assertTrustedSender?.(event);
    return (Array.isArray(cfg.providers) ? cfg.providers : []).filter((p) => p.enabled !== false).map(publicProvider);
  });

  ipcMain.handle("providers:upsert", (event, provider) => {
    assertTrustedSender?.(event);
    const rawList = Array.isArray(cfg.providers) ? cfg.providers : [];
    const idx = rawList.findIndex((p) => p && p.id === provider.id);
    const previousOrigin = idx >= 0 ? rawList[idx].baseUrl : "";
    const normalized = {
      id: provider.id,
      name: provider.name || provider.id,
      type: provider.type === "anthropic" ? "anthropic" : "openai",
      baseUrl: String(provider.baseUrl || "").replace(/\/+$/, ""),
      // Renderer only receives a configured flag. Empty/masked input preserves
      // the main-process value; explicit clearing happens through credentials:clear.
      apiKey: typeof provider.apiKey === "string" && provider.apiKey && !provider.apiKey.startsWith("***")
        ? provider.apiKey
        : undefined,
      models: Array.isArray(provider.models) ? provider.models : [],
      enabled: provider.enabled !== false,
      keyless: provider.keyless === true,
    };
    if (provider.headers) normalized.headers = provider.headers;
    if (Object.prototype.hasOwnProperty.call(provider, "chatPath")) normalized.chatPath = provider.chatPath || undefined;
    if (provider.timeoutMs != null) normalized.timeoutMs = provider.timeoutMs;
    if (provider.oauth && typeof provider.oauth === "object") normalized.oauth = provider.oauth;
    if (idx >= 0) {
      // 合并 raw provider，避免丢失手动写入的 headers/chatPath/timeoutMs/oauth 等扩展字段
      const previous = rawList[idx];
      rawList[idx] = { ...previous, ...normalized };
      if (normalized.apiKey === undefined) rawList[idx].apiKey = previous.apiKey || "";
    } else {
      rawList.push(normalized);
    }
    let originChanged = false;
    if (idx >= 0) {
      try { originChanged = new URL(previousOrigin).origin !== new URL(normalized.baseUrl).origin; }
      catch { originChanged = previousOrigin !== normalized.baseUrl; }
    }
    if (provider.resetAuth === true || originChanged) {
      // Only a deliberate preset/auth-origin switch clears old credentials.
      const saved = rawList.find((p) => p.id === provider.id);
      saved.apiKey = normalized.apiKey || "";
      delete saved.oauth;
      delete saved.oauthTokens;
      delete saved.headers;
      // New explicit OAuth/header values belong to the newly selected origin.
      if (provider.oauth && typeof provider.oauth === "object") saved.oauth = provider.oauth;
      if (provider.headers && typeof provider.headers === "object") saved.headers = provider.headers;
    }
    cfg.providers = rawList;
    saveConfig(cfg);
    return publicConfig(cfg);
  });

  ipcMain.handle("providers:remove", (_e, id) => {
    cfg.providers = (cfg.providers || []).filter((p) => p.id !== id);
    saveConfig(cfg);
    return publicConfig(cfg);
  });

  ipcMain.handle("providers:set-active", (_e, { providerId, model }) => {
    cfg.activeProviderId = providerId;
    cfg.activeModel = model;
    saveConfig(cfg);
    return publicConfig(cfg);
  });

  /** 主进程侧硬超时，确保 IPC 一定会返回，按钮不会永远转圈 */
  function raceTimeout(promise, ms, label) {
    const timeoutMs = Math.max(3000, Number(ms) || 15000);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `${label || "请求"}超时（${Math.round(timeoutMs / 1000)}s），请检查 Base URL / 网络 / API Key`
          )
        );
      }, timeoutMs);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  ipcMain.handle("providers:test", async (_e, providerId) => {
    try {
      const p =
        getProviders(cfg).find((x) => x.id === providerId) ||
        getActiveProvider(cfg);
      if (!p) return { ok: false, message: "未找到服务商", latencyMs: 0 };
      // 用配置里的完整 provider（含 apiKey）
      const full = getProviders(cfg).find((x) => x.id === p.id) || p;
      // 整段最多 16s，保证渲染进程能收到结果
      return await raceTimeout(testProvider(cfg, full), 16000, "测试");
    } catch (err) {
      return {
        ok: false,
        message: err?.message || String(err) || "测试失败",
        latencyMs: 0,
      };
    }
  });

  ipcMain.handle("providers:refresh-models", async (_e, providerId) => {
    const list = getProviders(cfg);
    // 注意：cfg.providers 是源数据；getProviders 是映射副本。写回要用 cfg.providers
    const rawList = Array.isArray(cfg.providers) ? cfg.providers : [];
    const raw = rawList.find((x) => x && x.id === providerId);
    const p = list.find((x) => x.id === providerId);
    if (!raw || !p) {
      return { ok: false, error: "未找到服务商", models: [] };
    }
    try {
      const models = await raceTimeout(
        listRemoteModels(p),
        15000,
        "刷新模型"
      );
      raw.models = (models || []).slice(0, 100);
      cfg.providers = rawList;
      saveConfig(cfg);
      return {
        ok: true,
        id: raw.id,
        name: raw.name || raw.id,
        type: raw.type === "anthropic" ? "anthropic" : "openai",
        baseUrl: String(raw.baseUrl || "").replace(/\/+$/, ""),
        models: Array.isArray(raw.models) ? raw.models : [],
        enabled: raw.enabled !== false,
      };
    } catch (err) {
      // 失败时不 throw：始终返回结构化结果，前端 finally 一定能复位按钮
      if (Array.isArray(err?.fallbackModels) && err.fallbackModels.length) {
        raw.models = err.fallbackModels.slice(0, 100);
        cfg.providers = rawList;
        saveConfig(cfg);
      }
      return {
        ok: false,
        error: err?.message || String(err) || "刷新模型失败",
        id: raw.id,
        name: raw.name || raw.id,
        models: Array.isArray(raw.models) ? raw.models : [],
      };
    }
  });
}

module.exports = { register };
