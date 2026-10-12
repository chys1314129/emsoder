"use strict";
/**
 * EMSoder Node host — the Electron main process, rehosted on Tauri.
 *
 * This is a faithful port of `src/main/main.js` with three differences:
 *
 *   1. stdout belongs to the RPC tunnel, so every console channel is redirected
 *      to stderr before anything else loads.
 *   2. `require("electron")` is redirected to `./platform.js`, so the IPC domain
 *      modules, the agent, the tools etc. run unchanged.
 *   3. Window/menu/tray work comes from the shell: `buildMenu()` is Rust's
 *      `src-tauri/src/menu.rs`, and the close handshake arrives as the
 *      `app:before-close` event instead of a native window `close` event.
 *
 * Everything else — service boot order, IPC context, confirmations, the
 * workspace task pool, shutdown ordering — is copied from main.js on purpose, so
 * the two builds stay comparable while both are alive.
 */

// --- 1. stdout is the tunnel; printing there would corrupt the protocol. -----
(function redirectConsole() {
  const toStderr = (...args) => {
    try {
      const text = args
        .map((a) => {
          if (typeof a === "string") return a;
          try {
            return typeof a === "object" && a !== null ? JSON.stringify(a) : String(a);
          } catch {
            return String(a);
          }
        })
        .join(" ");
      process.stderr.write(text + "\n");
    } catch {
      /* nothing sensible left to do */
    }
  };
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.debug = toStderr;
  console.error = toStderr;
})();

// --- 2. Swap in the Electron shim before any src/ module loads. -------------
require("./electron-shim.js").install();

const path = require("path");
const fs = require("fs/promises");
const tunnel = require("./tunnel.js");
const platform = require("./platform.js");
const { app, BrowserWindow, ipcMain, dialog, screen, nativeTheme } = platform;

// --- 3. The app itself (unchanged modules). --------------------------------
const {
  loadConfig,
  saveConfig,
  getActiveModel,
  getActiveProvider,
  getProviders,
} = require("../src/core/config");
const logger = require("../src/core/logger");
const { SessionStore } = require("../src/agent/session");
const { AgentRunner } = require("../src/agent/runner");
const { PiRunnerAdapter } = require("../src/pi/runnerAdapter");
const { MemoryStore } = require("../src/agent/memory");
const { testProvider, chatOnce } = require("../src/providers");
const { isHeavyDirName, realpathOrBestEffort } = require("../src/tools/paths");
const { searchWorkspace } = require("../src/tools/search");
const { listCodeFiles } = require("../src/tools/codeIndex");
const git = require("../src/tools/git");
const { TerminalManager } = require("../src/main/terminal");
const { PtyBridge } = require("../src/main/ptyBridge");
const { NodeDebugger } = require("../src/main/debugger");
const { WorkspaceTaskPool } = require("../src/main/workspaceTaskPool");
const { QuestStore } = require("../src/agent/questStore");
const { QuestRunner } = require("../src/agent/questRunner");
const { McpManager } = require("../src/mcp/manager");
const { runAgentTurn } = require("../src/main/agentBridge");
const {
  tracker: contextStats,
  formatContextLabel,
  formatCacheLabel,
} = require("../src/core/contextStats");
const { normalizePermissionMode } = require("../src/tools/confirm");

const ipcGit = require("../src/main/ipc/git");
const ipcTerminal = require("../src/main/ipc/terminal");
const ipcPty = require("../src/main/ipc/pty");
const ipcDebugger = require("../src/main/ipc/debugger");
const ipcDrafts = require("../src/main/ipc/drafts");
const ipcMemory = require("../src/main/ipc/memory");
const ipcContext = require("../src/main/ipc/context");
const ipcRules = require("../src/main/ipc/rules");
const ipcProviders = require("../src/main/ipc/providers");
const ipcMcp = require("../src/main/ipc/mcp");
const ipcSkills = require("../src/main/ipc/skills");
const ipcQuest = require("../src/main/ipc/quest");
const ipcFs = require("../src/main/ipc/fs");
const ipcSession = require("../src/main/ipc/session");
const ipcConfig = require("../src/main/ipc/config");
const ipcDialog = require("../src/main/ipc/dialog");
const ipcApp = require("../src/main/ipc/app");
const ipcAgent = require("../src/main/ipc/agent");
const {
  listCredentials,
  setCredential,
  clearCredential,
  publicProvider,
  publicMcp,
} = require("../src/main/credentialCatalog");

