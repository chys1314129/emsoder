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
const os = require("os");
const fs = require("fs/promises");
const {
  loadConfig,
  saveConfig,
  getActiveModel,
  getActiveProvider,
  getEnabledProviders,
  getProviders,
} = require("../core/config");
const { SessionStore } = require("../agent/session");
const { AgentRunner } = require("../agent/runner");
const { MemoryStore } = require("../agent/memory");
const fsSync = require("fs");
const { testProvider, listRemoteModels, chatOnce } = require("../providers");
const { isHeavyDirName } = require("../tools/paths");
const { searchWorkspace } = require("../tools/search");
const { listCodeFiles } = require("../tools/codeIndex");
const { loadWorkspaceTsconfig } = require("../tools/tsconfig");
const git = require("../tools/git");
const { loadProjectRules } = require("../tools/rules");
const { TerminalManager } = require("./terminal");
const { PtyBridge } = require("./ptyBridge");
const { NodeDebugger } = require("./debugger");
const { QuestStore } = require("../agent/questStore");
const { QuestRunner } = require("../agent/questRunner");
const { McpManager } = require("../mcp/manager");
const { runAgentTurn } = require("./agentBridge");
const {
  tracker: contextStats,
  formatContextLabel,
  formatCacheLabel,
} = require("../core/contextStats");

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
let isQuitting = false;
/** latest inline-completion generation token (drop stale results) */
let completeGen = 0;
let completeAbort = null;

function draftsPath() {
  return path.join(app.getPath("userData"), "emsoder-drafts.json");
}

const isDev = process.argv.includes("--dev");

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
  // Fallback: if HTML/Monaco slow, still surface the shell so user knows it launched
  setTimeout(showMain, 1200);
  mainWindow.loadFile(path.join(__dirname, "../../renderer/index.html"));

  mainWindow.on("close", (e) => {
    const b = mainWindow.getBounds();
    cfg.windowBounds = b;
    saveConfig(cfg);
    if (isQuitting) return;
    // ask renderer if dirty tabs exist
    e.preventDefault();
    mainWindow.webContents.send("app:before-close");
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  buildMenu();
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
          label: "问题面板",
          accelerator: "CmdOrCtrl+Shift+M",
          click: () => mainWindow?.webContents.send("menu:show-problems"),
        },
        {
          label: "重新索引 TS/JS",
          click: () => mainWindow?.webContents.send("menu:reindex-lsp"),
        },
        {
          label: "调试面板",
          accelerator: "CmdOrCtrl+Shift+D",
          click: () => mainWindow?.webContents.send("menu:show-debug"),
        },
        {
          label: "Quest 任务板",
          accelerator: "CmdOrCtrl+Shift+Q",
          click: () => mainWindow?.webContents.send("menu:show-quest"),
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
                "Qoder 风格独立桌面壳 · 天蓝色皮肤 · 免费 · 可自定义第三方模型\n无账号 · 无 Credits",
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openWorkspace() {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  cfg.lastWorkspace = res.filePaths[0];
  saveConfig(cfg);
  mainWindow?.webContents.send("workspace:changed", cfg.lastWorkspace);
  return cfg.lastWorkspace;
}

async function openFileDialog() {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    defaultPath: cfg.lastWorkspace || undefined,
  });
  if (res.canceled) return [];
  return res.filePaths;
}

