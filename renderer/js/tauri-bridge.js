/* global __TAURI__ */
/**
 * `window.emsoder` — the Tauri replacement for `src/preload/preload.js`.
 *
 * This file is a deliberate near-line-by-line port of the Electron preload, so
 * the two can be diffed against each other:
 *
 *   ipcRenderer.invoke(channel, payload)  ->  rpc(channel, payload)
 *   ipcRenderer.on(channel, cb)           ->  subscribe(channel, cb)
 *   pathToFileURL(node_modules/...)       ->  asset("vendor/...")
 *
 * The method surface (~120 commands + 12 subscriptions + 2 asset groups) is
 * identical to what the renderer already uses; the renderer modules themselves
 * are untouched apart from the Monaco/xterm asset URLs.
 *
 * Asset URLs point at `renderer/vendor/`, populated from node_modules by
 * `scripts/vendor-assets.js`. Tauri serves the renderer over
 * `http://tauri.localhost/`, so those are same-origin http URLs — which is what
 * lets Monaco's AMD loader and its blob-based worker bootstrap keep working
 * without a custom protocol.
 */
(function () {
  "use strict";

  const core = window.__TAURI__ && window.__TAURI__.core;
  if (!core) {
    // Nothing can work without the shell's IPC bridge; say so loudly instead of
    // failing later with a hundred "emsoder is undefined" errors.
    console.error(
      "[emsoder] Tauri IPC 桥不可用（window.__TAURI__.core 缺失）。" +
        "请确认 tauri.conf.json 中 app.withGlobalTauri 为 true。"
    );
    return;
  }
  const { invoke, Channel } = core;

  // ---------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------

  /** One renderer command -> one host IPC channel. */
  function rpc(channel, ...args) {
    return invoke("rpc", { channel, args }).catch((err) => {
      // Electron rejected with an Error whose message was the handler's throw;
      // keep that shape so existing catch blocks keep reading err.message.
      const message =
        typeof err === "string" ? err : (err && err.message) || String(err);
      throw new Error(message);
    });
  }

  /** Fire-and-forget: the host dispatches it like `ipcMain.on` did. */
  function send(channel, ...args) {
    invoke("rpc", { channel, args }).catch(() => {});
  }

  // ---------------------------------------------------------------------
  // Push channel (the shell relays host `webContents.send` calls here)
  // ---------------------------------------------------------------------

  const subscribers = new Map();

  function subscribe(channel, cb) {
    if (!subscribers.has(channel)) subscribers.set(channel, new Set());
    subscribers.get(channel).add(cb);
    return () => {
      const set = subscribers.get(channel);
      if (set) set.delete(cb);
    };
  }

  function dispatch(channel, args) {
    const set = subscribers.get(channel);
    if (!set || !set.size) return;
    for (const cb of [...set]) {
      try {
        cb(...args);
      } catch (err) {
        console.error(`[emsoder] 事件处理失败 ${channel}`, err);
      }
    }
  }

  const push = new Channel();
  push.onmessage = (line) => {
    let msg;
    try {
      msg = typeof line === "string" ? JSON.parse(line) : line;
    } catch {
      return;
    }
    if (msg && msg.t === "ev") dispatch(msg.ch, Array.isArray(msg.args) ? msg.args : []);
  };
  invoke("rpc_listen", { channel: push }).catch((err) => {
    console.error("[emsoder] 订阅推送通道失败", err);
  });

  // The host went away — surface it rather than silently dead-ending.
  subscribe("app:host-exit", () => {
    console.error("[emsoder] 后台宿主进程已退出");
  });

  // ---------------------------------------------------------------------
  // Assets
  // ---------------------------------------------------------------------

  /** Resolve a vendored asset against the page, so it works in dev and packed. */
  function asset(rel) {
    try {
      return new URL(rel, window.location.href).href;
    } catch {
      return rel;
    }
  }

  const menuChannels = {
    save: "menu:save",
    toggleSidebar: "menu:toggle-sidebar",
    toggleBottom: "menu:toggle-bottom",
    showTerminal: "menu:show-terminal",
    showGit: "menu:show-git",
    showProblems: "menu:show-problems",
    showDebug: "menu:show-debug",
    showQuest: "menu:show-quest",
    reindexLsp: "menu:reindex-lsp",
    newChat: "menu:new-chat",
    selectModel: "menu:select-model",
    providers: "menu:providers",
    addSelection: "menu:add-selection",
    explainSelection: "menu:explain-selection",
    inlineEdit: "menu:inline-edit",
    genCommit: "menu:gen-commit",
  };

  window.emsoder = {
    monaco: {
      baseUrl: asset("vendor/monaco/min/"),
      vsUrl: asset("vendor/monaco/min/vs/"),
      loaderUrl: asset("vendor/monaco/min/vs/loader.js"),
    },

    getState: () => rpc("app:get-state"),
    getConfig: () => rpc("config:get"),
    updateConfig: (patch) => rpc("config:update", patch),
    getExecutionEnv: () => rpc("config:execution-env-get"),
    updateExecutionEnv: (lines) => rpc("config:execution-env-update", { lines }),
    listCredentials: () => rpc("credentials:list"),
    setCredential: (payload) => rpc("credentials:set", payload || {}),
    clearCredential: (payload) => rpc("credentials:clear", payload || {}),
    exportConfig: (opts) => rpc("config:export", opts || {}),
    importConfig: () => rpc("config:import"),
    exportLogs: () => rpc("logger:export"),
    getProviderPresets: () => rpc("config:provider-presets"),
    testImageGeneration: () => rpc("skills:image-gen-test"),

    saveDrafts: (drafts) => rpc("drafts:save", drafts),
    loadDrafts: () => rpc("drafts:load"),
    clearDrafts: () => rpc("drafts:clear"),

    listProviders: () => rpc("providers:list"),
    upsertProvider: (p) => rpc("providers:upsert", p),
    removeProvider: (id) => rpc("providers:remove", id),
    setActiveProvider: (providerId, model) => rpc("providers:set-active", { providerId, model }),
    testProvider: (id) => rpc("providers:test", id),
    refreshModels: (id) => rpc("providers:refresh-models", id),
    oauthLogin: (providerId) => rpc("providers:oauth-login", { providerId }),

    openWorkspace: (opts) => rpc("workspace:open", opts || {}),
    getWorkspace: (opts) => rpc("workspace:get", opts || {}),
    readDir: (p) => rpc("fs:read-dir", p),
    readFile: (p) => rpc("fs:read-file", p),
    writeFile: (filePath, content) => rpc("fs:write-file", { filePath, content }),
    openFileDialog: () => rpc("fs:open-dialog"),
    pickAttach: () => rpc("fs:pick-attach"),
    walkFiles: (opts) => rpc("fs:walk-files", opts),
    search: (opts) => rpc("fs:search", opts),
    listCodeFiles: (opts) => rpc("fs:list-code-files", opts),
    allowClose: () => rpc("app:allow-close"),
    showMainWindow: () => rpc("app:show-main"),

    listSessions: () => rpc("session:list"),
    getSession: () => rpc("session:get"),
    newSession: () => rpc("session:new"),
    setActiveSession: (id) => rpc("session:set-active", id),
    clearSession: () => rpc("session:clear"),
    compressSession: (opts) => rpc("session:compress", opts || {}),
    removeSession: (id) => rpc("session:remove", id),
    removeSessions: (ids) => rpc("session:remove-many", ids),
    renameSession: (id, title) => rpc("session:rename", { id, title }),
    branchEdit: (payload) => rpc("session:branch-edit", payload),
    excludeContextMessage: (payload) => rpc("session:exclude-message", payload),
    restoreContextMessage: (payload) => rpc("session:restore-message", payload),
    deleteContextMessage: (payload) => rpc("session:delete-message", payload),
    editAssistantContextMessage: (payload) => rpc("session:edit-assistant-message", payload),
    switchBranch: (messageId, direction) => rpc("session:switch-branch", { messageId, direction }),

    sendAgent: (payload) => send("agent:send", payload),
    stopAgent: (opts) => rpc("agent:stop", opts || {}),
    isAgentRunning: (opts) => rpc("agent:is-running", opts || {}),
    getAgentQueueStatus: (opts) => rpc("agent:queue-status", opts || {}),
    getAgentFileChanges: (sessionId) => rpc("agent:file-changes", { sessionId }),
    getAgentFileChangeDiff: (filePath, sessionId) =>
      rpc("agent:file-change-diff", { path: filePath, sessionId }),
    rejectAgentChange: (filePath, sessionId) =>
      rpc("agent:reject-change", { path: filePath, sessionId }),
    rejectAllAgentChanges: (sessionId) => rpc("agent:reject-all-changes", { sessionId }),
    acceptAllAgentChanges: (sessionId) => rpc("agent:accept-all-changes", { sessionId }),
    respondConfirm: (id, allow) => rpc("agent:confirm-response", { id, allow }),
    inlineEdit: (payload) => rpc("agent:inline-edit", payload),
    complete: (payload) => rpc("agent:complete", payload),
    genCommitMessage: () => rpc("agent:commit-message"),
    getContextStats: () => rpc("context:stats"),

    gitStatus: () => rpc("git:status"),
    gitDiff: (opts) => rpc("git:diff", opts),
    gitStage: (p) => rpc("git:stage", p),
    gitUnstage: (p) => rpc("git:unstage", p),
    gitDiscard: (p) => rpc("git:discard", p),
    gitCommit: (msg) => rpc("git:commit", msg),
    gitLog: (limit) => rpc("git:log", limit),

    termCreate: (size) => rpc("term:create", size),
    termList: () => rpc("term:list"),
    termWrite: (id, data) => rpc("term:write", { id, data }),
    termResize: (id, cols, rows) => rpc("term:resize", { id, cols, rows }),
    termInterrupt: (id) => rpc("term:interrupt", id),
    termRun: (id, command) => rpc("term:run", { id, command }),
    termKill: (id) => rpc("term:kill", id),
    termDispose: (id) => rpc("term:dispose", id),
    termAvailable: () => rpc("term:available"),
    setPreferredPty: (id) => rpc("pty:set-preferred", id),
    getPreferredPty: () => rpc("pty:get-preferred"),
    mirrorToPty: (text) => rpc("pty:mirror", text),
    onTermData: (cb) => subscribe("term:data", cb),

    xterm: {
      cssUrl: asset("vendor/xterm/xterm.css"),
      jsUrl: asset("vendor/xterm/xterm.js"),
      fitUrl: asset("vendor/xterm/addon-fit.js"),
      webLinksUrl: asset("vendor/xterm/addon-web-links.js"),
    },

    listRules: () => rpc("rules:list"),
    listSkills: () => rpc("skills:list"),
    setSkillDisabled: (id, disabled) => rpc("skills:set-disabled", { id, disabled }),
    setSkillsDisabledBatch: (ids, disabled) =>
      rpc("skills:set-disabled-batch", { ids, disabled }),
    readSkill: (id) => rpc("skills:read", { id }),
    uninstallSkill: (id) => rpc("skills:uninstall", { id }),
    skillInstallPresets: () => rpc("skills:install-presets"),
    installSkill: (payload) => rpc("skills:install", payload),
    cancelSkillInstall: () => rpc("skills:install-cancel"),
    skillInstallStatus: () => rpc("skills:install-status"),
    onSkillInstallLog: (cb) => subscribe("skills:install-log", cb),

    // ---- Long-term memory ----
    listMemories: (opts) => rpc("memory:list", opts),
    addMemory: (mem) => rpc("memory:add", mem),
    updateMemory: (id, patch) => rpc("memory:update", { id, patch }),
    removeMemory: (id) => rpc("memory:remove", id),
    searchMemories: (query, topK) => rpc("memory:search", { query, topK }),
    extractMemoriesNow: () => rpc("memory:extract-now"),
    clearMemories: () => rpc("memory:clear"),

    // ---- MCP ----
    listMcpServers: () => rpc("mcp:list"),
    upsertMcpServer: (server) => rpc("mcp:upsert", server),
    removeMcpServer: (id) => rpc("mcp:remove", id),
    connectMcp: (id) => rpc("mcp:connect", id),
    disconnectMcp: (id) => rpc("mcp:disconnect", id),
    onMcpEvent: (cb) => subscribe("mcp:event", cb),

    getTsconfig: () => rpc("lsp:tsconfig"),

    questList: () => rpc("quest:list"),
    questBoard: () => rpc("quest:board"),
    questGet: (id) => rpc("quest:get", id),
    questGetActive: () => rpc("quest:get-active"),
    questSetActive: (id) => rpc("quest:set-active", id),
    questCreate: (payload) => rpc("quest:create", payload),
    questUpdate: (id, patch) => rpc("quest:update", { id, patch }),
    questRemove: (id) => rpc("quest:remove", id),
    questStart: (id) => rpc("quest:start", id),
    questStop: (id) => rpc("quest:stop", id),
    questRejectChange: (id, filePath) => rpc("quest:reject-change", { id, path: filePath }),
    questComplete: (id) => rpc("quest:complete", id),
    questIsRunning: (id) => rpc("quest:is-running", id),
    onQuestEvent: (cb) => subscribe("quest:event", cb),

    debugState: () => rpc("debug:state"),
    debugLaunch: (opts) => rpc("debug:launch", opts),
    debugStop: () => rpc("debug:stop"),
    debugContinue: () => rpc("debug:continue"),
    debugPause: () => rpc("debug:pause"),
    debugStepOver: () => rpc("debug:step-over"),
    debugStepInto: () => rpc("debug:step-into"),
    debugStepOut: () => rpc("debug:step-out"),
    debugEvaluate: (expression, callFrameId) =>
      rpc("debug:evaluate", { expression, callFrameId }),
    debugSetBreakpoint: (filePath, line) => rpc("debug:set-breakpoint", { path: filePath, line }),
    debugRemoveBreakpoint: (filePath, line) =>
      rpc("debug:remove-breakpoint", { path: filePath, line }),
    debugClearBreakpoints: () => rpc("debug:clear-breakpoints"),
    debugListBreakpoints: () => rpc("debug:list-breakpoints"),
    onDebugEvent: (cb) => subscribe("debug:event", cb),

    onConfigChanged: (cb) => subscribe("config:changed", cb),
    onAgentEvent: (cb) => subscribe("agent:event", cb),
    onConfirm: (cb) => subscribe("agent:confirm", cb),
    onMenu: (channel, cb) => {
      const mapped = menuChannels[channel];
      if (!mapped) return () => {};
      return subscribe(mapped, () => cb());
    },
    onWorkspaceChanged: (cb) => subscribe("workspace:changed", cb),
    onOpenFiles: (cb) => subscribe("files:open", cb),
    onBeforeClose: (cb) => subscribe("app:before-close", cb),
  };

  // Tell the shell the UI has painted so it can reveal the window (the Tauri
  // equivalent of Electron's `ready-to-show`, plus the 1200 ms fallback the
  // shell arms itself).
  const reveal = () => {
    invoke("ui_ready").catch(() => {});
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", reveal, { once: true });
  } else {
    reveal();
  }
})();