let mainWindow = null;
let cfg = null;
let sessions = null;
let runner = null;
let terminals = null;
let ptyBridge = null;
let nodeDebugger = null;
let questStore = null;
let questRunner = null;
let memoryStore = null;
let mcpManager = null;
const pendingConfirms = new Map();
const pendingConfirmTimers = new Map();
let isQuitting = false;
let completeGen = 0;
let completeAbort = null;

const completion = {
  get gen() {
    return completeGen;
  },
  bumpGen() {
    completeGen += 1;
    return completeGen;
  },
  get abort() {
    return completeAbort;
  },
  set abort(v) {
    completeAbort = v;
  },
  abortCurrent() {
    try {
      completeAbort?.abort();
    } catch {
      /* ignore */
    }
  },
};

const isDev = process.env.EMSODER_DEV === "1";
/** EMSODER_DEBUG=1 logs every renderer->host request and its latency. */
const debugTunnel = process.env.EMSODER_DEBUG === "1";

// ---------------------------------------------------------------------------
// Helpers ported from main.js
// ---------------------------------------------------------------------------

/** http(s) only — same allow-list as the Electron build. */
function safeOpenExternal(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol === "http:" || u.protocol === "https:") {
      platform.shell.openExternal(url);
    } else {
      logger.warn("拦截打开非 http(s) 链接", { url, protocol: u.protocol });
    }
  } catch {
    logger.warn("拦截打开非法链接", { url });
  }
}

function createWindow() {
  const bounds = cfg?.windowBounds || { width: 1440, height: 900 };
  mainWindow = new BrowserWindow({
    width: bounds.width || 1440,
    height: bounds.height || 900,
    minWidth: 960,
    minHeight: 640,
    x: bounds.x,
    y: bounds.y,
    backgroundColor: "#0b1220",
    title: "EMSoder",
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

  // The shell asks us to close (native CloseRequested); platform.js re-emits it
  // as Electron's 'close' so this block ports over verbatim.
  let closeFailsafe = null;
  mainWindow.on("close", (e) => {
    const b = mainWindow.getBounds();
    cfg.windowBounds = b;
    saveConfig(cfg);
    if (isQuitting) return;
    e.preventDefault();
    mainWindow.webContents.send("app:before-close");
    if (closeFailsafe) clearTimeout(closeFailsafe);
    closeFailsafe = setTimeout(() => {
      if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
      isQuitting = true;
      mainWindow.destroy();
    }, 3000);
  });
  mainWindow.on("closed", () => {
    if (closeFailsafe) clearTimeout(closeFailsafe);
    try {
      destroyFloatingBall();
    } catch {
      /* ignore */
    }
  });

  // Global audio mute is enforced in the renderer now (Tauri has no per-webview
  // mute); this keeps the call sites honest without doing anything.
  applyAudioMute();
}

/**
 * In the Electron build this muted every webview via
 * `webContents.setAudioMuted`. Tauri has no equivalent, so the renderer gates
 * audio on `config.soundEnabled` instead (renderer/js/dom-util.js).
 */
function applyAudioMute() {
  /* intentionally empty — see comment above */
}

let ballWindow = null;
function createFloatingBall() {
  if (ballWindow && !ballWindow.isDestroyed()) {
    ballWindow.show();
    return ballWindow;
  }
  const primary = screen?.getPrimaryDisplay?.();
  const wa = primary?.workArea || { x: 0, y: 0, width: 1280, height: 800 };
  const w = 132;
  const h = 44;
  ballWindow = new BrowserWindow({
    width: w,
    height: h,
    x: wa.x + wa.width - w - 24,
    y: wa.y + wa.height - h - 60,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
  });
  ballWindow.loadFile(path.join(__dirname, "../renderer/ball.html"));
  ballWindow.show();
  ballWindow.on("closed", () => {
    ballWindow = null;
  });
  return ballWindow;
}

function destroyFloatingBall() {
  if (ballWindow && !ballWindow.isDestroyed()) ballWindow.destroy();
  ballWindow = null;
}

function syncFloatingBall() {
  if (cfg?.floatingBallEnabled) createFloatingBall();
  else destroyFloatingBall();
}

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

async function openWorkspace(sessionId = null) {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (res.canceled || !res.filePaths[0]) return null;
  const root = res.filePaths[0];
  cfg.lastWorkspace = root;
  sessions?.setWorkspaceRoot?.(root, sessionId);
  saveConfig(cfg);
  sendToMain("workspace:changed", {
    workspaceRoot: root,
    sessionId: sessionId || sessions?.getActive?.()?.id || null,
  });
  return root;
}

async function openFileDialog() {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    defaultPath: cfg.lastWorkspace || undefined,
  });
  if (res.canceled) return [];
  registerExternalFiles(res.filePaths);
  return res.filePaths;
}