function registerIpc() {
  function publicSession(s) {
    if (!s) return null;
    const path = sessions.getActivePath(s);
    const branchMeta = sessions.getBranchMeta(s);
    return {
      id: s.id,
      title: s.title,
      mode: s.mode,
      activeLeafId: s.activeLeafId || null,
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      // active branch path for UI (linear view of current branch)
      messages: path,
      branchMeta,
      // 本轮写盘摘要（无 before/after 正文）
      fileChanges: sessions.publicFileChanges(s),
    };
  }
  ipcMain.handle("app:get-state", () => {
    const active = sessions?.getActive?.();
    return {
      config: publicConfig(cfg),
      session: active ? publicSession(active) : null,
      sessions: sessions
        ? sessions.list().map((s) => ({
            id: s.id,
            title: s.title,
            updatedAt: s.updatedAt,
          }))
        : [],
      workspace: cfg.lastWorkspace || "",
    };
  });

  ipcMain.handle("config:get", () => publicConfig(cfg));
  ipcMain.handle("config:provider-presets", () => require("../core/config").PROVIDER_PRESETS);

  ipcMain.handle("config:update", (_e, patch) => {
    cfg = { ...cfg, ...patch };
    // keep providers if provided
    if (patch.providers) cfg.providers = patch.providers;
    saveConfig(cfg);
    if (
      patch &&
      ("skillsEnabled" in patch ||
        "skillsIncludePlugins" in patch ||
        "skillsDirs" in patch ||
        "skillsDisabled" in patch)
    ) {
      try {
        require("../tools/skills").invalidateSkillCache();
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
    return publicConfig(cfg);
  });

  ipcMain.handle("providers:list", () => getProviders(cfg));
  ipcMain.handle("providers:enabled", () => getEnabledProviders(cfg));

  ipcMain.handle("providers:upsert", (_e, provider) => {
    const rawList = Array.isArray(cfg.providers) ? cfg.providers : [];
    const idx = rawList.findIndex((p) => p && p.id === provider.id);
    const normalized = {
      id: provider.id,
      name: provider.name || provider.id,
      type: provider.type === "anthropic" ? "anthropic" : "openai",
      baseUrl: String(provider.baseUrl || "").replace(/\/+$/, ""),
      apiKey: provider.apiKey || "",
      models: Array.isArray(provider.models) ? provider.models : [],
      enabled: provider.enabled !== false,
    };
    if (provider.headers) normalized.headers = provider.headers;
    if (provider.chatPath) normalized.chatPath = provider.chatPath;
    if (provider.timeoutMs != null) normalized.timeoutMs = provider.timeoutMs;
    if (idx >= 0) {
      // 合并 raw provider，避免丢失手动写入的 headers/chatPath/timeoutMs 等扩展字段
      rawList[idx] = { ...rawList[idx], ...normalized };
    } else {
      rawList.push(normalized);
    }
    cfg.providers = rawList;
    saveConfig(cfg);
    return publicConfig(cfg);
  });

  ipcMain.handle("providers:remove", (_e, id) => {
    cfg.providers = getProviders(cfg).filter((p) => p.id !== id);
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

  ipcMain.handle("workspace:open", () => openWorkspace());
  ipcMain.handle("workspace:get", () => cfg.lastWorkspace || "");

  // ── MCP ────────────────────────────────────────────────────────────
  function mcpServerList() {
    return Array.isArray(mcpManager?.list?.()) ? mcpManager.list() : [];
  }

  ipcMain.handle("mcp:list", () => ({ ok: true, servers: mcpServerList() }));

  ipcMain.handle("mcp:upsert", (_e, server = {}) => {
    const id = String(server.id || "").trim();
    const command = String(server.command || "").trim();
    const url = String(server.url || "").trim();
    if (!id || (!command && !url)) return { ok: false, error: "需要 id 以及命令或 URL" };
    const rawList = Array.isArray(cfg.mcpServers) ? cfg.mcpServers : [];
    const hasCmd = command !== "";
    const hasUrl = url !== "";
    const type =
      server.type === "http" || server.type === "stdio"
        ? server.type
        : hasUrl && !hasCmd
          ? "http"
          : hasCmd && !hasUrl
            ? "stdio"
            : "http";
    const timeoutMs = Number(server.timeoutMs);
    const normalized = {
      id,
      name: String(server.name || id).trim() || id,
      type,
      command: type === "stdio" ? command : "",
      args: Array.isArray(server.args)
        ? server.args.filter((a) => typeof a === "string")
        : [],
      cwd: String(server.cwd || ""),
      env:
        server.env && typeof server.env === "object" && !Array.isArray(server.env)
          ? server.env
          : {},
      url: type === "http" ? url : "",
      headers:
        server.headers && typeof server.headers === "object" && !Array.isArray(server.headers)
          ? server.headers
          : {},
      enabled: server.enabled !== false,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.min(300_000, Math.max(1_000, Math.round(timeoutMs)))
        : 30_000,
    };
    const idx = rawList.findIndex((p) => p && p.id === id);
    if (idx >= 0) rawList[idx] = normalized;
    else rawList.push(normalized);
    cfg.mcpServers = rawList;
    saveConfig(cfg);
    try {
      mcpManager?.reload(cfg);
    } catch { /* ignore */ }
    return { ok: true, servers: mcpServerList() };
  });

  ipcMain.handle("mcp:remove", (_e, id) => {
    cfg.mcpServers = (Array.isArray(cfg.mcpServers) ? cfg.mcpServers : []).filter(
      (p) => p && p.id !== id
    );
    saveConfig(cfg);
    try {
      mcpManager?.reload(cfg);
    } catch { /* ignore */ }
    return { ok: true, servers: mcpServerList() };
  });

  ipcMain.handle("mcp:connect", async (_e, id) => {
    try {
      await mcpManager?.connect(id);
      return { ok: true, servers: mcpServerList() };
    } catch (e) {
      return { ok: false, error: e.message || String(e), servers: mcpServerList() };
    }
  });

  ipcMain.handle("mcp:disconnect", (_e, id) => {
    try {
      mcpManager?.disconnect(id);
    } catch { /* ignore */ }
    return { ok: true, servers: mcpServerList() };
  });

  /** Walk workspace for @-mention autocomplete (lightweight: paths + dirs). */
  ipcMain.handle("fs:walk-files", async (_e, opts = {}) => {
    const root = cfg.lastWorkspace || "";
    if (!root) return { ok: false, files: [], error: "未打开工作区" };
    const max = Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : 600;
    const maxDepth = Number(opts.maxDepth) > 0 ? Number(opts.maxDepth) : 10;
    const files = [];
    const dirs = [];
    const walk = async (dir, depth) => {
      if (files.length + dirs.length >= max || depth > maxDepth) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch { return; }
      for (const e of entries) {
        if (files.length + dirs.length >= max) break;
        if (e.name.startsWith(".") && e.name !== ".github") continue;
        if (isHeavyDirName(e.name)) continue;
        const abs = path.join(dir, e.name);
        const rel = path.relative(root, abs).replace(/\\/g, "/");
        if (e.isDirectory()) {
          dirs.push({ path: rel, isDirectory: true });
          await walk(abs, depth + 1);
        } else {
          files.push({ path: rel, isDirectory: false, ext: path.extname(e.name).toLowerCase() });
        }
      }
    };
    await walk(root, 0);
    return { ok: true, files, dirs, root };
  });

  ipcMain.handle("fs:read-dir", async (_e, dirPath) => {
    const root = dirPath || cfg.lastWorkspace;
    if (!root) return [];
    if (cfg.lastWorkspace) {
      const abs = path.resolve(root);
      const ws = path.resolve(cfg.lastWorkspace);
      const rel = path.relative(ws, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error("目录越界：只能浏览当前工作区");
      }
    }
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => {
        if (e.name === ".gitignore" || e.name === ".env.example") return true;
        if (e.name.startsWith(".") && e.name !== ".github") return false;
        return true;
      })
      .map((e) => ({
        name: e.name,
        path: path.join(root, e.name),
        isDirectory: e.isDirectory(),
        heavy: e.isDirectory() && isHeavyDirName(e.name),
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  });

  ipcMain.handle("fs:read-file", async (_e, filePath) => {
    if (cfg.lastWorkspace) {
      const abs = path.resolve(filePath);
      const rel = path.relative(cfg.lastWorkspace, abs);
      // allow files under workspace OR explicitly opened absolute paths outside (user open dialog)
      // still block obvious path tricks when under workspace ops from tree
      if (rel.includes("\0")) throw new Error("非法路径");
    }
    const stat = await fs.stat(filePath);
    if (stat.size > 2 * 1024 * 1024) {
      throw new Error("文件过大（>2MB），请用外部编辑器打开");
    }
    const buf = await fs.readFile(filePath);
    if (buf.includes(0)) {
      throw new Error("二进制文件，无法作为文本打开");
    }
    const content = buf.toString("utf8");
    return { path: filePath, content, size: stat.size };
  });

  ipcMain.handle("fs:write-file", async (_e, { filePath, content }) => {
    if (cfg.lastWorkspace) {
      const abs = path.resolve(filePath);
      const rel = path.relative(cfg.lastWorkspace, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        // allow save if file was opened from outside via dialog — only block path traversal tokens
        if (String(filePath).includes("\0")) throw new Error("非法路径");
      }
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
    return { ok: true, path: filePath };
  });

  ipcMain.handle("fs:open-dialog", async () => {
    const files = await openFileDialog();
    if (files?.length) {
      mainWindow?.webContents.send("files:open", files);
    }
    return files;
  });

  /** Pick files as chat attachments (do NOT open in editor) */
  ipcMain.handle("fs:pick-attach", async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
      defaultPath: cfg.lastWorkspace || undefined,
      filters: [
        {
          name: "Code & text",
          extensions: [
            "js",
            "ts",
            "tsx",
            "jsx",
            "json",
            "md",
            "txt",
            "py",
            "go",
            "rs",
            "java",
            "c",
            "cpp",
            "h",
            "cs",
            "css",
            "html",
            "vue",
            "yml",
            "yaml",
            "toml",
            "xml",
            "sql",
            "sh",
            "bat",
            "ps1",
            "log",
          ],
        },
        {
          name: "Images (vision)",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"],
        },
        { name: "All", extensions: ["*"] },
      ],
    });
    if (res.canceled || !res.filePaths?.length) return [];
    const out = [];
    const imageMime = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
    };
    for (const filePath of res.filePaths.slice(0, 8)) {
      try {
        const stat = await fs.stat(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const isImage = !!imageMime[ext];
        let content = "";
        let kind = isImage ? "image" : "text";
        let dataUrl = "";
        let mime = "";
        if (isImage) {
          // vision: embed as base64 data URL (cap ~4MB file)
          if (stat.size > 4 * 1024 * 1024) {
            kind = "path";
            content = `(图片过大 ${(stat.size / 1024 / 1024).toFixed(1)}MB，未嵌入，仅路径)`;
          } else {
            const buf = await fs.readFile(filePath);
            mime = imageMime[ext] || "image/png";
            dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
            content = ""; // never dump base64 into chat text
          }
        } else if (stat.size > 256 * 1024) {
          content = `(文件过大 ${(stat.size / 1024).toFixed(0)}KB，仅附路径，未内嵌内容)`;
          kind = "path";
        } else {
          const buf = await fs.readFile(filePath);
          if (buf.includes(0)) {
            content = "(二进制文件，仅附路径)";
            kind = "path";
          } else {
            content = buf.toString("utf8");
          }
        }
        out.push({
          path: filePath,
          name: path.basename(filePath),
          size: stat.size,
          kind,
          content,
          dataUrl,
          mime,
        });
      } catch (e) {
        out.push({
          path: filePath,
          name: path.basename(filePath),
          size: 0,
          kind: "path",
          content: "",
          dataUrl: "",
          mime: "",
          error: e.message || String(e),
        });
      }
    }
    return out;
  });

  ipcMain.handle("fs:search", async (_e, opts) => {
    return searchWorkspace(cfg.lastWorkspace || "", opts || {});
  });

  ipcMain.handle("fs:list-code-files", async (_e, opts) => {
    return listCodeFiles(cfg.lastWorkspace || "", opts || {});
  });

  ipcMain.handle("app:allow-close", () => {
    isQuitting = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
    }
    return { ok: true };
  });


  function sessionListItems() {
    return sessions.list().map((s) => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      mode: s.mode || "agent",
      messageCount: sessions.visibleMessageCount(s),
    }));
  }

  ipcMain.handle("session:list", () => sessionListItems());
  ipcMain.handle("session:rename", (_e, { id, title } = {}) => {
    const s = sessions.rename(id, title);
    if (!s) return { ok: false, error: "会话不存在" };
    return {
      ok: true,
      session: publicSession(s),
      sessions: sessionListItems(),
    };
  });
  ipcMain.handle("session:remove", (_e, id) => {
    const r = sessions.remove(id);
    return {
      ...r,
      session: publicSession(sessions.getActive()),
      sessions: sessionListItems(),
    };
  });
  ipcMain.handle("session:remove-many", (_e, ids) => {
    const r = sessions.removeMany(ids);
    return {
      ...r,
      session: publicSession(sessions.getActive()),
      sessions: sessionListItems(),
    };
  });
  ipcMain.handle("session:get", () => publicSession(sessions.getActive()));
  ipcMain.handle("session:new", () => {
    const s = sessions.create(cfg.agentMode !== false ? "agent" : "ask");
    return publicSession(s);
  });
  ipcMain.handle("session:set-active", (_e, id) =>
    publicSession(sessions.setActive(id))
  );
  ipcMain.handle("session:clear", () => {
    sessions.clearActive();
    return publicSession(sessions.getActive());
  });

  /**
   * Chat Agent 串行任务队列（禁止并发抢跑）。
   * 旧行为：新 send 会 stop 当前轮；现改为排队，stop 中止当前并清空队列。
   */
  const chatJobQueue = [];
  let chatQueueBusy = false;

  function emitChatQueueStatus(extra = {}) {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    win.webContents.send("agent:event", {
      type: "queue",
      depth: chatJobQueue.length,
      running: !!(runner.isRunning || chatQueueBusy),
      ...extra,
    });
  }

  function enqueueChatJob(runFn) {
    return new Promise((resolve, reject) => {
      chatJobQueue.push({ runFn, resolve, reject });
      emitChatQueueStatus();
      pumpChatQueue();
    });
  }

  async function pumpChatQueue() {
    if (chatQueueBusy) return;
    chatQueueBusy = true;
    emitChatQueueStatus();
    // 运行中加大写盘防抖，减少主线程阻塞
    sessions?.setDebounceMs?.(2000);
    questStore?.setDebounceMs?.(2000);
    try {
      while (chatJobQueue.length) {
        const job = chatJobQueue.shift();
        emitChatQueueStatus();
        try {
          const result = await job.runFn();
          job.resolve(result);
        } catch (e) {
          job.reject(e);
        }
        emitChatQueueStatus();
      }
    } finally {
      sessions?.setDebounceMs?.(450);
      questStore?.setDebounceMs?.(400);
    }
    chatQueueBusy = false;
    emitChatQueueStatus();
  }

  /** 简易前后缀对齐行 diff（无第三方依赖） */
  function simpleLineDiff(before, after, maxLines = 500) {
    const a = String(before ?? "").split(/\r?\n/);
    const b = String(after ?? "").split(/\r?\n/);
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    }
    let ai = a.length;
    let bi = b.length;
    while (ai > i && bi > j && a[ai - 1] === b[bi - 1]) {
      ai--;
      bi--;
    }
    const out = [];
    out.push("--- before");
    out.push("+++ after");
    for (let k = 0; k < i && out.length < maxLines; k++) {
      out.push(" " + a[k]);
    }
    for (let k = i; k < ai && out.length < maxLines; k++) {
      out.push("-" + a[k]);
    }
    for (let k = j; k < bi && out.length < maxLines; k++) {
      out.push("+" + b[k]);
    }
    for (let k = ai; k < a.length && out.length < maxLines; k++) {
      out.push(" " + a[k]);
    }
    if (out.length >= maxLines) out.push("…(diff 已截断)");
    return out.join("\n");
  }

  /** Edit past user message → new branch, keep old answers, then run agent */
  ipcMain.handle("session:branch-edit", async (_event, payload) => {
    const messageId = payload?.messageId;
    const text = String(payload?.text || "").trim();
    if (!messageId || !text) throw new Error("缺少 messageId 或 text");

    return enqueueChatJob(async () => {
      const { userMsg } = sessions.branchFromUserEdit(messageId, text);
      return runAgentTurn({
        runner,
        cfg,
        text,
        payload,
        getWindow: () => mainWindow,
        sessions,
        publicSession,
        confirm: askConfirm,
        ptyBridge,
        memoryStore,
        skipUserAppend: true,
        preEvents: (send) => {
          send("agent:event", {
            type: "branch",
            session: publicSession(sessions.getActive()),
          });
          send("agent:event", { type: "user", text, messageId: userMsg.id });
          send("agent:event", { type: "assistant_start" });
        },
      });
    });
  });

  ipcMain.handle("session:switch-branch", (_e, payload) => {
    const messageId = payload?.messageId;
    const dir = payload?.direction || "next";
    if (!messageId) throw new Error("缺少 messageId");
    sessions.switchBranch(messageId, dir);
    return publicSession(sessions.getActive());
  });

  ipcMain.handle("agent:stop", () => {
    while (chatJobQueue.length) {
      const job = chatJobQueue.shift();
      try {
        job.reject(new Error("已停止并清空队列"));
      } catch {
        /* ignore */
      }
    }
    runner.stop();
    emitChatQueueStatus({ cleared: true });
    return { ok: true };
  });

  ipcMain.handle("agent:is-running", () => runner.isRunning || chatQueueBusy || chatJobQueue.length > 0);

  ipcMain.handle("agent:queue-status", () => ({
    ok: true,
    depth: chatJobQueue.length,
    running: !!(runner.isRunning || chatQueueBusy),
  }));

  function targetSession(sessionId) {
    return sessions.getById?.(sessionId) || sessions.getActive();
  }

  /** Chat 本轮文件变更摘要（不含正文） */
  ipcMain.handle("agent:file-changes", (_e, { sessionId } = {}) => ({
    ok: true,
    fileChanges: sessions.publicFileChanges(sessionId),
  }));

  /** 单文件写前/写后 + 简易 diff（按需拉取，避免列表 IPC 爆炸） */
  ipcMain.handle("agent:file-change-diff", (_e, { path: filePath, sessionId } = {}) => {
    const body = sessions.getFileChangeBodies(filePath, 120_000, sessionId);
    if (!body) return { ok: false, error: "未找到该文件的本轮快照" };
    return {
      ok: true,
      ...body,
      diff: simpleLineDiff(body.before, body.after),
    };
  });

  /** 回滚单个文件到本轮写前 */
  ipcMain.handle("agent:reject-change", async (_e, { path: filePath, sessionId } = {}) => {
    const r = await runner.applyReject(filePath, sessionId);
    return {
      ...r,
      fileChanges: sessions.publicFileChanges(sessionId),
      session: publicSession(targetSession(sessionId)),
    };
  });

  /** 一键回滚本轮全部未撤销变更 */
  ipcMain.handle("agent:reject-all-changes", async (_e, { sessionId } = {}) => {
    const r = await runner.applyRejectAll(sessionId);
    return {
      ...r,
      fileChanges: sessions.publicFileChanges(sessionId),
      session: publicSession(targetSession(sessionId)),
    };
  });

  /** 确认本轮改动并清空摘要（不回滚） */
  ipcMain.handle("agent:accept-all-changes", (_e, { sessionId } = {}) => {
    sessions.clearFileChanges(sessionId);
    return {
      ok: true,
      fileChanges: sessions.publicFileChanges(sessionId),
      session: publicSession(targetSession(sessionId)),
    };
  });

  ipcMain.on("agent:send", (_event, payload) => {
    const text = String(payload?.text || "").trim();
    if (!text) return;
    enqueueChatJob(() =>
      runAgentTurn({
        runner,
        cfg,
        text,
        payload,
        getWindow: () => mainWindow,
        sessions,
        publicSession,
        confirm: askConfirm,
        ptyBridge,
        memoryStore,
      })
    ).catch(() => {
      /* errors already pushed via agent events */
    });
  });

  ipcMain.handle("agent:confirm-response", (_e, { id, allow }) => {
    const fn = pendingConfirms.get(id);
    if (fn) {
      pendingConfirms.delete(id);
      fn(!!allow);
    }
    return { ok: true };
  });

  ipcMain.handle("agent:inline-edit", async (_e, { instruction, code, language, file }) => {
    const result = await chatOnce(cfg, {
      messages: [
        {
          role: "system",
          content:
            "You are a code editor. Return ONLY the full replacement code. No markdown fences, no explanation.",
        },
        {
          role: "user",
          content: [
            file ? `File: ${file}` : "",
            language ? `Language: ${language}` : "",
            `Instruction: ${instruction}`,
            "Code:",
            String(code || "").slice(0, 20000),
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      maxTokens: 8192,
      temperature: 0.1,
    });
    let next = String(result || "").trim();
    if (next.startsWith("```")) {
      next = next.replace(/^```[\w-]*\n?/, "").replace(/```$/, "").trim();
    }
    return { code: next };
  });

  ipcMain.handle("agent:complete", async (_e, payload) => {
    if (cfg.completionEnabled === false) {
      return { text: "" };
    }
    const prefix = String(payload?.prefix || "").slice(-4000);
    const suffix = String(payload?.suffix || "").slice(0, 1500);
    const language = payload?.language || "";
    if (prefix.trim().length < 8) return { text: "" };

    // cancel previous in-flight completion (race: keep only latest)
    completeGen += 1;
    const myGen = completeGen;
    try {
      completeAbort?.abort();
    } catch {
      /* ignore */
    }
    completeAbort = new AbortController();
    const signal = completeAbort.signal;

    try {
      const result = await chatOnce(cfg, {
        messages: [
          {
            role: "system",
            content:
              "You are a code completion engine. Return ONLY the code to insert at the cursor. No markdown fences, no explanation. Prefer short completions (1-12 lines).",
          },
          {
            role: "user",
            content: [
              language ? `Language: ${language}` : "",
              "Prefix:",
              prefix,
              "Suffix:",
              suffix,
              "Completion:",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        maxTokens: 256,
        temperature: 0.1,
        signal,
        timeoutMs: 20_000,
      });
      if (myGen !== completeGen || signal.aborted) {
        return { text: "", stale: true };
      }
      let text = String(result || "").trim();
      if (text.startsWith("```")) {
        text = text.replace(/^```[\w-]*\n?/, "").replace(/```$/, "").trim();
      }
      return { text: text.split(/\r?\n/).slice(0, 12).join("\n") };
    } catch (err) {
      if (err?.name === "AbortError" || myGen !== completeGen) {
        return { text: "", stale: true };
      }
      return { text: "", error: err.message || String(err) };
    }
  });

  ipcMain.handle("agent:commit-message", async () => {
    const root = cfg.lastWorkspace;
    if (!root) throw new Error("未打开工作区");
    const status = await git.getStatus(root);
    if (!status.ok) throw new Error(status.error || "git status failed");
    if (!status.files.length) return { message: "", empty: true };
    const diff = await git.getDiff(root, { staged: false });
    const stagedDiff = await git.getDiff(root, { staged: true });
    const body = [
      `branch: ${status.branch}`,
      "files:",
      ...status.files.map((f) => `${f.status} ${f.path}`),
      "",
      "staged diff:",
      (stagedDiff.diff || "").slice(0, 12000),
      "",
      "unstaged diff:",
      (diff.diff || "").slice(0, 12000),
    ].join("\n");
    const message = await chatOnce(cfg, {
      messages: [
        {
          role: "system",
          content:
            "Generate a concise conventional commit message (type(scope): subject). Output only the message line(s), no quotes, no explanation.",
        },
        { role: "user", content: body.slice(0, 24000) },
      ],
      maxTokens: 200,
      temperature: 0.2,
    });
    return {
      message: String(message || "")
        .trim()
        .replace(/^["']|["']$/g, ""),
    };
  });

  // ---- Git ----
  ipcMain.handle("git:status", async () => git.getStatus(cfg.lastWorkspace || ""));
  ipcMain.handle("git:diff", async (_e, opts) =>
    git.getDiff(cfg.lastWorkspace || "", opts || {})
  );
  ipcMain.handle("git:stage", async (_e, filePath) =>
    git.stage(cfg.lastWorkspace || "", filePath)
  );
  ipcMain.handle("git:unstage", async (_e, filePath) =>
    git.unstage(cfg.lastWorkspace || "", filePath)
  );
  ipcMain.handle("git:discard", async (_e, filePath) => {
    const r = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: ["取消", "丢弃更改"],
      defaultId: 0,
      cancelId: 0,
      message: `丢弃对 ${filePath} 的未提交修改？`,
      detail: "此操作不可撤销。",
    });
    if (r.response !== 1) return { ok: false, cancelled: true };
    return git.discard(cfg.lastWorkspace || "", filePath);
  });
  ipcMain.handle("git:commit", async (_e, message) =>
    git.commit(cfg.lastWorkspace || "", message)
  );
  ipcMain.handle("git:log", async (_e, limit) =>
    git.getLog(cfg.lastWorkspace || "", limit || 20)
  );

  // ---- Terminal (real PTY) ----
  ipcMain.handle("term:create", (_e, size) =>
    terminals.create(cfg.lastWorkspace || process.cwd(), size || {})
  );
  ipcMain.handle("term:list", () => terminals.list());
  ipcMain.handle("term:write", (_e, { id, data }) => terminals.write(id, data));
  ipcMain.handle("term:resize", (_e, { id, cols, rows }) =>
    terminals.resize(id, cols, rows)
  );
  ipcMain.handle("term:interrupt", (_e, id) => terminals.interrupt(id));
  ipcMain.handle("term:kill", (_e, id) => terminals.kill(id));
  ipcMain.handle("term:dispose", (_e, id) => terminals.dispose(id));
  // legacy line-run kept as helper: write command + Enter
  ipcMain.handle("term:run", async (_e, { id, command }) => {
    const cmd = String(command || "");
    if (!cmd) return { ok: true };
    return terminals.write(id, cmd.endsWith("\r") || cmd.endsWith("\n") ? cmd : cmd + "\r");
  });
  ipcMain.handle("term:available", () => {
    const diag =
      typeof terminals?.diagnostics === "object"
        ? terminals.diagnostics
        : null;
    return {
      ok: terminals?.available !== false,
      available: !!terminals?.available,
      diagnostics: diag,
    };
  });

  // ---- Rules ----
  ipcMain.handle("rules:list", async () => {
    const r = await loadProjectRules(cfg.lastWorkspace || "");
    return r;
  });

  // ---- Skills (zcode / agents SKILL.md) ----
  ipcMain.handle("skills:list", async () => {
    const {
      loadSkillCatalog,
    } = require("../tools/skills");
    let SKILL_CN = {};
    let extractTriggers = () => [];
    try {
      ({ SKILL_CN, extractTriggers } = require("../tools/skillInfo"));
    } catch {
      /* optional enrichment for sidebar search */
    }
    try {
      const catalog = await loadSkillCatalog(cfg, cfg.lastWorkspace || "");
      let runtime = null;
      try {
        runtime = require("../tools/skillRuntime").listBundledTools();
      } catch {
        runtime = null;
      }
      return {
        ok: true,
        enabled: catalog.enabled !== false,
        roots: catalog.roots || [],
        skills: (catalog.skills || []).map((s) => {
          const key = String(s.name || s.id || "").toLowerCase();
          const cn = SKILL_CN[key] || SKILL_CN[s.name] || SKILL_CN[s.id];
          const cnDescription = cn?.desc || "";
          const triggers =
            (cn?.triggers && cn.triggers.length
              ? cn.triggers
              : extractTriggers(s.description || "")) || [];
          return {
            id: s.id,
            name: s.name,
            description: s.description,
            cnDescription,
            triggers,
            source: s.source,
            dir: s.dir,
            disabled: !!s.disabled,
          };
        }),
        runtime,
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e), skills: [], roots: [] };
    }
  });
  function applySkillsDisabledKeys(keys, disabled) {
    const list = Array.isArray(cfg.skillsDisabled)
      ? [...cfg.skillsDisabled]
      : [];
    const drop = new Set(
      (Array.isArray(keys) ? keys : [])
        .map((x) => String(x || "").trim().toLowerCase())
        .filter(Boolean)
    );
    if (!drop.size) return { ok: false, error: "missing ids", changed: 0 };
    let next = list.filter((x) => !drop.has(String(x).toLowerCase()));
    if (disabled) {
      for (const raw of keys) {
        const key = String(raw || "").trim();
        if (!key) continue;
        const lower = key.toLowerCase();
        if (!next.some((x) => String(x).toLowerCase() === lower)) next.push(key);
      }
    }
    cfg.skillsDisabled = next;
    saveConfig(cfg);
    try {
      require("../tools/skills").invalidateSkillCache();
    } catch {
      /* ignore */
    }
    return {
      ok: true,
      changed: drop.size,
      skillsDisabled: cfg.skillsDisabled,
    };
  }

  ipcMain.handle("skills:set-disabled", (_e, { id, disabled }) => {
    const key = String(id || "").trim();
    if (!key) return { ok: false, error: "missing id" };
    return applySkillsDisabledKeys([key], disabled);
  });

  // 批量禁用/启用（技能侧栏：对当前筛选结果一键操作）
  ipcMain.handle("skills:set-disabled-batch", (_e, { ids, disabled }) => {
    const keys = Array.isArray(ids) ? ids : [];
    return applySkillsDisabledKeys(keys, disabled);
  });

  ipcMain.handle("skills:read", async (_e, { id }) => {
    const key = String(id || "").trim();
    if (!key) return { ok: false, error: "missing id" };
    try {
      const { loadSkillCatalog, loadSkillContent } = require("../tools/skills");
      const catalog = await loadSkillCatalog(cfg, cfg.lastWorkspace || "");
      const result = await loadSkillContent(catalog, key, "", {
        allowDisabled: true,
      });
      if (!result.ok) return result;
      const skill = result.skill || {};
      const skillId = String(skill.id || skill.name || key).toLowerCase();
      let cnDesc = "";
      let cnTriggers = [];
      let autoTriggers = [];
      try {
        const { SKILL_CN, extractTriggers } = require("../tools/skillInfo");
        const cn = SKILL_CN[skillId] || SKILL_CN[skill.name] || {};
        cnDesc = cn.desc || "";
        cnTriggers = cn.triggers || [];
        autoTriggers = extractTriggers(skill.description || "");
      } catch { /* ignore */ }
      return {
        ok: true,
        name: skill.name || key,
        description: skill.description || "",
        source: skill.source || "",
        dir: skill.dir || "",
        content: result.content || "",
        cnDescription: cnDesc,
        triggers: [...new Set([...cnTriggers, ...autoTriggers])].slice(0, 15),
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("skills:uninstall", async (_e, { id }) => {
    const key = String(id || "").trim();
    if (!key) return { ok: false, error: "missing id" };
    try {
      const { loadSkillCatalog, findSkill } = require("../tools/skills");
      const catalog = await loadSkillCatalog(cfg, cfg.lastWorkspace || "");
      const skill = findSkill(catalog, key);
      if (!skill) return { ok: false, error: "skill not found" };
      // only allow uninstalling user-installed skills (zcode/agents/workspace)
      if (
        skill.source === "bundled" ||
        skill.source === "plugin" ||
        skill.source === "core"
      ) {
        return { ok: false, error: "预装/捆绑/插件技能不可卸载，仅可禁用" };
      }
      const dir = skill.dir;
      if (!dir) return { ok: false, error: "skill dir missing" };
      // safety: must be under a known skills directory
      const allowedRoots = [
        path.join(os.homedir(), ".zcode", "skills"),
        path.join(os.homedir(), ".agents", "skills"),
        cfg.lastWorkspace ? path.join(cfg.lastWorkspace, ".emsoder", "skills") : null,
      ].filter(Boolean).map((r) => path.resolve(r).toLowerCase());
      const absDir = path.resolve(dir).toLowerCase();
      const inAllowed = allowedRoots.some((r) => absDir.startsWith(r + path.sep) || absDir === r);
      if (!inAllowed) {
        return { ok: false, error: "技能目录不在可卸载范围内" };
      }
      await fs.rm(dir, { recursive: true, force: true });
      // also remove from disabled list
      const list = (cfg.skillsDisabled || []).filter(
        (x) => String(x).toLowerCase() !== key.toLowerCase()
      );
      cfg.skillsDisabled = list;
      saveConfig(cfg);
      try { require("../tools/skills").invalidateSkillCache(); } catch {}
      // also remove symlink if exists (zcode → agents)
      try {
        const zcodeLink = path.join(os.homedir(), ".zcode", "skills", skill.name);
        const st = await fs.lstat(zcodeLink).catch(() => null);
        if (st?.isSymbolicLink()) await fs.unlink(zcodeLink);
      } catch {}
      return { ok: true, message: `已卸载 ${skill.name}` };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  // ---- Skills install wizard (npx skills add wrapper) ----
  ipcMain.handle("skills:install-presets", () => {
    try {
      const { PRESETS } = require("../tools/skillInstall");
      return { ok: true, presets: PRESETS };
    } catch (e) {
      return { ok: false, error: e.message || String(e), presets: [] };
    }
  });

  ipcMain.handle("skills:install", async (event, payload) => {
    const skillInstall = require("../tools/skillInstall");
    const sendLog = (line) => {
      try {
        event.sender.send("skills:install-log", { line: String(line || "") });
      } catch {
        /* window gone */
      }
    };
    try {
      const result = await skillInstall.runSkillsAdd({
        repo: payload?.repo,
        skill: payload?.skill,
        global: payload?.global !== false,
        onLog: sendLog,
      });
      try {
        require("../tools/skills").invalidateSkillCache();
      } catch {
        /* ignore */
      }
      return result;
    } catch (e) {
      return {
        ok: false,
        code: null,
        error: e.message || String(e),
        stdout: "",
        stderr: "",
        cmd: "",
      };
    }
  });

  ipcMain.handle("skills:install-cancel", () => {
    try {
      return require("../tools/skillInstall").cancelSkillsInstall();
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("skills:install-status", () => {
    try {
      const { isInstallRunning } = require("../tools/skillInstall");
      return { ok: true, running: isInstallRunning() };
    } catch (e) {
      return { ok: false, running: false, error: e.message || String(e) };
    }
  });

  // ---- Long-term memory CRUD ----
  ipcMain.handle("memory:list", (_e, opts) => {
    try { return { ok: true, memories: memoryStore?.list(opts || {}) || [] }; }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
  ipcMain.handle("memory:add", (_e, mem) => {
    try { return { ok: true, memory: memoryStore.add(mem) }; }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
  ipcMain.handle("memory:update", (_e, { id, patch }) => {
    try { const m = memoryStore.update(id, patch); return m ? { ok: true, memory: m } : { ok: false, error: "not found" }; }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
  ipcMain.handle("memory:remove", (_e, { id }) => {
    try { return { ok: memoryStore.remove(id) }; }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
  ipcMain.handle("memory:search", (_e, { query, topK }) => {
    try { return { ok: true, memories: memoryStore.search(query, { topK }) }; }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
  ipcMain.handle("memory:extract-now", async (_e) => {
    try {
      const added = await memoryStore.extractFromSession(sessions.getActive(), cfg);
      return { ok: true, added };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
  ipcMain.handle("memory:clear", () => {
    try { memoryStore.clear(); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
  });

  // ---- tsconfig / LSP project options ----
  ipcMain.handle("lsp:tsconfig", async () => {
    return loadWorkspaceTsconfig(cfg.lastWorkspace || "");
  });

  // ---- PTY bridge for agent ----
  ipcMain.handle("pty:set-preferred", (_e, id) => ptyBridge.setPreferred(id));
  ipcMain.handle("pty:get-preferred", () => ({
    id: ptyBridge.getPreferred(),
  }));
  ipcMain.handle("pty:mirror", (_e, text) => ptyBridge.write(text));

  // ---- Node debugger ----
  ipcMain.handle("debug:state", () => nodeDebugger.state);
  ipcMain.handle("debug:launch", async (_e, opts) => {
    try {
      return await nodeDebugger.launch({
        program: opts?.program,
        args: opts?.args || [],
        cwd: opts?.cwd || cfg.lastWorkspace || process.cwd(),
      });
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle("debug:stop", async () => nodeDebugger.stop());
  ipcMain.handle("debug:continue", async () => {
    try {
      return await nodeDebugger.continue();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("debug:pause", async () => {
    try {
      return await nodeDebugger.pause();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("debug:step-over", async () => {
    try {
      return await nodeDebugger.stepOver();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("debug:step-into", async () => {
    try {
      return await nodeDebugger.stepInto();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("debug:step-out", async () => {
    try {
      return await nodeDebugger.stepOut();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("debug:evaluate", async (_e, { expression, callFrameId }) => {
    try {
      return await nodeDebugger.evaluate(expression, callFrameId);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("debug:set-breakpoint", (_e, { path: filePath, line }) =>
    nodeDebugger.setBreakpoint(filePath, line)
  );
  ipcMain.handle("debug:remove-breakpoint", (_e, { path: filePath, line }) =>
    nodeDebugger.removeBreakpoint(filePath, line)
  );
  ipcMain.handle("debug:clear-breakpoints", () => nodeDebugger.clearBreakpoints());
  ipcMain.handle("debug:list-breakpoints", () => ({
    breakpoints: nodeDebugger.listBreakpoints(),
  }));

  // ---- Quest (goal-driven tasks) ----
  /** quest 对象瘦身：fileChanges 去 before/after 正文（对齐 Chat 模式） */
  function publicQuest(q) {
    if (!q) return null;
    return { ...q, fileChanges: questStore.publicFileChanges(q) };
  }

  /**
   * quest 事件发送器：delta 流式文本 80ms 批处理合并，
   * 其他事件（status/step/done 等）立即发送。
   */
  const questDeltaBatch = new Map(); // questId -> { buf, timer }
  function makeQuestEventSender(questId) {
    return (ev) => {
      if (mainWindow?.isDestroyed()) return;
      if (ev?.type !== "delta") {
        flushQuestDelta(questId);
        mainWindow.webContents.send("quest:event", ev);
        return;
      }
      let b = questDeltaBatch.get(questId);
      if (!b) {
        b = { buf: "", timer: null };
        questDeltaBatch.set(questId, b);
      }
      b.buf += ev.text || "";
      if (b.buf.length >= 4096) {
        flushQuestDelta(questId);
        return;
      }
      if (!b.timer) {
        b.timer = setTimeout(() => flushQuestDelta(questId), 80);
      }
    };
  }
  function flushQuestDelta(questId) {
    const b = questDeltaBatch.get(questId);
    if (!b) return;
    questDeltaBatch.delete(questId);
    if (b.timer) clearTimeout(b.timer);
    if (b.buf && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("quest:event", {
        type: "delta",
        questId,
        text: b.buf,
      });
    }
  }

  ipcMain.handle("quest:list", () => questStore.list().map((q) => ({
    id: q.id,
    title: q.title,
    goal: q.goal,
    mode: q.mode,
    status: q.status,
    remark: q.remark || "",
    workspace: q.workspace,
    model: q.model,
    progress: q.progress,
    error: q.error,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
    startedAt: q.startedAt,
    finishedAt: q.finishedAt,
    stepCount: (q.steps || []).length,
    changeCount: (q.fileChanges || []).filter((f) => !f.rejected).length,
  })));
  ipcMain.handle("quest:board", () => questStore.listByStatus());
  ipcMain.handle("quest:get", (_e, id) => publicQuest(questStore.get(id)));
  ipcMain.handle("quest:get-active", () => publicQuest(questStore.getActive()));
  ipcMain.handle("quest:set-active", (_e, id) => questStore.setActive(id));
  ipcMain.handle("quest:create", (_e, payload) => {
    return questStore.create({
      goal: payload?.goal || "",
      title: payload?.title,
      mode: payload?.mode || "agent",
      workspace: payload?.workspace || cfg.lastWorkspace || "",
      model: payload?.model || getActiveModel(cfg),
      providerId: payload?.providerId || cfg.activeProviderId,
    });
  });
  ipcMain.handle("quest:update", (_e, { id, patch }) =>
    publicQuest(questStore.update(id, patch || {}))
  );
  ipcMain.handle("quest:remove", (_e, id) => {
    if (questRunner.isRunning(id)) questRunner.stop(id);
    return questStore.remove(id);
  });
  ipcMain.handle("quest:start", async (_e, id) => {
    const qid = id || questStore.activeId;
    if (!qid) throw new Error("无活动 Quest");
    // fire and forget — progress via events
    setImmediate(() => {
      questStore?.setDebounceMs?.(2000);
      const restoreDebounce = () => {
        try { questStore?.setDebounceMs?.(400); } catch { /* ignore */ }
      };
      questRunner
        .start(
          cfg,
          qid,
          {
            onEvent: (ev) => {
              if (ev?.type === "done" || ev?.type === "error") restoreDebounce();
              makeQuestEventSender(qid)(ev);
            },
          },
          {
            ptyBridge,
            confirm: (message) => askConfirm(message),
          }
        )
        .catch((err) => {
          restoreDebounce();
          if (!mainWindow?.isDestroyed()) {
            mainWindow.webContents.send("quest:event", {
              type: "error",
              questId: qid,
              error: err.message || String(err),
            });
          }
        });
    });
    return { ok: true, id: qid };
  });
  ipcMain.handle("quest:stop", (_e, id) => {
    questRunner.stop(id || questStore.activeId);
    return { ok: true };
  });
  ipcMain.handle("quest:reject-change", async (_e, { id, path: filePath }) => {
    return questRunner.applyReject(id, filePath);
  });
  ipcMain.handle("quest:complete", (_e, id) =>
    questRunner.markCompleted(id || questStore.activeId)
  );
  ipcMain.handle("quest:is-running", (_e, id) =>
    questRunner.isRunning(id || questStore.activeId)
  );

  ipcMain.handle("dialog:message", async (_e, opts) => {
    const r = await dialog.showMessageBox(mainWindow, opts);
    return r;
  });

  ipcMain.handle("context:stats", () => {
    const snap = contextStats.getSnapshot();
    return {
      ...snap,
      labelContext: formatContextLabel(snap),
      labelCache: formatCacheLabel(snap),
    };
  });

  // ---- Config export / import (BYOK backup) ----
  ipcMain.handle("config:export", async (_e, { redactKeys } = {}) => {
    const redact = redactKeys !== false;
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      activeProviderId: cfg.activeProviderId,
      activeModel: cfg.activeModel,
      agentMode: cfg.agentMode,
      autoRunTools: cfg.autoRunTools,
      autoApproveSafe: !!cfg.autoApproveSafe,
      collapseProcess: cfg.collapseProcess !== false,
      terminalRunMode: cfg.terminalRunMode,
      commandDenyList: cfg.commandDenyList,
      maxTokens: cfg.maxTokens,
      temperature: cfg.temperature,
      agentMaxRounds: cfg.agentMaxRounds ?? 32,
      agentAutoContinue: cfg.agentAutoContinue ?? 2,
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
      providers: getProviders(cfg).map((p) => ({
        ...p,
        apiKey: redact
          ? p.apiKey
            ? `***${String(p.apiKey).slice(-4)}`
            : ""
          : p.apiKey,
      })),
    };
    const res = await dialog.showSaveDialog(mainWindow, {
      title: "导出 EMSoder 配置",
      defaultPath: "emsoder-config-export.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    await fs.writeFile(res.filePath, JSON.stringify(payload, null, 2), "utf8");
    return { ok: true, path: res.filePath, redacted: redact };
  });

  ipcMain.handle("config:import", async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
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
      "agentMode",
      "autoRunTools",
      "autoApproveSafe",
      "collapseProcess",
      "terminalRunMode",
      "commandDenyList",
      "maxTokens",
      "temperature",
      "agentMaxRounds",
      "agentAutoContinue",
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
      if (data[k] !== undefined) cfg[k] = data[k];
    }
    if (Array.isArray(data.providers) && data.providers.length) {
      const existing = getProviders(cfg);
      const byId = new Map(existing.map((p) => [p.id, p]));
      const next = data.providers.map((p) => {
        const prev = byId.get(p.id);
        let apiKey = p.apiKey || "";
        // keep old key if import looks redacted
        if (
          prev &&
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
        };
      });
      cfg.providers = next;
    }
    saveConfig(cfg);
    return { ok: true, config: publicConfig(cfg) };
  });

  // ---- Dirty draft recovery ----
  ipcMain.handle("drafts:save", (_e, drafts) => {
    try {
      const p = draftsPath();
      fsSync.mkdirSync(path.dirname(p), { recursive: true });
      const list = Array.isArray(drafts) ? drafts.slice(0, 30) : [];
      const tmp = p + ".tmp";
      fsSync.writeFileSync(
        tmp,
        JSON.stringify({ savedAt: Date.now(), drafts: list }, null, 2),
        "utf8"
      );
      fsSync.renameSync(tmp, p);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("drafts:load", () => {
    try {
      const p = draftsPath();
      if (!fsSync.existsSync(p)) return { drafts: [] };
      const data = JSON.parse(fsSync.readFileSync(p, "utf8"));
      return { drafts: Array.isArray(data.drafts) ? data.drafts : [], savedAt: data.savedAt };
    } catch {
      return { drafts: [] };
    }
  });

  ipcMain.handle("drafts:clear", () => {
    try {
      const p = draftsPath();
      if (fsSync.existsSync(p)) fsSync.unlinkSync(p);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

function askConfirm(message) {
  return new Promise((resolve) => {
    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    pendingConfirms.set(id, resolve);
    mainWindow?.webContents.send("agent:confirm", { id, message });
    // safety timeout 5 min
    setTimeout(() => {
      if (pendingConfirms.has(id)) {
        pendingConfirms.delete(id);
        resolve(false);
      }
    }, 5 * 60 * 1000);
  });
}

/** strip nothing critical — keys stay local; UI needs them for editing */
function publicConfig(c) {
  return {
    activeProviderId: c.activeProviderId,
    activeModel: getActiveModel(c),
    providers: getProviders(c),
    agentMode: c.agentMode !== false,
    autoRunTools: !!c.autoRunTools,
    autoApproveSafe: !!c.autoApproveSafe,
    collapseProcess: c.collapseProcess !== false,
    terminalRunMode: c.terminalRunMode || "askEveryTime",
    commandDenyList: c.commandDenyList || "",
    maxTokens: c.maxTokens ?? 8192,
    temperature: c.temperature ?? 0.2,
    agentMaxRounds: c.agentMaxRounds ?? 32,
    agentAutoContinue:
      c.agentAutoContinue === false || c.agentAutoContinue === 0
        ? 0
        : c.agentAutoContinue ?? 2,
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
    mcpServers: Array.isArray(c.mcpServers) ? c.mcpServers : [],
    wordWrap: c.wordWrap || "off",
    minimap: !!c.minimap,
    contextWindow: c.contextWindow || 0,
    modelContextWindows: c.modelContextWindows || {},
    providerName: getActiveProvider(c)?.name || "none",
  };
}

if (gotLock) {
  process.on("uncaughtException", (err) => {
    console.error("uncaughtException", err);
  });
  process.on("unhandledRejection", (err) => {
    console.error("unhandledRejection", err);
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = "dark";
    // Config only (sync, light) → paint window ASAP. Heavy stores after.
    cfg = loadConfig();
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

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("before-quit", () => {
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
    try {
      runner?.stop?.();
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
  });

  app.on("window-all-closed", () => {
    terminals?.disposeAll();
    nodeDebugger?.stop?.();
    questRunner?.stopAll?.();
    mcpManager?.stopAll?.();
    if (process.platform !== "darwin") app.quit();
  });
}
