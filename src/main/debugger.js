const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

/**
 * Minimal Node.js debugger via Inspector (CDP over WebSocket).
 * Supports: launch, breakpoints, continue, step*, pause stack, evaluate, stop.
 */
class NodeDebugger extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
    this.breakpoints = new Map(); // absPath -> Set<line>
    this.bpIds = new Map(); // key path:line -> CDP breakpointId
    this.scripts = new Map(); // scriptId -> { url, path }
    this.paused = false;
    this.running = false;
    this.config = null;
  }

  get state() {
    return {
      running: this.running,
      paused: this.paused,
      config: this.config,
      breakpoints: this.listBreakpoints(),
    };
  }

  listBreakpoints() {
    const out = [];
    for (const [filePath, lines] of this.breakpoints) {
      for (const line of lines) out.push({ path: filePath, line });
    }
    return out;
  }

  setBreakpoint(filePath, line) {
    const abs = path.resolve(filePath);
    const ln = Number(line);
    if (!ln || ln < 1) return { ok: false, error: "invalid line" };
    if (!this.breakpoints.has(abs)) this.breakpoints.set(abs, new Set());
    this.breakpoints.get(abs).add(ln);
    if (this.ws && this.ws.readyState === 1) {
      this._installBreakpoint(abs, ln).catch(() => {});
    }
    return { ok: true };
  }

  removeBreakpoint(filePath, line) {
    const abs = path.resolve(filePath);
    const ln = Number(line);
    const set = this.breakpoints.get(abs);
    if (set) {
      set.delete(ln);
      if (!set.size) this.breakpoints.delete(abs);
    }
    const key = `${abs}:${ln}`;
    const id = this.bpIds.get(key);
    if (id && this.ws) {
      this.send("Debugger.removeBreakpoint", { breakpointId: id }).catch(() => {});
      this.bpIds.delete(key);
    }
    return { ok: true };
  }

  clearBreakpoints() {
    this.breakpoints.clear();
    for (const id of this.bpIds.values()) {
      if (this.ws) {
        this.send("Debugger.removeBreakpoint", { breakpointId: id }).catch(() => {});
      }
    }
    this.bpIds.clear();
    return { ok: true };
  }

  async launch({ program, args = [], cwd, nodePath, env } = {}) {
    if (this.running) await this.stop();
    if (!program) throw new Error("需要 program（要调试的 js 文件）");
    const absProg = path.resolve(cwd || process.cwd(), program);
    if (!fs.existsSync(absProg)) throw new Error(`文件不存在: ${absProg}`);

    const nodeBin = nodePath || process.execPath.includes("electron")
      ? "node"
      : process.execPath;
    // Prefer system node for debuggee; electron binary is not ideal for user scripts
    const exe = process.platform === "win32" ? resolveNodeWindows(nodeBin) : nodeBin;

    this._bpRebound = false;
    this.scripts.clear();
    this.bpIds.clear();
    this.config = {
      program: absProg,
      args: Array.isArray(args) ? args.map(String) : [],
      cwd: cwd || path.dirname(absProg),
    };

    const childArgs = [
      `--inspect-brk=127.0.0.1:0`,
      absProg,
      ...this.config.args,
    ];

    this.child = spawn(exe, childArgs, {
      cwd: this.config.cwd,
      env: { ...process.env, ...(env || {}) },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.running = true;
    this.paused = true;

    let stderrBuf = "";
    const wsUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("等待 Inspector WebSocket 超时"));
      }, 8000);

      const onData = (buf) => {
        const text = buf.toString();
        stderrBuf += text;
        this.emit("output", { stream: "stderr", text });
        const m =
          text.match(/Debugger listening on (ws:\/\/[^\s]+)/) ||
          stderrBuf.match(/Debugger listening on (ws:\/\/[^\s]+)/);
        if (m) {
          clearTimeout(timer);
          this.child.stderr.off("data", onData);
          resolve(m[1]);
        }
      };
      this.child.stderr.on("data", onData);
      this.child.stdout.on("data", (b) => {
        this.emit("output", { stream: "stdout", text: b.toString() });
      });
      this.child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      const onChildEnd = (code, signal) => {
        this.running = false;
        this.paused = false;
        this.emit("exited", { code, signal });
        this._cleanupSocket();
      };
      this.child.on("exit", onChildEnd);
      this.child.on("close", () => {
        if (this.running) onChildEnd(null, null);
      });
    });

    await this._connect(wsUrl);
    await this.send("Debugger.enable");
    await this.send("Runtime.enable");
    // install existing breakpoints before first resume
    for (const [filePath, lines] of this.breakpoints) {
      for (const line of lines) {
        try {
          await this._installBreakpoint(filePath, line);
        } catch (e) {
          this.emit("output", {
            stream: "stderr",
            text: `[breakpoint] ${filePath}:${line} ${e.message}\n`,
          });
        }
      }
    }
    // Leave inspect-brk waiting state (still paused at entry until resume)
    try {
      await this.send("Runtime.runIfWaitingForDebugger");
    } catch {
      /* ignore */
    }
    this.emit("started", { type: "started", ...this.config, wsUrl });
    return { ok: true, ...this.config };
  }

  async _connect(wsUrl) {
    let WS = globalThis.WebSocket;
    if (!WS) {
      try {
        WS = require("ws");
      } catch {
        throw new Error("无 WebSocket 实现，请安装依赖 ws");
      }
    }
    await new Promise((resolve, reject) => {
      const ws = new WS(wsUrl);
      this.ws = ws;
      const onOpen = () => resolve();
      const onErr = () => reject(new Error("WebSocket error"));
      if (typeof ws.on === "function") {
        // ws package
        ws.on("open", onOpen);
        ws.on("error", onErr);
        ws.on("message", (data) => this._onMessage(String(data)));
        ws.on("close", () => this._cleanupSocket());
      } else {
        ws.onopen = onOpen;
        ws.onerror = onErr;
        ws.onmessage = (ev) => this._onMessage(String(ev.data || ""));
        ws.onclose = () => this._cleanupSocket();
      }
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    this._handleEvent(msg.method, msg.params || {});
  }

  async _handleEvent(method, params) {
    if (method === "Debugger.scriptParsed") {
      const url = params.url || "";
      const filePath = urlToPath(url);
      this.scripts.set(params.scriptId, { url, path: filePath });
      // Re-apply breakpoints for this script (important for path encoding / late parse)
      if (filePath) {
        const lines = this.breakpoints.get(path.resolve(filePath));
        // also try case-insensitive match
        let set = lines;
        if (!set) {
          const target = path.resolve(filePath).replace(/\\/g, "/").toLowerCase();
          for (const [bpPath, lnSet] of this.breakpoints) {
            if (bpPath.replace(/\\/g, "/").toLowerCase() === target) {
              set = lnSet;
              break;
            }
          }
        }
        if (set) {
          for (const line of set) {
            try {
              await this._installBreakpoint(filePath, line);
            } catch {
              /* ignore */
            }
          }
        }
      }
      return;
    }
    if (method === "Debugger.paused") {
      this.paused = true;
      // On entry pause, force re-bind breakpoints using script ids we already know
      if (!this._bpRebound) {
        this._bpRebound = true;
        for (const [filePath, lines] of this.breakpoints) {
          for (const line of lines) {
            try {
              await this._installBreakpoint(filePath, line);
            } catch {
              /* ignore */
            }
          }
        }
      }
      const frames = (params.callFrames || []).map((f) => ({
        callFrameId: f.callFrameId,
        functionName: f.functionName || "(anonymous)",
        scriptId: f.location?.scriptId,
        line: (f.location?.lineNumber ?? 0) + 1,
        column: (f.location?.columnNumber ?? 0) + 1,
        url: f.url,
        path:
          urlToPath(f.url) ||
          this.scripts.get(f.location?.scriptId)?.path ||
          normalizeScriptPath(f.url),
      }));
      this.emit("paused", {
        reason: params.reason,
        frames,
        hitBreakpoints: params.hitBreakpoints || [],
      });
      return;
    }
    if (method === "Debugger.resumed") {
      this.paused = false;
      this.emit("resumed", {});
      return;
    }
    if (method === "Runtime.consoleAPICalled") {
      const text = (params.args || [])
        .map((a) => a.value ?? a.description ?? "")
        .join(" ");
      this.emit("output", { stream: "console", text: text + "\n" });
    }
  }

  _isOpen() {
    if (!this.ws) return false;
    const rs = this.ws.readyState;
    // browser WebSocket.OPEN === 1; ws package same
    return rs === 1 || rs === this.ws.OPEN;
  }

  send(method, params = {}) {
    if (!this._isOpen()) {
      return Promise.reject(new Error("debugger not connected"));
    }
    const id = ++this.msgId;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(payload);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
        return;
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 10000);
    });
  }

  async _installBreakpoint(filePath, line) {
    const abs = path.resolve(filePath);
    const slash = abs.replace(/\\/g, "/");
    const base = path.basename(abs);
    // Encode for file:// URLs (handles Chinese / spaces in workspace path)
    const encodedSlash = slash
      .split("/")
      .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
      .join("/");
    const attempts = [
      { lineNumber: line - 1, url: slash },
      { lineNumber: line - 1, url: abs },
      { lineNumber: line - 1, url: "file:///" + encodedSlash },
      { lineNumber: line - 1, url: "file:///" + slash },
      {
        lineNumber: line - 1,
        urlRegex: base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
      },
    ];
    let lastErr;
    for (const params of attempts) {
      try {
        const result = await this.send("Debugger.setBreakpointByUrl", params);
        if (result?.breakpointId) {
          this.bpIds.set(`${abs}:${line}`, result.breakpointId);
          return result;
        }
      } catch (e) {
        lastErr = e;
      }
    }
    // Match already-parsed scripts
    for (const [scriptId, meta] of this.scripts) {
      const p = (meta.path || urlToPath(meta.url) || "").replace(/\\/g, "/");
      if (p && p.toLowerCase() === slash.toLowerCase()) {
        try {
          const result = await this.send("Debugger.setBreakpoint", {
            location: { scriptId, lineNumber: line - 1, columnNumber: 0 },
          });
          if (result?.breakpointId) {
            this.bpIds.set(`${abs}:${line}`, result.breakpointId);
            return result;
          }
        } catch (e) {
          lastErr = e;
        }
      }
    }
    if (lastErr) throw lastErr;
    return null;
  }

  async continue() {
    await this.send("Debugger.resume");
    // If script ends, Node may linger while inspector is attached — watch for exit
    this._armExitWatch();
    return { ok: true };
  }

  _armExitWatch() {
    if (this._exitWatch) return;
    this._exitWatch = setInterval(() => {
      if (!this.child) {
        clearInterval(this._exitWatch);
        this._exitWatch = null;
        return;
      }
      if (this.child.exitCode != null || this.child.killed) {
        clearInterval(this._exitWatch);
        this._exitWatch = null;
        if (this.running) {
          this.running = false;
          this.paused = false;
          this.emit("exited", {
            code: this.child.exitCode,
            signal: this.child.signalCode,
          });
          this._cleanupSocket();
        }
      }
    }, 200);
  }
  async pause() {
    await this.send("Debugger.pause");
    return { ok: true };
  }
  async stepOver() {
    await this.send("Debugger.stepOver");
    return { ok: true };
  }
  async stepInto() {
    await this.send("Debugger.stepInto");
    return { ok: true };
  }
  async stepOut() {
    await this.send("Debugger.stepOut");
    return { ok: true };
  }

  async evaluate(expression, callFrameId) {
    if (callFrameId) {
      const r = await this.send("Debugger.evaluateOnCallFrame", {
        callFrameId,
        expression: String(expression || ""),
        returnByValue: true,
      });
      return {
        ok: true,
        result: r?.result?.value ?? r?.result?.description ?? null,
        raw: r?.result,
      };
    }
    const r = await this.send("Runtime.evaluate", {
      expression: String(expression || ""),
      returnByValue: true,
    });
    return {
      ok: true,
      result: r?.result?.value ?? r?.result?.description ?? null,
      raw: r?.result,
    };
  }

  async stop() {
    if (this._exitWatch) {
      clearInterval(this._exitWatch);
      this._exitWatch = null;
    }
    try {
      if (this._isOpen()) {
        await this.send("Runtime.terminateExecution").catch(() => {});
      }
    } catch {
      /* ignore */
    }
    this._cleanupSocket();
    if (this.child && !this.child.killed && this.child.exitCode == null) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(this.child.pid), "/f", "/t"], {
            windowsHide: true,
          });
        } else {
          this.child.kill("SIGTERM");
        }
      } catch {
        /* ignore */
      }
    }
    this.child = null;
    this.running = false;
    this.paused = false;
    this.emit("stopped", {});
    return { ok: true };
  }

  _cleanupSocket() {
    try {
      if (this.ws) {
        if (typeof this.ws.terminate === "function") this.ws.terminate();
        else this.ws.close();
      }
    } catch {
      /* ignore */
    }
    this.ws = null;
    for (const { reject } of this.pending.values()) {
      reject(new Error("debugger disconnected"));
    }
    this.pending.clear();
  }
}

