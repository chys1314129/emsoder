const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  nativeTheme,
} = require("electron");
const path = require("path");
const fs = require("fs/promises");
const { pathToFileURL, fileURLToPath } = require("url");
const {
  loadConfig,
  saveConfig,
  getActiveModel,
  getActiveProvider,
  getProviders,
} = require("../core/config");
const logger = require("../core/logger");
const { SessionStore } = require("../agent/session");
const { AgentRunner } = require("../agent/runner");
const { PiRunnerAdapter } = require("../pi/runnerAdapter");
const { MemoryStore } = require("../agent/memory");
const { testProvider, chatOnce } = require("../providers");
const { isHeavyDirName, realpathOrBestEffort } = require("../tools/paths");
const { searchWorkspace } = require("../tools/search");
const { listCodeFiles } = require("../tools/codeIndex");
const git = require("../tools/git");
const { TerminalManager } = require("./terminal");
const { PtyBridge } = require("./ptyBridge");
const { NodeDebugger } = require("./debugger");
const { WorkspaceTaskPool } = require("./workspaceTaskPool");
const { QuestStore } = require("../agent/questStore");
const { QuestRunner } = require("../agent/questRunner");
const { McpManager } = require("../mcp/manager");
const { runAgentTurn } = require("./agentBridge");
const {
  tracker: contextStats,
  formatContextLabel,
  formatCacheLabel,
} = require("../core/contextStats");
const {
  normalizePermissionMode,
} = require("../tools/confirm");

// IPC domain modules (Phase 2 refactor: extracting registerIpc)
const ipcGit = require("./ipc/git");
const ipcTerminal = require("./ipc/terminal");
const ipcPty = require("./ipc/pty");
const ipcDebugger = require("./ipc/debugger");
const ipcDrafts = require("./ipc/drafts");
const ipcMemory = require("./ipc/memory");
const ipcContext = require("./ipc/context");
const ipcRules = require("./ipc/rules");
const ipcProviders = require("./ipc/providers");
const ipcMcp = require("./ipc/mcp");
const ipcSkills = require("./ipc/skills");
const ipcQuest = require("./ipc/quest");
const ipcFs = require("./ipc/fs");
const ipcSession = require("./ipc/session");
const ipcConfig = require("./ipc/config");
const ipcDialog = require("./ipc/dialog");
const ipcApp = require("./ipc/app");
const ipcAgent = require("./ipc/agent");
const { listCredentials, setCredential, clearCredential, publicProvider, publicMcp } = require("./credentialCatalog");

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
/** pending confirmations from agent tools */
const pendingConfirms = new Map();
const pendingConfirmTimers = new Map();
let isQuitting = false;
/** latest inline-completion generation token (drop stale results) */
let completeGen = 0;
let completeAbort = null;
/**
 * Completion race-state accessor. completeGen/completeAbort are module-level
 * `let`s used only by agent:complete; this object exposes them to the agent
 * IPC module via ctx without giving up the mutable binding.
 */
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

const isDev = process.argv.includes("--dev");

/**
 * 仅允许用系统默认方式打开 http(s) 链接；其余（file://、javascript: 等）
 * 一律拦截。否则渲染层（Monaco 链接检测 / xterm 链接 / markdown 链接）里
 * 出现 file://xxx.js 之类时，点击会用 shell.openExternal 触发 Windows 的
 * 「选择打开方式」对话框，或打开本地文件/危险 scheme。
 */
function safeOpenExternal(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol === "http:" || u.protocol === "https:") {
      shell.openExternal(url);
    } else {
      logger.warn("拦截打开非 http(s) 链接", { url, protocol: u.protocol });
    }
  } catch {
    logger.warn("拦截打开非法链接", { url });
  }
}

