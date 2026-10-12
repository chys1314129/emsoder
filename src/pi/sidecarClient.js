const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");
const fs = require("fs");
const { METHODS, parseLine, encode } = require("./protocol");

function defaultSidecarPath() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "agent-runtime", "sidecar.mjs"));
  candidates.push(path.join(__dirname, "sidecar.mjs"));
  candidates.push(path.join(__dirname, "..", "..", "resources", "agent-runtime", "sidecar.mjs"));
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

/**
 * The Node runtime that runs the Pi sidecar.
 *
 * Electron build: the Electron binary doubles as Node, hence the
 * `ELECTRON_RUN_AS_NODE` handshake below.
 * Tauri build: the host process *is* Node already, so its own executable is a
 * valid runtime — and `EMSODER_NODE` (set by the Rust shell) points at the
 * bundled `resources/skill-runtime/node/node.exe`, which is the runtime the
 * shipped app guarantees.
 */
function resolveNodeRuntime() {
  if (!process.versions.electron) {
    return process.env.EMSODER_NODE || process.execPath;
  }
  return process.execPath;
}

class PiSidecarClient {
  constructor({ sidecarPath = defaultSidecarPath(), onRequest, onNotification, onStderr, onExit } = {}) {
    this.sidecarPath = sidecarPath;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.onStderr = onStderr;
    this.onExit = onExit;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.started = null;
    this._line = null;
    this._exit = null;
    this._closing = false;
  }

  get isRunning() {
    return !!this.child && !this.child.killed;
  }

  async start() {
    if (this.isRunning) return;
    if (!fs.existsSync(this.sidecarPath)) {
      throw new Error(`Pi sidecar 不存在: ${this.sidecarPath}`);
    }
    // Only Electron needs the "run me as Node" flag; under the Tauri host we are
    // already a plain Node process.
    const childEnv = { ...process.env };
    if (process.versions.electron) childEnv.ELECTRON_RUN_AS_NODE = "1";
    this.child = spawn(resolveNodeRuntime(), [this.sidecarPath], {
      cwd: path.dirname(this.sidecarPath),
      env: childEnv,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.started = new Promise((resolve, reject) => {
      this._startedResolve = resolve;
      this._startedReject = reject;
    });
    this._line = readline.createInterface({ input: this.child.stdout });
    this._line.on("line", (line) => this._onLine(line));
    this.child.stderr.on("data", (data) => this.onStderr?.(String(data)));
    this._exit = new Promise((resolve) => this.child.once("exit", (code, signal) => {
      this._onExit(code, signal);
      resolve({ code, signal });
    }));
    this.child.once("error", (error) => {
      this._startedReject?.(error);
      this._rejectAll(error);
    });
    this.child.once("spawn", () => {
      this._startedResolve?.();
      this.request(METHODS.configure, {}).catch(() => {});
    });
    await this.started;
  }

  _onLine(line) {
    const msg = parseLine(line);
    if (!msg) return;
    if (msg.id != null && !msg.method) {
      const p = this.pending.get(String(msg.id));
      if (!p) return;
      this.pending.delete(String(msg.id));
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || "Pi sidecar error"), { code: msg.error.code, data: msg.error.data }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      if (msg.method === METHODS.agentEvent) this.onNotification?.(msg.params || {});
      else void this._handleRequest(msg);
    }
  }

  async _handleRequest(msg) {
    if (!this.onRequest) {
      this._write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unhandled parent request: ${msg.method}` } });
      return;
    }
    try {
      const result = await this.onRequest(msg.method, msg.params || {});
      this._write({ jsonrpc: "2.0", id: msg.id, result });
    } catch (error) {
      this._write({ jsonrpc: "2.0", id: msg.id, error: { code: error.code || -32000, message: String(error.message || error) } });
    }
  }

  _write(message) {
    if (this.child?.stdin?.writable) this.child.stdin.write(encode(message));
  }

  notify(method, params = {}) {
    this._write({ jsonrpc: "2.0", method, params });
  }

  async request(method, params = {}, timeoutMs = 30_000) {
    await this.start();
    const id = `parent-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Pi sidecar request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this._write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async health() { return this.request(METHODS.health, {}, 10_000); }
  async prompt(params) { return this.request(METHODS.prompt, params, 30_000); }
  async abort(params) { return this.request(METHODS.abort, params, 10_000); }
  async stop(params) { return this.request(METHODS.stop, params, 10_000); }
  async status(params) { return this.request(METHODS.status, params, 10_000); }
  async compact(params) { return this.request(METHODS.compact, params, 30_000); }
  async subagentRun(params) { return this.request(METHODS.subagentRun, params, 600_000); }
  async dispose(params) { return this.request(METHODS.dispose, params, 10_000); }

  _onExit(code, signal) {
    const error = new Error(`Pi sidecar exited (code=${code}, signal=${signal || "none"})`);
    this._rejectAll(error);
    this.child = null;
    this._line = null;
    // 主动 close 不算崩溃：只有意外退出才通知宿主（宿主决定是否自动恢复）
    if (!this._closing) {
      try { this.onExit?.(code, signal); } catch { /* ignore */ }
    }
  }

  _rejectAll(error) {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  async close() {
    this._closing = true;
    if (!this.child) return;
    try { await this.abort({}); } catch { /* ignore */ }
    const child = this.child;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve();
      }, 1500);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    this.child = null;
  }
}

module.exports = { PiSidecarClient, defaultSidecarPath };