function resolveNodeWindows(preferred) {
  if (preferred && preferred !== "node" && fs.existsSync(preferred)) return preferred;
  // common: just "node" on PATH
  return "node";
}

function urlToPath(url) {
  if (!url) return "";
  try {
    if (url.startsWith("file:")) {
      let p = decodeURIComponent(url.replace(/^file:\/\//, ""));
      // file:///C:/...
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
      return path.normalize(p);
    }
    // Node often uses plain absolute paths as script urls
    if (/^[A-Za-z]:[\\/]/.test(url) || url.startsWith("/")) {
      return path.normalize(url);
    }
  } catch {
    /* ignore */
  }
  return normalizeScriptPath(url);
}

function normalizeScriptPath(url) {
  if (!url) return "";
  try {
    if (/^[A-Za-z]:[\\/]/.test(url)) return path.normalize(url);
  } catch {
    /* ignore */
  }
  return "";
}

function pathToUrlCandidates(absPath) {
  const norm = path.resolve(absPath);
  const slash = norm.replace(/\\/g, "/");
  const out = [];
  if (/^[A-Za-z]:\//.test(slash)) {
    out.push("file:///" + slash);
    out.push("file://" + slash);
  } else {
    out.push("file://" + slash);
  }
  out.push(slash);
  out.push(norm);
  return out;
}

module.exports = { NodeDebugger };