const externallyOpenedFiles = new Set();

function registerExternalFiles(filePaths) {
  for (const p of Array.isArray(filePaths) ? filePaths : []) {
    if (typeof p === "string" && p) {
      try {
        externallyOpenedFiles.add(path.resolve(p));
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * In Electron this checked `event.senderFrame` against the app's own file://
 * URLs. Under Tauri the webview can only reach these handlers through the
 * shell's `rpc` command, and no remote content is ever loaded, so the guard is
 * structural. Kept as a function because `ctx` and every domain module call it.
 */
function assertTrustedSender() {
  return true;
}

function isAllowedFile(filePath) {
  const abs = path.resolve(String(filePath || ""));
  if (cfg?.lastWorkspace) {
    const ws = path.resolve(cfg.lastWorkspace);
    const rel = path.relative(ws, abs);
    const lexInside = !rel.startsWith("..") && !path.isAbsolute(rel);
    if (lexInside) {
      const realWs = realpathOrBestEffort(ws);
      const realAbs = realpathOrBestEffort(abs);
      const realRel = path.relative(realWs, realAbs);
      if (!realRel.startsWith("..") && !path.isAbsolute(realRel)) return true;
      return false;
    }
  }
  return externallyOpenedFiles.has(abs);
}

function assertAllowedDir(dirPath) {
  const root = dirPath || cfg.lastWorkspace;
  if (!root) throw new Error("未打开工作区");
  if (cfg.lastWorkspace) {
    const abs = path.resolve(root);
    const ws = path.resolve(cfg.lastWorkspace);
    const rel = path.relative(ws, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("目录越界：只能浏览当前工作区");
    }
  }
  return root;
}

function broadcast(channel, ...args) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

/**
 * Electron's `mainWindow.webContents.send`, guarded against a dead window.
 *
 * Several streams only ever went to the main window there — most importantly the
 * terminal output and agent debug events, which are the highest-volume pushes in
 * the app. Broadcasting them would hand the floating ball a copy of every byte
 * for nothing.
 */
function sendToMain(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

const IMAGE_GEN_BACKENDS = new Set([
  "modelscope",
  "zhipu",
  "openai",
  "openrouter",
  "siliconflow",
  "volcengine",
  "qwen",
  "minimax",
]);

function normalizeImageGenBackend(value) {
  const backend = String(value || "").trim().toLowerCase();
  return IMAGE_GEN_BACKENDS.has(backend) ? backend : "modelscope";
}

/** Strip sensitive keys; the renderer only learns presence flags. */
function publicConfig(c) {
  return {
    activeProviderId: c.activeProviderId,
    activeModel: getActiveModel(c),
    keylessFallbackEnabled: c.keylessFallbackEnabled === true,
    providers: (Array.isArray(c.providers) ? c.providers : []).map(publicProvider),
    agentBackend: c.agentBackend === "pi" ? "pi" : "emsoder",
    agentMode: true,
    permissionMode: normalizePermissionMode(c),
    collapseProcess: c.collapseProcess !== false,
    terminalRunMode: c.terminalRunMode || "askEveryTime",
    commandDenyList: c.commandDenyList || "",
    executionEnvKeys: Object.keys(c.executionEnv || {}).sort(),
    maxTokens: c.maxTokens ?? 0,
    temperature: c.temperature ?? 0.2,
    reasoningEffort: (() => {
      const s = String(c.reasoningEffort || "medium").toLowerCase();
      return ["off", "low", "medium", "high", "ultra"].includes(s) ? s : "medium";
    })(),
    agentMaxRounds: c.agentMaxRounds ?? 0,
    agentAutoContinue:
      c.agentAutoContinue === false || c.agentAutoContinue === 0
        ? 0
        : c.agentAutoContinue ?? -1,
    runMode: c.runMode === "plan" || c.runMode === "goal" ? c.runMode : "auto",
    systemPrompt: c.systemPrompt || "",
    responseLanguage: c.responseLanguage || "zh-cn",
    theme: c.theme || "sky-dark",
    lastWorkspace: c.lastWorkspace || "",
    sidebarWidth: c.sidebarWidth || 380,
    showSidebar: c.showSidebar !== false,
    showBottomPanel: c.showBottomPanel !== false,
    bottomPanelHeight: c.bottomPanelHeight || 220,
    bottomPanelTab: c.bottomPanelTab || "terminal",
    completionEnabled: c.completionEnabled !== false,
    completionDebounceMs: c.completionDebounceMs ?? 400,
    fontSize: c.fontSize || 14,
    tabSize: c.tabSize || 2,
    skillsEnabled: c.skillsEnabled !== false,
    skillsIncludeBundled: c.skillsIncludeBundled !== false,
    skillsIncludePlugins: c.skillsIncludePlugins !== false,
    skillsDirs: Array.isArray(c.skillsDirs) ? c.skillsDirs : [],
    skillsDisabled: Array.isArray(c.skillsDisabled) ? c.skillsDisabled : [],
    memoriesEnabled: c.memoriesEnabled === true,
    memoriesMaxCount: c.memoriesMaxCount ?? 500,
    mcpServers: (Array.isArray(c.mcpServers) ? c.mcpServers : []).map(publicMcp),
    wordWrap: c.wordWrap || "off",
    minimap: !!c.minimap,
    contextWindow: c.contextWindow || 0,
    modelContextWindows: c.modelContextWindows || {},
    autoCompressAt: c.autoCompressAt ?? 80,
    soundEnabled: c.soundEnabled !== false,
    soundVolume: c.soundVolume ?? 1.0,
    floatingBallEnabled: c.floatingBallEnabled === true,
    imageProvider: c.imageProvider === "unsplash" ? "unsplash" : "pexels",
    pexelsApiKeySet: !!(c.pexelsApiKey && String(c.pexelsApiKey).trim()),
    unsplashApiKeySet: !!(c.unsplashApiKey && String(c.unsplashApiKey).trim()),
    imageGenBackend: normalizeImageGenBackend(c.imageGenBackend),
    imageGenModel: c.imageGenModel || "",
    imageGenBaseUrl: c.imageGenBaseUrl || "",
    imageGenApiKeySet: !!(c.imageGenApiKey && String(c.imageGenApiKey).trim()),
    providerName: getActiveProvider(c)?.name || "none",
  };
}

// ---------------------------------------------------------------------------
// Confirmations
// ---------------------------------------------------------------------------

function resolveConfirm(id, allow) {
  const entry = pendingConfirms.get(id);
  if (entry) {
    pendingConfirms.delete(id);
    const t = pendingConfirmTimers.get(id);
    if (t) {
      clearTimeout(t);
      pendingConfirmTimers.delete(id);
    }
    entry.answer(!!allow);
  }
}

function cancelAllConfirms(sessionId = null) {
  for (const [id, entry] of pendingConfirms) {
    if (sessionId && entry.sessionId !== sessionId) continue;
    pendingConfirms.delete(id);
    const t = pendingConfirmTimers.get(id);
    if (t) {
      clearTimeout(t);
      pendingConfirmTimers.delete(id);
    }
    try {
      entry.answer(false);
    } catch {
      /* ignore */
    }
  }
}

function allowClose() {
  isQuitting = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
}

function askConfirm(message, meta = {}) {
  return new Promise((resolve) => {
    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const onAnswer = (answer) => {
      const t = pendingConfirmTimers.get(id);
      if (t) {
        clearTimeout(t);
        pendingConfirmTimers.delete(id);
      }
      resolve(answer);
    };
    pendingConfirms.set(id, {
      answer: onAnswer,
      sessionId: meta.sessionId || null,
      taskId: meta.taskId || null,
      workspaceRoot: meta.workspaceRoot || "",
    });
    sendToMain("agent:confirm", {
      id,
      message,
      sessionId: meta.sessionId || null,
      taskId: meta.taskId || null,
      workspaceRoot: meta.workspaceRoot || "",
    });
    const timer = setTimeout(() => {
      if (pendingConfirms.has(id)) {
        pendingConfirms.delete(id);
        pendingConfirmTimers.delete(id);
        resolve(false);
      }
    }, 5 * 60 * 1000);
    pendingConfirmTimers.set(id, timer);
  });
}

// ---------------------------------------------------------------------------
// IPC registration — same context shape as main.js
// ---------------------------------------------------------------------------

function registerIpc() {
  function publicSession(s) {
    if (!s) return null;
    const p = sessions.getActivePath(s);
    const branchMeta = sessions.getBranchMeta(s);
    return {
      id: s.id,
      title: s.title,
      mode: s.mode,
      workspaceRoot: s.workspaceRoot || "",
      runStatus: s.runStatus || "idle",
      activeLeafId: s.activeLeafId || null,
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      messages: p,
      branchMeta,
      excludedBranches: sessions.getExcludedBranches?.(s) || [],
      fileChanges: sessions.publicFileChanges(s),
    };
  }

  const broadcastPublicConfig = () => {
    const fresh = publicConfig(cfg);
    for (const win of BrowserWindow.getAllWindows()) {
      if (win && !win.isDestroyed()) win.webContents.send("config:changed", fresh);
    }
  };

  ipcMain.handle("credentials:list", () => ({ ok: true, items: listCredentials(cfg) }));
  ipcMain.handle("credentials:set", (_event, payload = {}) => {
    const items = setCredential(cfg, payload);
    saveConfig(cfg);
    broadcastPublicConfig();
    return { ok: true, items };
  });
  ipcMain.handle("credentials:clear", (_event, payload = {}) => {
    const items = clearCredential(cfg, payload);
    saveConfig(cfg);
    broadcastPublicConfig();
    return { ok: true, items };
  });

  ipcMain.handle("logger:export", async () => {
    const fsSync = require("fs");
    const logFile = logger.logPath();
    const dir = path.dirname(logFile);
    const base = path.basename(logFile);
    const parts = [];
    const found = [];
    for (const name of [base, `${base}.1`, `${base}.2`]) {
      const p = path.join(dir, name);
      try {
        if (fsSync.existsSync(p)) {
          parts.push(`========== ${name} ==========\n` + fsSync.readFileSync(p, "utf8"));
          found.push(name);
        }
      } catch {
        /* ignore */
      }
    }
    if (!parts.length) return { ok: false, error: "暂无日志内容" };
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const res = await dialog.showSaveDialog(mainWindow, {
      title: "导出 EMSoder 日志",
      defaultPath: `emsoder-log-${ts}.log`,
      filters: [{ name: "Log", extensions: ["log", "txt"] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    await fs.writeFile(res.filePath, parts.join("\n\n"), "utf8");
    logger.info("日志已导出", { path: res.filePath, files: found });
    return { ok: true, path: res.filePath, files: found };
  });

  ipcProviders.register(ipcMain, { cfg, publicConfig, assertTrustedSender });

  ipcMain.handle("workspace:open", (_e, { sessionId } = {}) => openWorkspace(sessionId));
  ipcMain.handle(
    "workspace:get",
    (_e, { sessionId } = {}) =>
      (sessionId && sessions?.getById?.(sessionId)?.workspaceRoot) ||
      sessions?.getActive?.()?.workspaceRoot ||
      cfg.lastWorkspace ||
      ""
  );

  ipcMcp.register(ipcMain, { cfg, mcpManager, assertTrustedSender });

  function emitChatQueueStatus(snapshot = {}) {
    broadcast("agent:event", { type: "queue", ...snapshot });
  }
  const chatPool = new WorkspaceTaskPool({
    maxConcurrent: 3,
    onChange: (snapshot) => {
      sessions?.setDebounceMs?.(snapshot.running ? 2000 : 450);
      questStore?.setDebounceMs?.(snapshot.running ? 2000 : 450);
      emitChatQueueStatus(snapshot);
    },
  });
  const chatQueue = {
    get length() {
      return chatPool.length;
    },
    get isBusy() {
      return chatPool.isBusy;
    },
    enqueue(meta, run) {
      return chatPool.enqueue({ ...meta, run }).promise;
    },
    cancelSession(sessionId, reason) {
      chatPool.cancelSession(sessionId, reason);
    },
    clearQueue(reason) {
      chatPool.stopAll(reason);
    },
    snapshot() {
      return chatPool.snapshot();
    },
    isSessionBusy(sessionId) {
      return chatPool.isSessionBusy(sessionId);
    },
    emitStatus(extra = {}) {
      emitChatQueueStatus({ ...chatPool.snapshot(), ...extra });
    },
  };

  const ctx = {
    cfg,
    saveConfig,
    sessions,
    runner,
    terminals,
    ptyBridge,
    memoryStore,
    mcpManager,
    questStore,
    questRunner,
    nodeDebugger,
    dialog,
    getWindow: () => mainWindow,
    publicConfig,
    publicSession,
    askConfirm,
    assertTrustedSender,
    isAllowedFile,
    assertAllowedDir,
    registerExternalFiles,
    openFileDialog,
    allowClose,
    chatQueue,
    cancelAllConfirms,
    resolveConfirm,
    completion,
    syncFloatingBall,
    applyAudioMute,
    showMainWindow: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    },
  };

  ipcApp.register(ipcMain, ctx);
  ipcConfig.register(ipcMain, ctx);
  ipcFs.register(ipcMain, ctx);
  ipcSession.register(ipcMain, ctx);
  ipcAgent.register(ipcMain, ctx);
  ipcDialog.register(ipcMain, ctx);
  ipcGit.register(ipcMain, { cfg, dialog, getWindow: () => mainWindow });
  ipcTerminal.register(ipcMain, { cfg, terminals });
  ipcRules.register(ipcMain, { cfg });
  ipcSkills.register(ipcMain, { cfg });
  ipcMemory.register(ipcMain, { cfg, sessions, memoryStore });
  ipcContext.register(ipcMain, { cfg });
  ipcPty.register(ipcMain, { ptyBridge });
  ipcDebugger.register(ipcMain, { cfg, nodeDebugger });
  ipcQuest.register(ipcMain, {
    cfg,
    questStore,
    questRunner,
    getWindow: () => mainWindow,
    ptyBridge,
    askConfirm,
  });
  ipcDrafts.register(ipcMain, {});
}

// ---------------------------------------------------------------------------
// Menu — the items live in src-tauri/src/menu.rs; the actions live here, copied
// from buildMenu()'s click handlers.
// ---------------------------------------------------------------------------

const menuActions = {
  "menu:save": () => sendToMain("menu:save"),
  "menu:toggle-sidebar": () => sendToMain("menu:toggle-sidebar"),
  "menu:toggle-bottom": () => sendToMain("menu:toggle-bottom"),
  "menu:show-terminal": () => sendToMain("menu:show-terminal"),
  "menu:show-git": () => sendToMain("menu:show-git"),
  "menu:new-chat": () => sendToMain("menu:new-chat"),
  "menu:add-selection": () => sendToMain("menu:add-selection"),
  "menu:explain-selection": () => sendToMain("menu:explain-selection"),
  "menu:inline-edit": () => sendToMain("menu:inline-edit"),
  "menu:gen-commit": () => sendToMain("menu:gen-commit"),
  "menu:select-model": () => sendToMain("menu:select-model"),
  "menu:providers": () => sendToMain("menu:providers"),

  "menu:open-workspace": () => openWorkspace(),

  "menu:open-file": async () => {
    const files = await openFileDialog();
    if (files?.length) sendToMain("files:open", files);
  },

  "menu:test-provider": async () => {
    const p = getActiveProvider(cfg);
    if (!p) return;
    const r = await raceTimeout(testProvider(cfg, p), 16000, "测试");
    await dialog.showMessageBox(mainWindow, {
      type: r.ok ? "info" : "error",
      title: "测试结果",
      message: r.message,
      detail: `${r.latencyMs} ms`,
    });
  },

  "menu:about": () =>
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "关于 EMSoder",
      message: "EMSoder 1.0",
      detail: "打开文件夹，说话，文件会改。你审。\n自己的模型 · 无账号 · 无 Credits",
    }),
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function shutdown(reason) {
  logger.info("EMSoder 退出", { reason });
  try {
    runner?.stop?.();
  } catch {
    /* ignore */
  }
  try {
    runner?.close?.();
  } catch {
    /* ignore */
  }
  try {
    questRunner?.stopAll?.();
  } catch {
    /* ignore */
  }
  try {
    mcpManager?.stopAll?.();
  } catch {
    /* ignore */
  }
  try {
    nodeDebugger?.stop?.();
  } catch {
    /* ignore */
  }
  try {
    sessions?.flush?.();
  } catch {
    /* ignore */
  }
  try {
    memoryStore?.flush?.();
  } catch {
    /* ignore */
  }
  try {
    questStore?.flush?.();
  } catch {
    /* ignore */
  }
}

async function boot() {
  process.on("uncaughtException", (err) => logger.error("uncaughtException", err));
  process.on("unhandledRejection", (err) => logger.error("unhandledRejection", err));

  nativeTheme.themeSource = "dark";
  await platform._internal.primeDisplays();

  cfg = loadConfig();
  logger.info("EMSoder 启动(Tauri)", {
    version: app.getVersion(),
    userData: app.getPath("userData"),
    logFile: logger.logPath(),
    dpapi: platform._internal.helperAvailable,
  });

  createWindow();

  sessions = new SessionStore();
  mcpManager = new McpManager({
    onEvent: (data) => sendToMain("mcp:event", data),
  });
  mcpManager.startAll(cfg);
  memoryStore = new MemoryStore(cfg);
  runner = new AgentRunner(sessions, memoryStore, mcpManager);
  const legacyRunner = runner;
  if (cfg.agentBackend === "pi") {
    runner = new PiRunnerAdapter(sessions, legacyRunner, mcpManager);
  }
  questStore = new QuestStore();
  questRunner = new QuestRunner(questStore, memoryStore, mcpManager);
  try {
    for (const q of questStore.list()) {
      if (q.status === "running") {
        questStore.update(q.id, {
          status: "error",
          error: "上次运行被中断",
          finishedAt: Date.now(),
        });
      }
    }
  } catch {
    /* ignore */
  }
  terminals = new TerminalManager();
  ptyBridge = new PtyBridge(terminals);
  nodeDebugger = new NodeDebugger();
  terminals.on("data", (payload) => sendToMain("term:data", payload));
  const forwardDebug = (channel) => (payload) => sendToMain(channel, payload);
  nodeDebugger.on("started", (p) => forwardDebug("debug:event")({ type: "started", ...p }));
  nodeDebugger.on("paused", (p) => forwardDebug("debug:event")({ type: "paused", ...p }));
  nodeDebugger.on("resumed", () => forwardDebug("debug:event")({ type: "resumed" }));
  nodeDebugger.on("output", (p) => forwardDebug("debug:event")({ type: "output", ...p }));
  nodeDebugger.on("exited", (p) => forwardDebug("debug:event")({ type: "exited", ...p }));
  nodeDebugger.on("stopped", () => forwardDebug("debug:event")({ type: "stopped" }));

  registerIpc();

  try {
    syncFloatingBall();
  } catch {
    /* ignore */
  }

  wireShellEvents();
  tunnel.emit("host:ready", [{ pid: process.pid, version: app.getVersion() }]);
}

/** Shell -> host events. */
function wireShellEvents() {
  tunnel.on("window:bounds", (payload) => {
    const entry = Array.isArray(payload) ? payload[0] : payload;
    if (entry?.kind) platform._internal.updateBounds(entry.kind, entry.bounds);
  });

  // Native close: let the ported 'close' handler do its dance.
  tunnel.on("app:before-close", () => {
    platform._internal.emitCloseRequest();
  });

  for (const channel of Object.keys(menuActions)) {
    tunnel.on(channel, () => {
      try {
        const result = menuActions[channel]();
        if (result && typeof result.catch === "function") {
          result.catch((err) => logger.error(`菜单动作失败 ${channel}`, err));
        }
      } catch (err) {
        logger.error(`菜单动作失败 ${channel}`, err);
      }
    });
  }

  tunnel.on("app:before-quit", () => {
    shutdown("before-quit");
  });

  tunnel.on("app:quit", () => {
    shutdown("quit");
    // Give the flush a tick to hit disk, then let the shell tear down the
    // process tree.
    setTimeout(() => process.exit(0), 50);
  });

  // The shell vanished under us (killed, or crashed). Flush what we can and
  // leave, rather than lingering as an orphan process.
  tunnel.on("app:shell-gone", () => {
    process.stderr.write("[host] 壳进程已消失，宿主自行退出\n");
    shutdown("shell-gone");
    setTimeout(() => process.exit(0), 50);
  });

  tunnel.on("app:show-main", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

/**
 * Renderer calls land here: the shell's `rpc` command carries the real IPC
 * channel name plus its argument list.
 */
/**
 * Renderer calls land here: the shell's `rpc` command carries the real IPC
 * channel name plus its argument list, and `from` names the asking window.
 */
function serveRenderer(channel, args, from) {
  // Debug the tunnel itself with EMSODER_DEBUG=1: the first thing to establish
  // when the UI looks stuck is whether renderer calls are reaching this process
  // at all, and whether they resolve.
  if (debugTunnel) {
    const started = Date.now();
    const finish = () => process.stderr.write(`[tunnel] ${from || "?"} ${channel} ${Date.now() - started}ms\n`);
    // `agent:send` was fire-and-forget in Electron (ipcMain.on); every other
    // channel was invoke (ipcMain.handle).
    const result = ipcMain._events.has(channel)
      ? Promise.resolve(ipcMain.dispatch(channel, args, from))
      : ipcMain.invoke(channel, args, from);
    return Promise.resolve(result).then(
      (value) => {
        finish();
        return value;
      },
      (err) => {
        process.stderr.write(`[tunnel] ${from || "?"} ${channel} 失败：${(err && err.message) || err}\n`);
        throw err;
      }
    );
  }
  if (ipcMain._events.has(channel)) {
    return Promise.resolve(ipcMain.dispatch(channel, args, from));
  }
  return ipcMain.invoke(channel, args, from);
}

const booted = boot();

// Gate every renderer request on boot completion: the webview can start asking
// for state before the 17 IPC domain modules are registered, and an
// "没有注册的 IPC 通道" error on first paint would be a blank app.
tunnel.setRequestHandler((channel, args, from) =>
  booted.then(() => serveRenderer(channel, args, from))
);

booted.catch((err) => {
  logger.error("宿主启动失败", err);
  process.stderr.write(`[host] 启动失败：${err && err.stack}\n`);
  // Let the shell show the error and exit rather than lingering headless.
  setTimeout(() => process.exit(1), 200);
});
