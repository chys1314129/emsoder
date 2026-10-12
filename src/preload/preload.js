const { contextBridge, ipcRenderer } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

const monacoMinDir = path.join(
  __dirname,
  "../../node_modules/monaco-editor/min"
);
const monacoVsDir = path.join(monacoMinDir, "vs");

contextBridge.exposeInMainWorld("emsoder", {
  monaco: {
    baseUrl: pathToFileURL(monacoMinDir + path.sep).href,
    vsUrl: pathToFileURL(monacoVsDir + path.sep).href,
    loaderUrl: pathToFileURL(path.join(monacoVsDir, "loader.js")).href,
  },
  getState: () => ipcRenderer.invoke("app:get-state"),
  getConfig: () => ipcRenderer.invoke("config:get"),
  updateConfig: (patch) => ipcRenderer.invoke("config:update", patch),
  getExecutionEnv: () => ipcRenderer.invoke("config:execution-env-get"),
  updateExecutionEnv: (lines) => ipcRenderer.invoke("config:execution-env-update", { lines }),
  listCredentials: () => ipcRenderer.invoke("credentials:list"),
  setCredential: (payload) => ipcRenderer.invoke("credentials:set", payload || {}),
  clearCredential: (payload) => ipcRenderer.invoke("credentials:clear", payload || {}),
  exportConfig: (opts) => ipcRenderer.invoke("config:export", opts || {}),
  importConfig: () => ipcRenderer.invoke("config:import"),
  exportLogs: () => ipcRenderer.invoke("logger:export"),
  getProviderPresets: () => ipcRenderer.invoke("config:provider-presets"),
  testImageGeneration: () => ipcRenderer.invoke("skills:image-gen-test"),

  saveDrafts: (drafts) => ipcRenderer.invoke("drafts:save", drafts),
  loadDrafts: () => ipcRenderer.invoke("drafts:load"),
  clearDrafts: () => ipcRenderer.invoke("drafts:clear"),

  listProviders: () => ipcRenderer.invoke("providers:list"),
  upsertProvider: (p) => ipcRenderer.invoke("providers:upsert", p),
  removeProvider: (id) => ipcRenderer.invoke("providers:remove", id),
  setActiveProvider: (providerId, model) =>
    ipcRenderer.invoke("providers:set-active", { providerId, model }),
  testProvider: (id) => ipcRenderer.invoke("providers:test", id),
  refreshModels: (id) => ipcRenderer.invoke("providers:refresh-models", id),
  oauthLogin: (providerId) => ipcRenderer.invoke("providers:oauth-login", { providerId }),

  openWorkspace: (opts) => ipcRenderer.invoke("workspace:open", opts || {}),
  getWorkspace: (opts) => ipcRenderer.invoke("workspace:get", opts || {}),
  readDir: (p) => ipcRenderer.invoke("fs:read-dir", p),
  readFile: (p) => ipcRenderer.invoke("fs:read-file", p),
  writeFile: (filePath, content) =>
    ipcRenderer.invoke("fs:write-file", { filePath, content }),
  openFileDialog: () => ipcRenderer.invoke("fs:open-dialog"),
  pickAttach: () => ipcRenderer.invoke("fs:pick-attach"),
  walkFiles: (opts) => ipcRenderer.invoke("fs:walk-files", opts),
  search: (opts) => ipcRenderer.invoke("fs:search", opts),
  listCodeFiles: (opts) => ipcRenderer.invoke("fs:list-code-files", opts),
  allowClose: () => ipcRenderer.invoke("app:allow-close"),
  showMainWindow: () => ipcRenderer.invoke("app:show-main"),

  listSessions: () => ipcRenderer.invoke("session:list"),
  getSession: () => ipcRenderer.invoke("session:get"),
  newSession: () => ipcRenderer.invoke("session:new"),
  setActiveSession: (id) => ipcRenderer.invoke("session:set-active", id),
  clearSession: () => ipcRenderer.invoke("session:clear"),
  compressSession: (opts) => ipcRenderer.invoke("session:compress", opts || {}),
  removeSession: (id) => ipcRenderer.invoke("session:remove", id),
  removeSessions: (ids) => ipcRenderer.invoke("session:remove-many", ids),
  renameSession: (id, title) => ipcRenderer.invoke("session:rename", { id, title }),
  branchEdit: (payload) => ipcRenderer.invoke("session:branch-edit", payload),
  excludeContextMessage: (payload) => ipcRenderer.invoke("session:exclude-message", payload),
  restoreContextMessage: (payload) => ipcRenderer.invoke("session:restore-message", payload),
  deleteContextMessage: (payload) => ipcRenderer.invoke("session:delete-message", payload),
  editAssistantContextMessage: (payload) => ipcRenderer.invoke("session:edit-assistant-message", payload),
  switchBranch: (messageId, direction) =>
    ipcRenderer.invoke("session:switch-branch", { messageId, direction }),

  sendAgent: (payload) => ipcRenderer.send("agent:send", payload),
  stopAgent: (opts) => ipcRenderer.invoke("agent:stop", opts || {}),
  isAgentRunning: (opts) => ipcRenderer.invoke("agent:is-running", opts || {}),
  getAgentQueueStatus: (opts) => ipcRenderer.invoke("agent:queue-status", opts || {}),
  getAgentFileChanges: (sessionId) =>
    ipcRenderer.invoke("agent:file-changes", { sessionId }),
  getAgentFileChangeDiff: (filePath, sessionId) =>
    ipcRenderer.invoke("agent:file-change-diff", { path: filePath, sessionId }),
  rejectAgentChange: (filePath, sessionId) =>
    ipcRenderer.invoke("agent:reject-change", { path: filePath, sessionId }),
  rejectAllAgentChanges: (sessionId) =>
    ipcRenderer.invoke("agent:reject-all-changes", { sessionId }),
  acceptAllAgentChanges: (sessionId) =>
    ipcRenderer.invoke("agent:accept-all-changes", { sessionId }),
  respondConfirm: (id, allow) =>
    ipcRenderer.invoke("agent:confirm-response", { id, allow }),
  inlineEdit: (payload) => ipcRenderer.invoke("agent:inline-edit", payload),
  complete: (payload) => ipcRenderer.invoke("agent:complete", payload),
  genCommitMessage: () => ipcRenderer.invoke("agent:commit-message"),
  getContextStats: () => ipcRenderer.invoke("context:stats"),

  gitStatus: () => ipcRenderer.invoke("git:status"),
  gitDiff: (opts) => ipcRenderer.invoke("git:diff", opts),
  gitStage: (p) => ipcRenderer.invoke("git:stage", p),
  gitUnstage: (p) => ipcRenderer.invoke("git:unstage", p),
  gitDiscard: (p) => ipcRenderer.invoke("git:discard", p),
  gitCommit: (msg) => ipcRenderer.invoke("git:commit", msg),
  gitLog: (limit) => ipcRenderer.invoke("git:log", limit),

  termCreate: (size) => ipcRenderer.invoke("term:create", size),
  termList: () => ipcRenderer.invoke("term:list"),
  termWrite: (id, data) => ipcRenderer.invoke("term:write", { id, data }),
  termResize: (id, cols, rows) =>
    ipcRenderer.invoke("term:resize", { id, cols, rows }),
  termInterrupt: (id) => ipcRenderer.invoke("term:interrupt", id),
  termRun: (id, command) => ipcRenderer.invoke("term:run", { id, command }),
  termKill: (id) => ipcRenderer.invoke("term:kill", id),
  termDispose: (id) => ipcRenderer.invoke("term:dispose", id),
  termAvailable: () => ipcRenderer.invoke("term:available"),
  setPreferredPty: (id) => ipcRenderer.invoke("pty:set-preferred", id),
  getPreferredPty: () => ipcRenderer.invoke("pty:get-preferred"),
  mirrorToPty: (text) => ipcRenderer.invoke("pty:mirror", text),
  onTermData: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("term:data", listener);
    return () => ipcRenderer.removeListener("term:data", listener);
  },
  xterm: (() => {
    const fs = require("fs");
    const root = path.join(__dirname, "../../node_modules");
    const pick = (rel) => {
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) {
        console.warn("[emsoder preload] missing xterm asset:", abs);
        return "";
      }
      return pathToFileURL(abs).href;
    };
    return {
      cssUrl: pick("xterm/css/xterm.css"),
      jsUrl: pick("xterm/lib/xterm.js"),
      fitUrl: pick("xterm-addon-fit/lib/xterm-addon-fit.js"),
      webLinksUrl: pick(
        "xterm-addon-web-links/lib/xterm-addon-web-links.js"
      ),
    };
  })(),

  listRules: () => ipcRenderer.invoke("rules:list"),
  listSkills: () => ipcRenderer.invoke("skills:list"),
  setSkillDisabled: (id, disabled) =>
    ipcRenderer.invoke("skills:set-disabled", { id, disabled }),
  setSkillsDisabledBatch: (ids, disabled) =>
    ipcRenderer.invoke("skills:set-disabled-batch", { ids, disabled }),
  readSkill: (id) => ipcRenderer.invoke("skills:read", { id }),
  uninstallSkill: (id) => ipcRenderer.invoke("skills:uninstall", { id }),
  skillInstallPresets: () => ipcRenderer.invoke("skills:install-presets"),
  installSkill: (payload) => ipcRenderer.invoke("skills:install", payload),
  cancelSkillInstall: () => ipcRenderer.invoke("skills:install-cancel"),
  skillInstallStatus: () => ipcRenderer.invoke("skills:install-status"),
  onSkillInstallLog: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("skills:install-log", listener);
    return () => ipcRenderer.removeListener("skills:install-log", listener);
  },

  // ---- Long-term memory ----
  listMemories: (opts) => ipcRenderer.invoke("memory:list", opts),
  addMemory: (mem) => ipcRenderer.invoke("memory:add", mem),
  updateMemory: (id, patch) => ipcRenderer.invoke("memory:update", { id, patch }),
  removeMemory: (id) => ipcRenderer.invoke("memory:remove", { id }),
  searchMemories: (query, topK) => ipcRenderer.invoke("memory:search", { query, topK }),
  extractMemoriesNow: () => ipcRenderer.invoke("memory:extract-now"),
  clearMemories: () => ipcRenderer.invoke("memory:clear"),

  // ---- MCP ----
  listMcpServers: () => ipcRenderer.invoke("mcp:list"),
  upsertMcpServer: (server) => ipcRenderer.invoke("mcp:upsert", server),
  removeMcpServer: (id) => ipcRenderer.invoke("mcp:remove", id),
  connectMcp: (id) => ipcRenderer.invoke("mcp:connect", id),
  disconnectMcp: (id) => ipcRenderer.invoke("mcp:disconnect", id),
  onMcpEvent: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("mcp:event", listener);
    return () => ipcRenderer.removeListener("mcp:event", listener);
  },

  getTsconfig: () => ipcRenderer.invoke("lsp:tsconfig"),

  questList: () => ipcRenderer.invoke("quest:list"),
  questBoard: () => ipcRenderer.invoke("quest:board"),
  questGet: (id) => ipcRenderer.invoke("quest:get", id),
  questGetActive: () => ipcRenderer.invoke("quest:get-active"),
  questSetActive: (id) => ipcRenderer.invoke("quest:set-active", id),
  questCreate: (payload) => ipcRenderer.invoke("quest:create", payload),
  questUpdate: (id, patch) => ipcRenderer.invoke("quest:update", { id, patch }),
  questRemove: (id) => ipcRenderer.invoke("quest:remove", id),
  questStart: (id) => ipcRenderer.invoke("quest:start", id),
  questStop: (id) => ipcRenderer.invoke("quest:stop", id),
  questRejectChange: (id, filePath) =>
    ipcRenderer.invoke("quest:reject-change", { id, path: filePath }),
  questComplete: (id) => ipcRenderer.invoke("quest:complete", id),
  questIsRunning: (id) => ipcRenderer.invoke("quest:is-running", id),
  onQuestEvent: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("quest:event", listener);
    return () => ipcRenderer.removeListener("quest:event", listener);
  },

  debugState: () => ipcRenderer.invoke("debug:state"),
  debugLaunch: (opts) => ipcRenderer.invoke("debug:launch", opts),
  debugStop: () => ipcRenderer.invoke("debug:stop"),
  debugContinue: () => ipcRenderer.invoke("debug:continue"),
  debugPause: () => ipcRenderer.invoke("debug:pause"),
  debugStepOver: () => ipcRenderer.invoke("debug:step-over"),
  debugStepInto: () => ipcRenderer.invoke("debug:step-into"),
  debugStepOut: () => ipcRenderer.invoke("debug:step-out"),
  debugEvaluate: (expression, callFrameId) =>
    ipcRenderer.invoke("debug:evaluate", { expression, callFrameId }),
  debugSetBreakpoint: (filePath, line) =>
    ipcRenderer.invoke("debug:set-breakpoint", { path: filePath, line }),
  debugRemoveBreakpoint: (filePath, line) =>
    ipcRenderer.invoke("debug:remove-breakpoint", { path: filePath, line }),
  debugClearBreakpoints: () => ipcRenderer.invoke("debug:clear-breakpoints"),
  debugListBreakpoints: () => ipcRenderer.invoke("debug:list-breakpoints"),
  onDebugEvent: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("debug:event", listener);
    return () => ipcRenderer.removeListener("debug:event", listener);
  },

  onConfigChanged: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("config:changed", listener);
    return () => ipcRenderer.removeListener("config:changed", listener);
  },
  onAgentEvent: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
  onConfirm: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("agent:confirm", listener);
    return () => ipcRenderer.removeListener("agent:confirm", listener);
  },
  onMenu: (channel, cb) => {
    const map = {
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
    const ch = map[channel];
    if (!ch) return () => {};
    const listener = () => cb();
    ipcRenderer.on(ch, listener);
    return () => ipcRenderer.removeListener(ch, listener);
  },
  onWorkspaceChanged: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on("workspace:changed", listener);
    return () => ipcRenderer.removeListener("workspace:changed", listener);
  },
  onOpenFiles: (cb) => {
    const listener = (_e, files) => cb(files);
    ipcRenderer.on("files:open", listener);
    return () => ipcRenderer.removeListener("files:open", listener);
  },
  onBeforeClose: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("app:before-close", listener);
    return () => ipcRenderer.removeListener("app:before-close", listener);
  },
});
