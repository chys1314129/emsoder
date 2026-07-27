const { EventEmitter } = require("events");
const path = require("path");
const fs = require("fs");

let pty = null;
let ptyLoadError = null;

function resolvePtyPackageDir() {
  try {
    return path.dirname(
      require.resolve("@homebridge/node-pty-prebuilt-multiarch/package.json")
    );
  } catch {
    try {
      return path.dirname(require.resolve("@homebridge/node-pty-prebuilt-multiarch"));
    } catch {
      return null;
    }
  }
}

function nativeReleaseDir() {
  const pkg = resolvePtyPackageDir();
  return pkg ? path.join(pkg, "build", "Release") : null;
}

function checkNativeBinaries() {
  const rel = nativeReleaseDir();
  if (!rel || !fs.existsSync(rel)) {
    return {
      ok: false,
      error:
        "缺少 node-pty 原生文件 (build/Release)。请在 desktop 目录执行: npm run fix-pty",
    };
  }
  const need = ["conpty.node", "pty.node"];
  const missing = need.filter((n) => !fs.existsSync(path.join(rel, n)));
  if (missing.length) {
    return {
      ok: false,
      error: `node-pty 原生文件不完整: 缺少 ${missing.join(", ")}。请执行 npm run fix-pty`,
    };
  }
  return { ok: true, releaseDir: rel };
}

function loadPty() {
  if (pty) return pty;
  if (ptyLoadError) throw ptyLoadError;

  const check = checkNativeBinaries();
  // still try require — sometimes path differs under asarUnpack
  try {
    pty = require("@homebridge/node-pty-prebuilt-multiarch");
    return pty;
  } catch (e1) {
    try {
      pty = require("node-pty");
      return pty;
    } catch (e2) {
      const hint = check.ok
        ? ""
        : ` ${check.error}`;
      ptyLoadError = new Error(
        `无法加载 PTY 模块: ${e1.message || e1}.${hint} 备选 node-pty: ${e2.message || e2}`
      );
      throw ptyLoadError;
    }
  }
}

/** Allow retry after user runs fix-pty without restarting whole app process... actually require cache needs clear */
function resetPtyCache() {
  pty = null;
  ptyLoadError = null;
  try {
    const id = require.resolve("@homebridge/node-pty-prebuilt-multiarch");
    delete require.cache[id];
  } catch {
    /* ignore */
  }
}

function defaultShell() {
  if (process.platform === "win32") {
    const ps = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    if (fs.existsSync(ps)) {
      return {
        file: ps,
        args: ["-NoLogo", "-NoProfile"],
      };
    }
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: [],
    };
  }
  const shell = process.env.SHELL || "/bin/bash";
  return { file: shell, args: ["-l"] };
}

function buildEnv(workspaceRoot) {
  let baseEnv = { ...process.env };
  try {
    baseEnv = require("../tools/skillRuntime").augmentProcessEnv(baseEnv);
  } catch {
    /* optional */
  }
  return {
    ...baseEnv,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "EMSoder",
  };
}

/**
 * Real PTY terminal sessions for xterm.js frontend.
 */
class TerminalManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, {id:string, cwd:string, cols:number, rows:number, term:any}>} */
    this.sessions = new Map();
  }

  get available() {
    try {
      loadPty();
      return true;
    } catch {
      return false;
    }
  }

  get diagnostics() {
    const check = checkNativeBinaries();
    let loadErr = null;
    try {
      loadPty();
    } catch (e) {
      loadErr = e.message || String(e);
    }
    return {
      available: !loadErr,
      native: check,
      loadError: loadErr,
      releaseDir: check.releaseDir || null,
      platform: process.platform,
      electron: process.versions.electron || null,
      modules: process.versions.modules || null,
    };
  }

  create(workspaceRoot, size = {}) {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const cwd = workspaceRoot || process.cwd();
    const cols = Math.max(20, Number(size.cols) || 80);
    const rows = Math.max(5, Number(size.rows) || 24);

    let term;
    try {
      // allow retry if previous load failed before fix-pty
      if (ptyLoadError) resetPtyCache();
      const nodePty = loadPty();
      const shell = defaultShell();
      const env = buildEnv(workspaceRoot);
      const opts = {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env,
      };

      if (process.platform === "win32") {
        try {
          term = nodePty.spawn(shell.file, shell.args, {
            ...opts,
            useConpty: true,
          });
        } catch (conptyErr) {
          // Fallback: winpty when ConPTY native fails
          term = nodePty.spawn(shell.file, shell.args, {
            ...opts,
            useConpty: false,
          });
          this.emit("data", {
            id,
            type: "err",
            text: `\r\n[PTY] ConPTY 失败，已改用 winpty: ${conptyErr.message || conptyErr}\r\n`,
          });
        }
      } else {
        term = nodePty.spawn(shell.file, shell.args, opts);
      }
    } catch (err) {
      const msg = String(err.message || err);
      const tip = /conpty\.node|pty\.node|MODULE_NOT_FOUND|无法加载 PTY/i.test(msg)
        ? "\r\n修复: 在 desktop 目录执行 npm run fix-pty 后重启应用\r\n"
        : "";
      this.emit("data", {
        id,
        type: "err",
        text: `\r\n[PTY 启动失败] ${msg}${tip}`,
      });
      const e = new Error(msg + (tip ? " → 请执行 npm run fix-pty 后重启" : ""));
      throw e;
    }

    const session = { id, cwd, cols, rows, term };
    this.sessions.set(id, session);

    term.onData((data) => {
      this.emit("data", { id, type: "out", text: data });
    });

    term.onExit(({ exitCode, signal }) => {
      this.emit("data", {
        id,
        type: "exit",
        text: `\r\n[进程退出 code=${exitCode}${signal ? ` signal=${signal}` : ""}]\r\n`,
        code: exitCode,
        signal,
      });
      this.sessions.delete(id);
    });

    this.emit("data", {
      id,
      type: "ready",
      text: "",
      cwd,
      cols,
      rows,
      shell: process.platform,
    });

    return { id, cwd, cols, rows, mode: "pty" };
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      cwd: s.cwd,
      cols: s.cols,
      rows: s.rows,
      mode: "pty",
    }));
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  write(id, data) {
    const session = this.sessions.get(id);
    if (!session?.term) return { ok: false, error: "session not found" };
    try {
      session.term.write(String(data ?? ""));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  resize(id, cols, rows) {
    const session = this.sessions.get(id);
    if (!session?.term) return { ok: false, error: "session not found" };
    try {
      const c = Math.max(20, Number(cols) || 80);
      const r = Math.max(5, Number(rows) || 24);
      session.term.resize(c, r);
      session.cols = c;
      session.rows = r;
      return { ok: true, cols: c, rows: r };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  interrupt(id) {
    return this.write(id, "\x03");
  }

  kill(id) {
    const session = this.sessions.get(id);
    if (!session?.term) return { ok: false, error: "session not found" };
    try {
      session.term.kill();
      this.sessions.delete(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  dispose(id) {
    return this.kill(id);
  }

  disposeAll() {
    for (const id of [...this.sessions.keys()]) {
      try {
        this.kill(id);
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = { TerminalManager, resetPtyCache, checkNativeBinaries };
