"use strict";
/**
 * NDJSON tunnel to the Rust shell over stdio.
 *
 * One JSON object per line, both directions (the same framing the Pi agent
 * sidecar already uses — one wire convention in this codebase, not two):
 *
 *   shell  -> host  {"t":"req","id":"web-3","ch":"config:get","args":[]}
 *   host   -> shell {"t":"res","id":"web-3","ok":true,"value":{...}}
 *   host   -> shell {"t":"ev","ch":"agent:event","args":[{...}]}      (push to webview)
 *   shell  -> host  {"t":"ev","ch":"app:before-close","args":[]}      (menu, lifecycle)
 *   host   -> shell {"t":"req","id":"host-7","ch":"dialog.open",...}  (reverse call)
 *
 * IMPORTANT: stdout is the tunnel. Everything the app prints must go to stderr —
 * see the console redirect in host.js. A stray `console.log` here would corrupt
 * the protocol.
 */
const readline = require("readline");

class Tunnel {
  constructor() {
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.requestHandler = null;
    this.closed = false;
    this.rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
      terminal: false,
    });
    this.rl.on("line", (line) => this._onLine(line));
    this.rl.on("close", () => {
      this.closed = true;
      // stdin closed means the shell is gone — it was killed, or it exited
      // without telling us. Either way there is nobody left to serve, and
      // lingering would leave an orphan process holding the user's workspace.
      this._emit("app:shell-gone", []);
    });
  }

  _emit(channel, args) {
    for (const handler of this.listeners.get(channel) || []) {
      try {
        handler(...args);
      } catch (err) {
        process.stderr.write(`[host] 事件处理失败 ${channel}: ${err && err.stack}\n`);
      }
    }
  }

  /** host -> shell request, awaited. */
  request(channel, args = [], timeoutMs = 0) {
    if (this.closed) return Promise.reject(new Error("隧道已关闭"));
    const id = `host-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`${channel} 超时`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this._write({ t: "req", id, ch: channel, args });
    });
  }

  /**
   * host -> webview push.
   *
   * `target` is the receiving window's label. Electron's `webContents.send`
   * reached exactly one window, so the target must be carried through: the host's
   * broadcast loop sends once per window, and fanning each of those out to every
   * window is what made streamed chat messages render twice.
   */
  emit(channel, args = [], target = null) {
    const message = { t: "ev", ch: channel, args };
    if (target) message.to = target;
    this._write(message);
  }

  /** Subscribe to shell -> host events. */
  on(channel, handler) {
    if (!this.listeners.has(channel)) this.listeners.set(channel, []);
    this.listeners.get(channel).push(handler);
    return () => {
      const list = this.listeners.get(channel) || [];
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    };
  }

  _write(message) {
    try {
      process.stdout.write(JSON.stringify(message) + "\n");
    } catch {
      // The shell is gone; nothing useful to do but let the app wind down.
      this.closed = true;
    }
  }

  _onLine(line) {
    const trimmed = String(line || "").trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`[host] 收到非法 JSON 行：${trimmed.slice(0, 200)}\n`);
      return;
    }
    if (msg.t === "res") {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.value);
      else entry.reject(new Error(msg.error || "未知错误"));
      return;
    }
    if (msg.t === "ev") {
      this._emit(msg.ch, Array.isArray(msg.args) ? msg.args : []);
      return;
    }
    if (msg.t === "req") {
      this._handleRequest(msg);
    }
  }

  /**
   * The shell asks us to run an IPC channel. The handler is supplied by host.js
   * (it owns the `ipcMain` registry), and the answer goes back as `res` — the
   * mirror image of how the shell answers our reverse calls.
   */
  _handleRequest(msg) {
    const id = msg.id;
    const channel = msg.ch;
    const args = Array.isArray(msg.args) ? msg.args : [];
    // `from` is the asking window's label, the counterpart of Electron's
    // `event.sender` — IPC modules use it to push progress back to the caller.
    const from = typeof msg.from === "string" ? msg.from : null;
    if (!this.requestHandler) {
      this._reply(id, false, null, `宿主尚未就绪，无法处理 ${channel}`);
      return;
    }
    Promise.resolve()
      .then(() => this.requestHandler(channel, args, from))
      .then(
        (value) => this._reply(id, true, value, null),
        (err) => this._reply(id, false, null, (err && err.message) || String(err))
      );
  }

  _reply(id, ok, value, error) {
    this._write(ok ? { t: "res", id, ok: true, value } : { t: "res", id, ok: false, error });
  }

  setRequestHandler(handler) {
    this.requestHandler = handler;
  }
}

module.exports = new Tunnel();