// single instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
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
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    // Avoid "no response": show as soon as possible (portable unpack already took time)
    show: false,
    icon: path.join(__dirname, "../../resources/icon.png"),
  });

  let shown = false;
  const showMain = () => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    mainWindow.show();
  };
  mainWindow.once("ready-to-show", showMain);
  mainWindow.webContents.on("did-finish-load", () => {
    try { mainWindow.webContents.setAudioMuted(cfg?.soundEnabled === false); } catch { /* ignore */ }
  });
  // Fallback: if HTML/Monaco slow, still surface the shell so user knows it launched
  const showFallback = setTimeout(showMain, 1200);
  mainWindow.on("closed", () => clearTimeout(showFallback));
  mainWindow.loadFile(path.join(__dirname, "../../renderer/index.html"));

  /** 关闭流程：请求渲染层确认 → 3s 内未应答强制关闭（防渲染层卡死锁窗） */
  let closeFailsafe = null;
  mainWindow.on("close", (e) => {
    const b = mainWindow.getBounds();
    cfg.windowBounds = b;
    saveConfig(cfg);
    if (isQuitting) return;
    // ask renderer if dirty tabs exist
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
    // 悬浮球是独立窗口：主窗口关了就一起收，避免它单独把 app 撑着不退出
    try { destroyFloatingBall(); } catch { /* ignore */ }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    safeOpenExternal(url);
    return { action: "deny" };
  });
  // 阻止主窗口导航到远程页面（防 preload API 暴露给远程内容）
  mainWindow.webContents.on("will-navigate", (e, url) => {
    const own =
      url.startsWith("file://") &&
      path.resolve(url.replace(/^file:\/\//, "")) ===
        path.resolve(path.join(__dirname, "../../renderer/index.html"));
    if (!own) e.preventDefault();
  });
  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  buildMenu();
  applyAudioMute();
}

/**
 * 全局静音开关：soundEnabled=false 时用 Electron 的 setAudioMuted 把整个应用
 * 的音频彻底静掉（不只是完成提示音），渲染层任何声音都发不出来。
 */
function applyAudioMute() {
  const muted = cfg?.soundEnabled === false;
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win && !win.isDestroyed()) win.webContents.setAudioMuted(muted);
    } catch { /* ignore */ }
  }
}

