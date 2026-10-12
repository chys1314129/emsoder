"use strict";
/**
 * The `electron` module, reimplemented on top of the Tauri shell.
 *
 * `src/**` was written against Electron's main-process API. Rather than fork
 * ~15 files, `electron-shim.js` redirects `require("electron")` to this module,
 * so the existing code runs unchanged: `app.getPath("userData")` returns the
 * same directory as before, `dialog.showOpenDialog` returns `{ canceled,
 * filePaths }`, `BrowserWindow.getAllWindows()` enumerates the real windows, and
 * `webContents.send` lands in the webview.
 *
 * Two deliberate behaviours:
 *
 * 1. `app.getPath("userData")` is Electron's `%APPDATA%\EMSoder`, *not* Tauri's
 *    app-data dir. That is what lets an existing install keep its config,
 *    sessions, memories, quests and API keys.
 *
 * 2. `safeStorage` is backed by the shell's DPAPI helper mode
 *    (`emsoder.exe --dpapi-seal|--dpapi-unseal`), byte-compatible with
 *    Electron's Windows implementation — so `core/secretStore.js` needs no
 *    change at all and existing sealed configs decrypt as-is. Each call is one
 *    short synchronous process spawn; that is fine because the only callers are
 *    `loadConfig`/`saveConfig`, which are user-driven and infrequent.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const tunnel = require("./tunnel.js");
const osCrypt = require("./osCrypt.js");

const APP_ROOT = path.resolve(__dirname, "..");
const VERSION = "2.6.0";
const IS_WINDOWS = process.platform === "win32";
const APP_EXE = process.env.EMSODER_APP_EXE || "";
const HELPER_AVAILABLE = IS_WINDOWS && !!APP_EXE && fs.existsSync(APP_EXE);

function appDataDir() {
  if (process.env.EMSODER_USER_DATA) return process.env.EMSODER_USER_DATA;
  const base = process.env.APPDATA || path.join(os.homedir(), ".config");
  return path.join(base, "EMSoder");
}
const USER_DATA = appDataDir();

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

const appListeners = new Map();

const app = {
  getPath(name) {
    switch (name) {
      case "userData":
        return USER_DATA;
      case "appData":
        return path.dirname(USER_DATA);
      case "temp":
        return os.tmpdir();
      case "home":
        return os.homedir();
      case "logs":
        return path.join(USER_DATA, "logs");
      case "exe":
        return APP_EXE;
      case "resources":
        return process.env.EMSODER_RESOURCES || path.join(APP_ROOT, "resources");
      default:
        return USER_DATA;
    }
  },
  getVersion: () => VERSION,
  getName: () => "EMSoder",
  getAppPath: () => APP_ROOT,
  /** Single-instance is enforced by the shell (tauri-plugin-single-instance). */
  requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve(),
  quit() {
    tunnel.request("app.quit", []).catch(() => {});
  },
  exit() {
    tunnel.request("app.quit", []).catch(() => {});
  },
  on(event, handler) {
    if (!appListeners.has(event)) appListeners.set(event, []);
    appListeners.get(event).push(handler);
    return app;
  },
  once(event, handler) {
    const wrapped = (...args) => {
      app.removeListener(event, wrapped);
      handler(...args);
    };
    return app.on(event, wrapped);
  },
  removeListener(event, handler) {
    const list = appListeners.get(event) || [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
    return app;
  },
  off(event, handler) {
    return app.removeListener(event, handler);
  },
  emit(event, ...args) {
    for (const handler of [...(appListeners.get(event) || [])]) {
      try {
        handler(...args);
      } catch (err) {
        process.stderr.write(`[host] app.${event} 处理失败：${err && err.stack}\n`);
      }
    }
  },
  setLoginItemSettings() {},
  commandLine: { appendSwitch() {} },
  isPackaged: !process.env.EMSODER_DEV,
};

// ---------------------------------------------------------------------------
// BrowserWindow
// ---------------------------------------------------------------------------

const liveWindows = new Set();
// Rust reports geometry on move/resize; `getBounds()` is synchronous in
// Electron, so the shim keeps a cache instead of round-tripping.
const boundsCache = new Map();

