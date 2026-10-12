/** Config IPC handlers (get / provider-presets / update / export / import). */
const fs = require("fs/promises");
const {
  saveConfig,
  getProviders,
  PROVIDER_PRESETS,
} = require("../../core/config");
const { normalizePermissionMode } = require("../../tools/confirm");
const { executionEnv } = require("../../tools/skillRuntime");

function register(ipcMain, ctx) {
  const { cfg, publicConfig, memoryStore, mcpManager, dialog, getWindow, syncFloatingBall, applyAudioMute } = ctx;

  ipcMain.handle("config:get", () => publicConfig(cfg));
  ipcMain.handle("config:provider-presets", () => PROVIDER_PRESETS);

  // Sensitive terminal/skill env is write-only to generic config consumers.
  ipcMain.handle("config:execution-env-get", () => {
    const env = executionEnv(cfg);
    return {
      keys: Object.keys(env).sort(),
      lines: Object.keys(env).sort().map((key) => `${key}=***`),
    };
  });
  ipcMain.handle("config:execution-env-update", (_e, { lines } = {}) => {
    const previous = executionEnv(cfg);
    const next = {};
    for (const rawLine of String(lines || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const at = line.indexOf("=");
      if (at <= 0) continue;
      const key = line.slice(0, at).trim();
      const value = line.slice(at + 1);
      // Masked values mean keep existing local secret; omit a key to delete it.
      next[key] = value === "***" ? previous[key] : value;
    }
    cfg.executionEnv = executionEnv({ executionEnv: next });
    saveConfig(cfg);
    try {
      const { BrowserWindow } = require("electron");
      const fresh = publicConfig(cfg);
      for (const win of BrowserWindow.getAllWindows()) {
        if (win && !win.isDestroyed()) win.webContents.send("config:changed", fresh);
      }
    } catch { /* ignore */ }
    return { keys: Object.keys(cfg.executionEnv).sort(), lines: Object.keys(cfg.executionEnv).sort().map((key) => `${key}=***`) };
  });

  ipcMain.handle("config:update", (_e, patch) => {
    // 图片搜索/生成 Key：渲染层默认回传占位（***），或未改动的空串——不要覆盖本机明文 Key。
    // 只有用户输入了新的非占位值才更新。
    for (const k of ["pexelsApiKey", "unsplashApiKey", "imageGenApiKey"]) {
      if (k in patch) {
        const v = patch[k];
        if (typeof v !== "string" || v === "" || v.startsWith("***")) {
          delete patch[k];
        }
      }
    }
    if (patch && "executionEnv" in patch) {
      patch.executionEnv = executionEnv({ executionEnv: patch.executionEnv });
    }
    // Object.assign keeps the shared cfg reference stable so every domain
    // module (which captured cfg by reference at register-time) observes the
    // patch. Equivalent to the previous `cfg = { ...cfg, ...patch }` spread
    // but without breaking the shared reference.
    Object.assign(cfg, patch);
    cfg.agentMode = true;
    // keep providers if provided
    if (patch.providers) cfg.providers = patch.providers;
    // 权限模式规范化（单一来源：confirm.normalizePermissionMode）
    if ("permissionMode" in patch || !cfg.permissionMode) {
      cfg.permissionMode = normalizePermissionMode(cfg);
    }
    saveConfig(cfg);
    if (
      patch &&
      ("skillsEnabled" in patch ||
        "skillsIncludePlugins" in patch ||
        "skillsDirs" in patch ||
        "skillsDisabled" in patch)
    ) {
      try {
        require("../../tools/skills").invalidateSkillCache();
      } catch {
        /* ignore */
      }
    }
    if (patch && "memoriesMaxCount" in patch && memoryStore) {
      try {
        memoryStore.setMaxCount(cfg.memoriesMaxCount);
      } catch {
        /* ignore */
      }
    }
    if (patch && "mcpServers" in patch && mcpManager) {
      try {
        mcpManager.reload(cfg);
      } catch {
        /* ignore */
      }
    }
    if (patch && "floatingBallEnabled" in patch && typeof syncFloatingBall === "function") {
      try {
        syncFloatingBall();
      } catch {
        /* ignore */
      }
    }
    if (patch && "soundEnabled" in patch && typeof applyAudioMute === "function") {
      try {
        applyAudioMute();
      } catch {
        /* ignore */
      }
    }
    // 让所有窗口（主窗口/悬浮球）立即拿到最新配置，避免渲染层用过期的
    // soundEnabled / contextWindow 快照。
    try {
      const fresh = publicConfig(cfg);
      const { BrowserWindow } = require("electron");
      for (const win of BrowserWindow.getAllWindows()) {
        if (win && !win.isDestroyed()) win.webContents.send("config:changed", fresh);
      }
    } catch {
      /* ignore */
    }
    return publicConfig(cfg);
  });

  // ---- Config export / import (BYOK backup) ----
  ipcMain.handle("config:export", async (_e, { redactKeys } = {}) => {
    const redact = redactKeys !== false;
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      activeProviderId: cfg.activeProviderId,
      activeModel: cfg.activeModel,
      keylessFallbackEnabled: cfg.keylessFallbackEnabled === true,
      pollinationsProviderMigrated: cfg.pollinationsProviderMigrated === true,
      agentBackend: cfg.agentBackend === "pi" ? "pi" : "emsoder",
      agentMode: true,
      permissionMode: normalizePermissionMode(cfg),
      collapseProcess: cfg.collapseProcess !== false,
      terminalRunMode: cfg.terminalRunMode,
      commandDenyList: cfg.commandDenyList,
      // Default exports reveal only names; explicit non-redacted backup contains values.
      executionEnv: redact
        ? Object.fromEntries(Object.keys(executionEnv(cfg)).sort().map((key) => [key, "***"]))
        : executionEnv(cfg),
      maxTokens: cfg.maxTokens,
      temperature: cfg.temperature,
      reasoningEffort: (() => {
        const s = String(cfg.reasoningEffort || "medium").toLowerCase();
        return ["off", "low", "medium", "high", "ultra"].includes(s) ? s : "medium";
      })(),
      agentMaxRounds: cfg.agentMaxRounds ?? 0,
      agentAutoContinue: cfg.agentAutoContinue ?? -1,
      runMode: cfg.runMode === "plan" || cfg.runMode === "goal" ? cfg.runMode : "auto",
      contextWindow: cfg.contextWindow ?? 0,
      modelContextWindows:
        cfg.modelContextWindows && typeof cfg.modelContextWindows === "object"
          ? cfg.modelContextWindows
          : {},
      autoCompressAt: cfg.autoCompressAt ?? 80,
      soundEnabled: cfg.soundEnabled !== false,
      soundVolume: cfg.soundVolume ?? 1.0,
      floatingBallEnabled: cfg.floatingBallEnabled === true,
      imageProvider: cfg.imageProvider === "unsplash" ? "unsplash" : "pexels",
      // 图片 Key 脱敏导出（与 provider apiKey 一致）
      pexelsApiKey: redact
        ? (cfg.pexelsApiKey ? `***${String(cfg.pexelsApiKey).slice(-4)}` : "")
        : (cfg.pexelsApiKey || ""),
      unsplashApiKey: redact
        ? (cfg.unsplashApiKey ? `***${String(cfg.unsplashApiKey).slice(-4)}` : "")
        : (cfg.unsplashApiKey || ""),
      imageGenBackend: cfg.imageGenBackend || "modelscope",
      imageGenModel: cfg.imageGenModel || "",
      imageGenBaseUrl: cfg.imageGenBaseUrl || "",
      imageGenApiKey: redact
        ? (cfg.imageGenApiKey ? `***${String(cfg.imageGenApiKey).slice(-4)}` : "")
        : (cfg.imageGenApiKey || ""),
      systemPrompt: cfg.systemPrompt,
      responseLanguage: cfg.responseLanguage,
      completionEnabled: cfg.completionEnabled,
      completionDebounceMs: cfg.completionDebounceMs,
      fontSize: cfg.fontSize,
      skillsEnabled: cfg.skillsEnabled !== false,
      skillsIncludeBundled: cfg.skillsIncludeBundled !== false,
      skillsIncludePlugins: cfg.skillsIncludePlugins !== false,
      skillsDirs: Array.isArray(cfg.skillsDirs) ? cfg.skillsDirs : [],
      skillsDisabled: Array.isArray(cfg.skillsDisabled) ? cfg.skillsDisabled : [],
      providers: (Array.isArray(cfg.providers) ? cfg.providers : []).map((p) => ({
        id: p.id,
        name: p.name || p.id,
        type: p.type === "anthropic" ? "anthropic" : "openai",
        baseUrl: String(p.baseUrl || "").replace(/\/+$/, ""),
        models: Array.isArray(p.models) ? p.models : [],
        enabled: p.enabled !== false,
        headers: p.headers,
        chatPath: p.chatPath,
        keyless: p.keyless === true,
        timeoutMs: p.timeoutMs,
        oauth: p.oauth && typeof p.oauth === "object" ? p.oauth : undefined,
        oauthTokens: redact
          ? undefined
          : (p.oauthTokens && typeof p.oauthTokens === "object" ? p.oauthTokens : undefined),
        apiKey: redact
          ? p.apiKey
            ? `***${String(p.apiKey).slice(-4)}`
            : ""
          : p.apiKey,
      })),
    };
    const res = await dialog.showSaveDialog(getWindow(), {
      title: "导出 EMSoder 配置",
      defaultPath: "emsoder-config-export.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    await fs.writeFile(res.filePath, JSON.stringify(payload, null, 2), "utf8");
    return { ok: true, path: res.filePath, redacted: redact };
  });

  ipcMain.handle("config:import", async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: "导入 EMSoder 配置",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };
    let data;
    try {
      data = JSON.parse(await fs.readFile(res.filePaths[0], "utf8"));
    } catch (e) {
      return { ok: false, error: "JSON 解析失败: " + (e.message || e) };
    }
    if (!data || typeof data !== "object") {
      return { ok: false, error: "无效配置文件" };
    }
    const keep = [
      "activeProviderId",
      "activeModel",
      "keylessFallbackEnabled",
      "pollinationsProviderMigrated",
      "agentBackend",
      "agentMode",
      "permissionMode",
      "collapseProcess",
      "terminalRunMode",
      "commandDenyList",
      "executionEnv",
      "maxTokens",
      "temperature",
      "reasoningEffort",
      "agentMaxRounds",
      "agentAutoContinue",
      "runMode",
      "contextWindow",
      "modelContextWindows",
      "autoCompressAt",
      "soundEnabled",
      "soundVolume",
      "floatingBallEnabled",
      "imageProvider",
      "imageGenBackend",
      "imageGenModel",
      "imageGenBaseUrl",
      "systemPrompt",
      "responseLanguage",
      "completionEnabled",
      "completionDebounceMs",
      "fontSize",
      "skillsEnabled",
      "skillsIncludeBundled",
      "skillsIncludePlugins",
      "skillsDirs",
      "skillsDisabled",
    ];
    for (const k of keep) {
      if (k === "executionEnv") continue;
      if (data[k] !== undefined) cfg[k] = data[k];
    }
    if (data.executionEnv && typeof data.executionEnv === "object" && !Array.isArray(data.executionEnv)) {
      const previous = executionEnv(cfg);
      const merged = {};
      for (const [key, value] of Object.entries(data.executionEnv)) {
        merged[key] = value === "***" ? previous[key] : value;
      }
      cfg.executionEnv = executionEnv({ executionEnv: merged });
    }
    // 图片搜索/生成 Key：跳过脱敏值（*** 开头），只在明文时导入
    for (const k of ["pexelsApiKey", "unsplashApiKey", "imageGenApiKey"]) {
      const v = data[k];
      if (typeof v === "string" && v && !v.startsWith("***")) cfg[k] = v;
    }
    if (Array.isArray(data.providers) && data.providers.length) {
      const existing = getProviders(cfg);
      const byId = new Map(existing.map((p) => [p.id, p]));
      const next = data.providers.map((p) => {
        const prev = byId.get(p.id);
        let apiKey = p.apiKey || "";
        // keep old key if import looks redacted
        let sameOrigin = false;
        try { sameOrigin = !!prev && new URL(prev.baseUrl).origin === new URL(p.baseUrl).origin; } catch { /* invalid origin never inherits secrets */ }
        if (String(apiKey).startsWith("***") || String(apiKey).includes("REPLACE")) apiKey = "";
        if (
          prev && sameOrigin &&
          (!apiKey ||
            String(apiKey).startsWith("***") ||
            String(apiKey).includes("REPLACE"))
        ) {
          apiKey = prev.apiKey || "";
        }
        return {
          id: p.id,
          name: p.name || p.id,
          type: p.type === "anthropic" ? "anthropic" : "openai",
          baseUrl: String(p.baseUrl || "").replace(/\/+$/, ""),
          apiKey,
          models: Array.isArray(p.models) ? p.models : [],
          enabled: p.enabled !== false,
          headers: p.headers,
          chatPath: p.chatPath,
          keyless: p.keyless === true,
          timeoutMs: p.timeoutMs,
          oauth: p.oauth && typeof p.oauth === "object" ? p.oauth : undefined,
          oauthTokens:
            p.oauthTokens && typeof p.oauthTokens === "object" && p.oauthTokens.accessToken
              ? p.oauthTokens
              : undefined,
        };
      });
      cfg.providers = next;
    }
    saveConfig(cfg);
    return { ok: true, config: publicConfig(cfg) };
  });
}

module.exports = { register };