/** 桌面悬浮球：常驻置顶的小窗口，显示任务状态。可由设置开关。 */
let ballWindow = null;
function createFloatingBall() {
  if (ballWindow && !ballWindow.isDestroyed()) {
    ballWindow.show();
    return ballWindow;
  }
  const primary = require("electron").screen?.getPrimaryDisplay?.();
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
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  ballWindow.setAlwaysOnTop(true, "screen-saver");
  ballWindow.loadFile(path.join(__dirname, "../../renderer/ball.html"));
  ballWindow.once("ready-to-show", () => {
    if (ballWindow && !ballWindow.isDestroyed()) {
      ballWindow.show();
      try { ballWindow.webContents.setAudioMuted(cfg?.soundEnabled === false); } catch { /* ignore */ }
    }
  });
  ballWindow.webContents.setWindowOpenHandler(({ url }) => {
    safeOpenExternal(url);
    return { action: "deny" };
  });
  ballWindow.webContents.on("will-navigate", (e, url) => {
    const own =
      url.startsWith("file://") &&
      path.resolve(url.replace(/^file:\/\//, "")) ===
        path.resolve(path.join(__dirname, "../../renderer/ball.html"));
    if (!own) e.preventDefault();
  });
  ballWindow.on("closed", () => { ballWindow = null; });
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

/** 主进程侧硬超时，确保异步调用一定会返回（菜单"测试当前服务商"等使用）。 */
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

function buildMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        {
          label: "打开文件夹…",
          accelerator: "CmdOrCtrl+O",
          click: () => openWorkspace(),
        },
        {
          label: "打开文件…",
          accelerator: "CmdOrCtrl+P",
          click: async () => {
            const files = await openFileDialog();
            if (files?.length) {
              mainWindow?.webContents.send("files:open", files);
            }
          },
        },
        { type: "separator" },
        {
          label: "保存",
          accelerator: "CmdOrCtrl+S",
          click: () => mainWindow?.webContents.send("menu:save"),
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        {
          label: "切换 AI 侧栏",
          accelerator: "CmdOrCtrl+Shift+L",
          click: () => mainWindow?.webContents.send("menu:toggle-sidebar"),
        },
        {
          label: "切换底部面板",
          accelerator: "CmdOrCtrl+J",
          click: () => mainWindow?.webContents.send("menu:toggle-bottom"),
        },
        {
          label: "终端",
          accelerator: "Ctrl+`",
          click: () => mainWindow?.webContents.send("menu:show-terminal"),
        },
        {
          label: "Git 面板",
          click: () => mainWindow?.webContents.send("menu:show-git"),
        },
        {
          label: "新对话",
          accelerator: "CmdOrCtrl+N",
          click: () => mainWindow?.webContents.send("menu:new-chat"),
        },
        { type: "separator" },
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
    {
      label: "AI",
      submenu: [
        {
          label: "选区加入对话",
          accelerator: "CmdOrCtrl+Shift+K",
          click: () => mainWindow?.webContents.send("menu:add-selection"),
        },
        {
          label: "解释选区",
          click: () => mainWindow?.webContents.send("menu:explain-selection"),
        },
        {
          label: "Inline Edit",
          accelerator: "CmdOrCtrl+I",
          click: () => mainWindow?.webContents.send("menu:inline-edit"),
        },
        {
          label: "生成 Commit Message",
          click: () => mainWindow?.webContents.send("menu:gen-commit"),
        },
      ],
    },
    {
      label: "模型",
      submenu: [
        {
          label: "选择模型…",
          click: () => mainWindow?.webContents.send("menu:select-model"),
        },
        {
          label: "管理服务商…",
          click: () => mainWindow?.webContents.send("menu:providers"),
        },
        {
          label: "测试当前服务商",
          click: async () => {
            const p = getActiveProvider(cfg);
            if (!p) return;
            const r = await raceTimeout(testProvider(cfg, p), 16000, "测试");
            dialog.showMessageBox(mainWindow, {
              type: r.ok ? "info" : "error",
              title: "测试结果",
              message: r.message,
              detail: `${r.latencyMs} ms`,
            });
          },
        },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "关于 EMSoder",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "关于 EMSoder",
              message: "EMSoder 1.0",
              detail:
                "打开文件夹，说话，文件会改。你审。\n自己的模型 · 无账号 · 无 Credits",
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openWorkspace(sessionId = null) {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const root = res.filePaths[0];
  // lastWorkspace remains the picker/default memory; the actual Agent root belongs to a session.
  cfg.lastWorkspace = root;
  sessions?.setWorkspaceRoot?.(root, sessionId);
  saveConfig(cfg);
  mainWindow?.webContents.send("workspace:changed", { workspaceRoot: root, sessionId: sessionId || sessions?.getActive?.()?.id || null });
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

/**
 * 用户通过对话框/拖拽打开过的绝对路径（可能在工作区外）。
 * fs:read-file / fs:write-file 的白名单：只有工作区内路径或这些
 * 「用户明确打开过」的文件才允许读/写。
 */
const externallyOpenedFiles = new Set();

function registerExternalFiles(filePaths) {
  for (const p of Array.isArray(filePaths) ? filePaths : []) {
    if (typeof p === "string" && p) {
      try {
        externallyOpenedFiles.add(path.resolve(p));
      } catch { /* ignore */ }
    }
  }
}

/** 允许调用 IPC 的「本应用自己的页面」，URL 与文件路径两套比对。 */
const OWN_FILE_PATHS = [
  path.resolve(path.join(__dirname, "../../renderer/index.html")),
  path.resolve(path.join(__dirname, "../../renderer/ball.html")),
];
const OWN_PAGES = new Set(OWN_FILE_PATHS.map((p) => pathToFileURL(p).href.toLowerCase()));

/** 校验 IPC 来源：仅信任本应用自己的主 frame 页面（index.html / ball.html）。 */
function assertTrustedSender(event) {
  const frame = event?.senderFrame;
  if (!frame) {
    logger.warn("IPC 来源拒绝：未知来源");
    throw new Error("拒绝：未知 IPC 来源");
  }
  if (frame.parent !== null) {
    logger.warn("IPC 来源拒绝：子 frame", String(frame.url || ""));
    throw new Error("拒绝：子 frame 不可调用");
  }
  const rawUrl = String(frame.url || "");
  let url = rawUrl;
  const cut = url.search(/[?#]/);
  if (cut >= 0) url = url.slice(0, cut);
  if (OWN_PAGES.has(url.toLowerCase())) return true;
  // 兜底：URL 编码/大小写差异时，按文件路径再比对一次
  if (url.startsWith("file://")) {
    try {
      if (OWN_FILE_PATHS.includes(path.resolve(fileURLToPath(url)))) return true;
    } catch {
      /* ignore */
    }
  }
  logger.warn("IPC 来源拒绝：非本应用页面", url);
  throw new Error("拒绝：仅本地应用页面可调用");
}

/**
 * 给所有 IPC handler 统一加来源校验，杜绝个别模块漏加 assertTrustedSender。
 * 只包 ipcMain.handle（覆盖全部 invoke 通道）；ipcMain.on 的 fire-and-forget
 * 通道（agent:send）在 ipc/agent.js 内显式校验。
 */
function installIpcTrustGuard() {
  const nativeHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    const guarded = (event, ...args) => {
      assertTrustedSender(event);
      return listener(event, ...args);
    };
    return nativeHandle(channel, guarded);
  };
}

/** 路径白名单：工作区内 或 用户明确打开过的外部文件 */
function isAllowedFile(filePath) {
  const abs = path.resolve(String(filePath || ""));
  if (cfg?.lastWorkspace) {
    const ws = path.resolve(cfg.lastWorkspace);
    const rel = path.relative(ws, abs);
    const lexInside = !rel.startsWith("..") && !path.isAbsolute(rel);
    if (lexInside) {
      // 符号链接 / junction 逃逸防护：真实路径也必须落在工作区内
      const realWs = realpathOrBestEffort(ws);
      const realAbs = realpathOrBestEffort(abs);
      const realRel = path.relative(realWs, realAbs);
      if (!realRel.startsWith("..") && !path.isAbsolute(realRel)) return true;
      return false;
    }
  }
  return externallyOpenedFiles.has(abs);
}

/** 目录白名单：只能浏览当前工作区（读目录保持原逻辑） */
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

function registerIpc() {
  // 在任何 ipcMain.handle 注册前装上统一来源守卫（覆盖所有模块的 handler）
  installIpcTrustGuard();

  function publicSession(s) {
    if (!s) return null;
    const path = sessions.getActivePath(s);
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
      // active branch path for UI (linear view of current branch)
      messages: path,
      branchMeta,
      excludedBranches: sessions.getExcludedBranches?.(s) || [],
      // 本轮写盘摘要（无 before/after 正文）
      fileChanges: sessions.publicFileChanges(s),
    };
  }

  // ---- Credentials / safe metadata ----
  const broadcastPublicConfig = () => {
    const fresh = publicConfig(cfg);
    for (const win of BrowserWindow.getAllWindows()) {
      if (win && !win.isDestroyed()) win.webContents.send("config:changed", fresh);
    }
  };
  ipcMain.handle("credentials:list", (event) => {
    assertTrustedSender(event);
    return { ok: true, items: listCredentials(cfg) };
  });
  ipcMain.handle("credentials:set", (event, payload = {}) => {
    assertTrustedSender(event);
    const items = setCredential(cfg, payload);
    saveConfig(cfg); broadcastPublicConfig();
    return { ok: true, items };
  });
  ipcMain.handle("credentials:clear", (event, payload = {}) => {
    assertTrustedSender(event);
    const items = clearCredential(cfg, payload);
    saveConfig(cfg); broadcastPublicConfig();
    return { ok: true, items };
  });

  // ---- 一键导出审计日志 ----
  ipcMain.handle("logger:export", async (event) => {
    assertTrustedSender(event);
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
    if (!parts.length) {
      return { ok: false, error: "暂无日志内容" };
    }
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

  // ---- Providers ----
  ipcProviders.register(ipcMain, { cfg, publicConfig, assertTrustedSender });

  ipcMain.handle("workspace:open", (_e, { sessionId } = {}) => openWorkspace(sessionId));
  ipcMain.handle("workspace:get", (_e, { sessionId } = {}) =>
    (sessionId && sessions?.getById?.(sessionId)?.workspaceRoot) || sessions?.getActive?.()?.workspaceRoot || cfg.lastWorkspace || ""
  );

  // ---- MCP ----
  ipcMcp.register(ipcMain, { cfg, mcpManager, assertTrustedSender });

  /**
   * 工作区隔离的并行任务池：相同/父子目录串行，不重叠根目录最多 3 个并发。
   * Job 在提交时冻结 sessionId + workspaceRoot，不读取之后可能变化的 active session。
   */
  function emitChatQueueStatus(snapshot = {}) {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    win.webContents.send("agent:event", { type: "queue", ...snapshot });
  }
  const chatPool = new WorkspaceTaskPool({
    maxConcurrent: 3,
    onChange: (snapshot) => {
      // 运行中加大写盘防抖，所有并行任务空闲后恢复。
      sessions?.setDebounceMs?.(snapshot.running ? 2000 : 450);
      questStore?.setDebounceMs?.(snapshot.running ? 2000 : 450);
      emitChatQueueStatus(snapshot);
    },
  });
  const chatQueue = {
    get length() { return chatPool.length; },
    get isBusy() { return chatPool.isBusy; },
    enqueue(meta, run) { return chatPool.enqueue({ ...meta, run }).promise; },
    cancelSession(sessionId, reason) { chatPool.cancelSession(sessionId, reason); },
    clearQueue(reason) { chatPool.stopAll(reason); },
    snapshot() { return chatPool.snapshot(); },
    isSessionBusy(sessionId) { return chatPool.isSessionBusy(sessionId); },
    emitStatus(extra = {}) { emitChatQueueStatus({ ...chatPool.snapshot(), ...extra }); },
  };

  /** Shared context passed to every IPC domain module's register(). */
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
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    },
  };

  // ---- App state / lifecycle ----
  ipcApp.register(ipcMain, ctx);

  // ---- Config (get / provider-presets / update / export / import) ----
  ipcConfig.register(ipcMain, ctx);

  // ---- Filesystem ----
  ipcFs.register(ipcMain, ctx);

  // ---- Sessions (list / compress / branch-edit / switch-branch / etc) ----
  ipcSession.register(ipcMain, ctx);

  // ---- Agent (send / stop / queue / file-changes / confirm / inline-edit / complete / commit-message) ----
  ipcAgent.register(ipcMain, ctx);

  // ---- Native dialog ----
  ipcDialog.register(ipcMain, ctx);

  // ---- Git ----
  ipcGit.register(ipcMain, { cfg, dialog, getWindow: () => mainWindow });

  // ---- Terminal (real PTY) ----
  ipcTerminal.register(ipcMain, { cfg, terminals });

  // ---- Rules ----
  ipcRules.register(ipcMain, { cfg });

  // ---- Skills (zcode / agents SKILL.md) ----
  ipcSkills.register(ipcMain, { cfg });

  // ---- Long-term memory CRUD ----
  ipcMemory.register(ipcMain, { cfg, sessions, memoryStore });

  // ---- tsconfig / LSP project options + context stats ----
  ipcContext.register(ipcMain, { cfg });

  // ---- PTY bridge for agent ----
  ipcPty.register(ipcMain, { ptyBridge });

  // ---- Node debugger ----
  ipcDebugger.register(ipcMain, { cfg, nodeDebugger });

  // ---- Quest (goal-driven tasks) ----
  ipcQuest.register(ipcMain, {
    cfg,
    questStore,
    questRunner,
    getWindow: () => mainWindow,
    ptyBridge,
    askConfirm,
  });

  // ---- Dirty draft recovery ----
  ipcDrafts.register(ipcMain, {});
}

/** Resolve a pending agent confirm by id (agent:confirm-response). */
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

/** Release pending confirms globally, or only those owned by one session. */
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

/** Mark app as quitting and destroy the main window (app:allow-close). */
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
    pendingConfirms.set(id, { answer: onAnswer, sessionId: meta.sessionId || null, taskId: meta.taskId || null, workspaceRoot: meta.workspaceRoot || "" });
    mainWindow?.webContents.send("agent:confirm", { id, message, sessionId: meta.sessionId || null, taskId: meta.taskId || null, workspaceRoot: meta.workspaceRoot || "" });
    // safety timeout 5 min
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

const IMAGE_GEN_BACKENDS = new Set([
  "modelscope", "zhipu", "openai", "openrouter", "siliconflow",
  "volcengine", "qwen", "minimax",
]);
function normalizeImageGenBackend(value) {
  const backend = String(value || "").trim().toLowerCase();
  return IMAGE_GEN_BACKENDS.has(backend) ? backend : "modelscope";
}

/** Strip sensitive keys; renderer gets only presence flags for image/search credentials. */
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
    // Values remain main-process-only; renderer only learns configured names.
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
    // Key 脱敏：渲染层只需知道是否已配置，不回传明文
    pexelsApiKeySet: !!(c.pexelsApiKey && String(c.pexelsApiKey).trim()),
    unsplashApiKeySet: !!(c.unsplashApiKey && String(c.unsplashApiKey).trim()),
    imageGenBackend: normalizeImageGenBackend(c.imageGenBackend),
    imageGenModel: c.imageGenModel || "",
    imageGenBaseUrl: c.imageGenBaseUrl || "",
    imageGenApiKeySet: !!(c.imageGenApiKey && String(c.imageGenApiKey).trim()),
    providerName: getActiveProvider(c)?.name || "none",
  };
}

if (gotLock) {
  process.on("uncaughtException", (err) => {
    logger.error("uncaughtException", err);
  });
  process.on("unhandledRejection", (err) => {
    logger.error("unhandledRejection", err);
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = "dark";
    // Config only (sync, light) → paint window ASAP. Heavy stores after.
    cfg = loadConfig();
    logger.info("EMSoder 启动", {
      version: app.getVersion?.(),
      userData: app.getPath?.("userData"),
      logFile: logger.logPath(),
    });
    createWindow();

    sessions = new SessionStore();
    mcpManager = new McpManager({
      onEvent: (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("mcp:event", data);
        }
      },
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
    // 崩溃恢复：上次异常退出可能留下 running 状态的 quest，重启后复位为 error
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
    } catch { /* ignore */ }
    terminals = new TerminalManager();
    ptyBridge = new PtyBridge(terminals);
    nodeDebugger = new NodeDebugger();
    terminals.on("data", (payload) => {
      if (!mainWindow?.isDestroyed()) {
        mainWindow.webContents.send("term:data", payload);
      }
    });
    const forwardDebug = (channel) => (payload) => {
      if (!mainWindow?.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
      }
    };
    nodeDebugger.on("started", (p) =>
      forwardDebug("debug:event")({ type: "started", ...p })
    );
    nodeDebugger.on("paused", (p) =>
      forwardDebug("debug:event")({ type: "paused", ...p })
    );
    nodeDebugger.on("resumed", () =>
      forwardDebug("debug:event")({ type: "resumed" })
    );
    nodeDebugger.on("output", (p) =>
      forwardDebug("debug:event")({ type: "output", ...p })
    );
    nodeDebugger.on("exited", (p) =>
      forwardDebug("debug:event")({ type: "exited", ...p })
    );
    nodeDebugger.on("stopped", () =>
      forwardDebug("debug:event")({ type: "stopped" })
    );
    registerIpc();

    // 桌面悬浮球：按配置开关
    try { syncFloatingBall(); } catch { /* ignore */ }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("before-quit", () => {
    logger.info("EMSoder 退出");
    // 先停 Agent/Quest/调试器，再 flush 持久化，避免退出瞬间仍有写入造成竞态丢数据
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
  });

  app.on("window-all-closed", () => {
    terminals?.disposeAll();
    nodeDebugger?.stop?.();
    questRunner?.stopAll?.();
    mcpManager?.stopAll?.();
    if (process.platform !== "darwin") app.quit();
  });
}