function makeWebContents(win) {
  const listeners = new Map();
  return {
    send(channel, ...args) {
      // Electron delivered this to one window; `win.kind` is that window's label.
      tunnel.emit(channel, args, win.kind);
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return this;
    },
    once(event, handler) {
      return this.on(event, handler);
    },
    removeListener() {
      return this;
    },
    setAudioMuted() {
      // No webview-level mute in Tauri; the renderer gates audio on
      // `config.soundEnabled` instead (see renderer/js/dom-util.js).
    },
    isAudioMuted: () => false,
    openDevTools() {},
    closeDevTools() {},
    getURL: () => (win.kind === "ball" ? "ball.html" : "index.html"),
    reload() {},
    executeJavaScript: () => Promise.resolve(),
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) || [])]) {
        try {
          handler(...args);
        } catch (err) {
          process.stderr.write(`[host] webContents.${event} 处理失败：${err && err.stack}\n`);
        }
      }
    },
    session: { webRequest: {} },
  };
}

/** The ball is the only frameless + transparent window. */
function classify(options = {}) {
  if (options.transparent === true || options.frame === false) return "ball";
  return "main";
}

class BrowserWindow {
  constructor(options = {}) {
    this.options = options;
    this.kind = classify(options);
    this.destroyed = false;
    this.shown = false;
    this._listeners = new Map();
    this._ensurePromise = null;
    this.webContents = makeWebContents(this);
    boundsCache.set(this.kind, {
      x: Number.isFinite(options.x) ? options.x : 0,
      y: Number.isFinite(options.y) ? options.y : 0,
      width: options.width || 1440,
      height: options.height || 900,
    });
    liveWindows.add(this);
  }

  static getAllWindows() {
    return [...liveWindows].filter((w) => !w.destroyed);
  }

  static fromWebContents() {
    return null;
  }

  /** Ask the shell to create the real window (idempotent). */
  _ensure() {
    if (!this._ensurePromise) {
      this._ensurePromise = tunnel
        .request("window.ensure", [this.kind])
        .catch((err) => {
          process.stderr.write(`[host] 窗口创建失败(${this.kind})：${err.message}\n`);
          this._ensurePromise = null;
          throw err;
        });
    }
    return this._ensurePromise;
  }

  loadFile(filePath) {
    this.file = filePath;
    return this._ensure().then(() => undefined);
  }

  loadURL(url) {
    this.url = url;
    return this._ensure().then(() => undefined);
  }

  show() {
    if (this.destroyed) return;
    this.shown = true;
    this._ensure()
      .then(() => tunnel.request("window.show", [this.kind]))
      .catch(() => {});
  }

  hide() {
    tunnel.request("window.destroy", [this.kind]).catch(() => {});
  }

  focus() {
    const channel = this.kind === "main" ? "window.focus-main" : "window.show";
    tunnel.request(channel, [this.kind]).catch(() => {});
  }

  // Minimised state is not tracked; the shell's reveal path already unminimises
  // and focuses, so these are compatibility no-ops.
  isMinimized() {
    return false;
  }
  restore() {}
  minimize() {}
  maximize() {}
  isMaximized() {
    return false;
  }
  isFullScreen() {
    return false;
  }
  setFullScreen() {}
  isVisible() {
    return this.shown && !this.destroyed;
  }
  isDestroyed() {
    return this.destroyed;
  }

  getBounds() {
    return { ...(boundsCache.get(this.kind) || { x: 0, y: 0, width: 1440, height: 900 }) };
  }
  getContentBounds() {
    return this.getBounds();
  }
  setBounds(bounds) {
    boundsCache.set(this.kind, { ...this.getBounds(), ...bounds });
  }
  setPosition(x, y) {
    this.setBounds({ x, y });
  }
  setSize(width, height) {
    this.setBounds({ width, height });
  }
  setAlwaysOnTop(flag) {
    tunnel.request("window.set-always-on-top", [this.kind, !!flag]).catch(() => {});
  }
  setSkipTaskbar() {}
  setResizable() {}
  setTitle() {}
  setMenu() {}
  setMenuBarVisibility() {}
  setAudioMuted() {}
  setBackgroundColor() {}
  center() {}

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    liveWindows.delete(this);
    tunnel.request("window.destroy", [this.kind]).catch(() => {});
    this.emit("closed");
  }

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(handler);
    return this;
  }
  once(event, handler) {
    const wrapped = (...args) => {
      this.removeListener(event, wrapped);
      handler(...args);
    };
    return this.on(event, wrapped);
  }
  removeListener(event, handler) {
    const list = this._listeners.get(event) || [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
    return this;
  }
  emit(event, ...args) {
    for (const handler of [...(this._listeners.get(event) || [])]) {
      try {
        handler(...args);
      } catch (err) {
        process.stderr.write(`[host] window.${event} 处理失败：${err && err.stack}\n`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ipcMain — routes to an in-process registry
// ---------------------------------------------------------------------------

const handlers = new Map();
const eventHandlers = new Map();
let trustedSenderInstalled = false;

/**
 * A stand-in for Electron's IpcMainEvent. `src/main/main.js` guards every
 * handler with `assertTrustedSender(event)`, which inspects `event.senderFrame`.
 * In Tauri the webview can only reach these commands through our own shell API
 * (no remote content is ever loaded, navigation is denied), so the frame is
 * always one of ours.
 *
 * `from` carries the asking window's label so `event.sender.send` — which several
 * IPC modules use to stream progress back to the caller — reaches that window and
 * not the others.
 */
function makeEvent(channel, from = null) {
  return {
    channel,
    senderFrame: { url: "http://tauri.localhost/index.html", parent: null },
    sender: {
      send(pushChannel, ...args) {
        tunnel.emit(pushChannel, args, from);
      },
      isDestroyed: () => false,
    },
    reply(pushChannel, ...args) {
      tunnel.emit(pushChannel, args, from);
    },
    returnValue: undefined,
  };
}

const ipcMain = {
  handle(channel, listener) {
    trustedSenderInstalled = true;
    handlers.set(channel, listener);
  },
  handleOnce(channel, listener) {
    handlers.set(channel, listener);
  },
  removeHandler(channel) {
    handlers.delete(channel);
  },
  on(channel, listener) {
    if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
    eventHandlers.get(channel).push(listener);
  },
  once(channel, listener) {
    this.on(channel, listener);
  },
  removeListener(channel, listener) {
    const list = eventHandlers.get(channel) || [];
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  },
  removeAllListeners(channel) {
    eventHandlers.delete(channel);
  },
  /** Called by host.js when the shell asks for `channel`. */
  async invoke(channel, args, from) {
    const listener = handlers.get(channel);
    if (!listener) {
      throw new Error(`没有注册的 IPC 通道：${channel}`);
    }
    return listener(makeEvent(channel, from), ...args);
  },
  /** Called by host.js for fire-and-forget channels (`agent:send`). */
  dispatch(channel, args, from) {
    const listeners = eventHandlers.get(channel) || [];
    if (!listeners.length) {
      process.stderr.write(`[host] 没有监听的 IPC 通道：${channel}\n`);
      return;
    }
    for (const listener of listeners) listener(makeEvent(channel, from), ...args);
    return undefined;
  },
  get _handlers() {
    return handlers;
  },
  get _events() {
    return eventHandlers;
  },
};

// ---------------------------------------------------------------------------
// dialog / shell / screen / safeStorage / nativeTheme / Menu
// ---------------------------------------------------------------------------

/** Electron accepts either `(options)` or `(browserWindow, options)`. */
function normalizeDialogArgs(first, second) {
  if (second === undefined) return [null, first || {}];
  return [first || null, second || {}];
}

const dialog = {
  async showOpenDialog(first, second) {
    return tunnel.request("dialog.open", normalizeDialogArgs(first, second));
  },
  async showOpenDialogSync() {
    return tunnel.request("dialog.open", [null, {}]);
  },
  async showSaveDialog(first, second) {
    return tunnel.request("dialog.save", normalizeDialogArgs(first, second));
  },
  async showMessageBox(first, second) {
    return tunnel.request("dialog.message", normalizeDialogArgs(first, second));
  },
  showErrorBox(title, content) {
    tunnel
      .request("dialog.message", [null, { type: "error", title, message: content }])
      .catch(() => {});
  },
};

const shell = {
  openExternal(url) {
    tunnel.request("shell.openExternal", [String(url || "")]).catch(() => {});
    return Promise.resolve();
  },
  async openPath(p) {
    return tunnel.request("shell.openExternal", [`file://${p}`]).then(() => "");
  },
  showItemInFolder() {},
  beep() {},
};

// `getPrimaryDisplay()` is synchronous in Electron and used to place the
// floating ball. The shell's work area is fetched once at boot and cached.
let displayCache = { x: 0, y: 0, width: 1280, height: 800 };

const screen = {
  getPrimaryDisplay() {
    return {
      workArea: { ...displayCache },
      workAreaSize: { width: displayCache.width, height: displayCache.height },
      size: { width: displayCache.width, height: displayCache.height },
      bounds: { ...displayCache },
      scaleFactor: 1,
      id: 1,
    };
  },
  getDisplayNearestPoint() {
    return screen.getPrimaryDisplay();
  },
  getDisplayMatching() {
    return screen.getPrimaryDisplay();
  },
  getAllDisplays() {
    return [screen.getPrimaryDisplay()];
  },
};

// Electron's safeStorage format (v10 + AES-256-GCM with a DPAPI-wrapped key)
// lives in ./osCrypt.js; see that file for the byte layout and why.
osCrypt.configure({ appPath: APP_EXE, userDataDir: USER_DATA });

const safeStorage = {
  /** Windows DPAPI is always available to the logged-in user. */
  isEncryptionAvailable: () => HELPER_AVAILABLE,
  encryptString(plainText) {
    return osCrypt.encryptString(plainText);
  },
  decryptString(buffer) {
    return osCrypt.decryptString(buffer);
  },
  getSelectedStorageBackend: () => (IS_WINDOWS ? "dpapi" : "unknown"),
};

/** The menu lives in the shell (src-tauri/src/menu.rs). */
const Menu = {
  setApplicationMenu() {},
  buildFromTemplate: (template) => template,
  getApplicationMenu: () => null,
};

const nativeTheme = {
  themeSource: "dark",
  shouldUseDarkColors: true,
  on() {},
};

/** Called by host.js after boot to seed `screen`. */
async function primeDisplays() {
  try {
    // Bounded: boot must not hang if the shell is slow or absent (headless tests).
    const area = await tunnel.request("screen.workArea", [], 2000);
    if (area && Number.isFinite(area.width) && area.width > 0) {
      displayCache = {
        x: area.x || 0,
        y: area.y || 0,
        width: area.width,
        height: area.height,
      };
    }
  } catch {
    /* keep the default */
  }
}

/** Called by host.js when the shell reports new geometry. */
function updateBounds(kind, bounds) {
  if (!kind || !bounds) return;
  boundsCache.set(kind, {
    x: bounds.x ?? 0,
    y: bounds.y ?? 0,
    width: bounds.width ?? 1440,
    height: bounds.height ?? 900,
  });
  if (kind === "main") {
    const win = [...liveWindows].find((w) => w.kind === "main" && !w.destroyed);
    if (win) win.emit("resize");
  }
}

/**
 * The shell asks us to close the main window. Electron's own flow was: window
 * 'close' event -> handler decides. Re-emitting 'close' here means
 * `src/main/main.js`'s close block ports over verbatim.
 */
function emitCloseRequest() {
  const win = [...liveWindows].find((w) => w.kind === "main" && !w.destroyed);
  if (!win) return false;
  let prevented = false;
  win.emit("close", {
    preventDefault() {
      prevented = true;
    },
  });
  return prevented;
}

module.exports = {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  screen,
  safeStorage,
  Menu,
  nativeTheme,
  // internals used by host.js
  _internal: {
    USER_DATA,
    APP_ROOT,
    primeDisplays,
    updateBounds,
    emitCloseRequest,
    helperAvailable: HELPER_AVAILABLE,
  },
};
