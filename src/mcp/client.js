/**
 * Lightweight MCP (Model Context Protocol) clients.
 * - McpStdioClient: JSON-RPC 2.0 over newline-delimited stdio.
 * - McpHttpClient:  JSON-RPC 2.0 over streamable HTTP (POST, session-id header).
 * Zero dependencies — uses global fetch (Electron main process has it).
 */
const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");
const fs = require("fs");

const PROTOCOL_VERSION = "2024-11-05";
const HANDSHAKE_TIMEOUT_MS = 15_000;
const TOOLS_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/** win32 下解析 PATH，给命令补扩展名（npx → npx.cmd） */
function resolveCommand(command) {
  if (process.platform !== "win32") return command;
  if (/\.[a-z0-9]{1,4}$/i.test(command) || command.includes(path.sep)) return command;
  const dirs = (process.env.PATH || "").split(";").filter(Boolean);
  for (const ext of [".cmd", ".bat", ".exe"]) {
    for (const dir of dirs) {
      const full = path.join(dir, command + ext);
      try {
        if (fs.existsSync(full)) return full;
      } catch { /* ignore */ }
    }
  }
  return command;
}

class McpStdioClient {
  /**
   * @param {object} cfg { id, name, command, args, env, cwd }
   * @param {object} opts { onStateChange(status, error), onToolsChange(tools) }
   */
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.opts = opts;
    this.status = "stopped"; // stopped | connecting | running | error
    this.error = "";
    this.child = null;
    this.rl = null;
    this._reqId = 0;
    this._pending = new Map(); // id -> { resolve, reject, timer, label }
    this._tools = null;
    this._stderrBuf = "";
    this._exiting = false;
  }

  _setStatus(status, error = "") {
    this.status = status;
    this.error = error || "";
    try {
      this.opts.onStateChange?.(this.status, this.error);
    } catch { /* ignore */ }
  }

  get toolCount() {
    return Array.isArray(this._tools) ? this._tools.length : 0;
  }

  async start() {
    if (this.child) return;
    this._setStatus("connecting");
    await new Promise((resolve, reject) => {
      const cmd = resolveCommand(this.cfg.command || "");
      if (!cmd) {
        this._setStatus("error", "命令为空");
        reject(new Error("命令为空"));
        return;
      }
      let child;
      try {
        child = spawn(cmd, Array.isArray(this.cfg.args) ? this.cfg.args : [], {
          cwd: this.cfg.cwd || undefined,
          env: { ...process.env, ...(this.cfg.env || {}) },
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        });
      } catch (e) {
        this._setStatus("error", e.message || String(e));
        reject(e);
        return;
      }
      this.child = child;

      let settled = false;
      const fail = (msg) => {
        if (settled) return;
        settled = true;
        this._setStatus("error", msg);
        reject(new Error(msg));
      };
      const timeout = setTimeout(() => {
        this._kill();
        fail(`启动超时（${HANDSHAKE_TIMEOUT_MS / 1000}s）`);
      }, HANDSHAKE_TIMEOUT_MS);

      child.on("error", (e) => {
        clearTimeout(timeout);
        fail(`无法启动 ${cmd}: ${e.message}`);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timeout);
        if (this._exiting) return;
        this._failAll("server 退出");
        this._setStatus("error", `进程退出 (${signal || code})`);
        this.child = null;
        this.rl = null;
      });

      this.rl = readline.createInterface({ input: child.stdout });
      this.rl.on("line", (line) => this._onLine(line));
      child.stderr.on("data", (d) => {
        this._stderrBuf = (this._stderrBuf + String(d)).slice(-4000);
      });

      // handshake
      this._request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        clientInfo: { name: "EMSoder", version: "2.0.0" },
      }, HANDSHAKE_TIMEOUT_MS)
        .then((res) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            this._notify("notifications/initialized", {});
            this._setStatus("running");
            // 立即拉一次工具列表（失败不阻塞状态）
            this.refreshTools().catch(() => { /* ignore */ });
            resolve(res);
          }
        })
        .catch((e) => fail(e.message || String(e)));
    });
  }

  _onLine(line) {
    const t = String(line || "").trim();
    if (!t) return;
    let msg;
    try {
      msg = JSON.parse(t);
    } catch {
      return; // 非 JSON 行忽略
    }
    if (!msg || typeof msg !== "object") return;

    // 服务端主动通知（notifications / 响应）
    if (msg.id !== undefined && msg.id !== null) {
      const pending = this._pending.get(String(msg.id));
      if (!pending) return;
      this._pending.delete(String(msg.id));
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || "JSON-RPC error"));
      } else {
        pending.resolve(msg.result);
      }
    } else if (msg.method === "notifications/tools/list_changed") {
      this.refreshTools().catch(() => { /* ignore */ });
      try {
        this.opts.onToolsChange?.();
      } catch { /* ignore */ }
    }
  }

  _request(method, params, timeoutMs) {
    if (!this.child || this.status === "error" || this.status === "stopped") {
      return Promise.reject(new Error("MCP server 未连接"));
    }
    const id = ++this._reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(String(id));
        reject(new Error(`${method} 超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      this._pending.set(String(id), { resolve, reject, timer, method });
      const payload = { jsonrpc: "2.0", id, method, params };
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  _notify(method, params) {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  _failAll(msg) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error(msg));
    }
    this._pending.clear();
  }

  async refreshTools() {
    if (this.status !== "running") return [];
    const res = await this._request("tools/list", {}, TOOLS_TIMEOUT_MS);
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    this._tools = tools;
    try {
      this.opts.onToolsChange?.(tools);
    } catch { /* ignore */ }
    return tools;
  }

  async callTool(name, args) {
    if (this.status !== "running") {
      return { ok: false, content: "MCP server 未连接", isError: true };
    }
    try {
      const res = await this._request("tools/call", { name, arguments: args || {} }, CALL_TIMEOUT_MS);
      const parts = Array.isArray(res?.content) ? res.content : [];
      const text = parts
        .map((c) => {
          if (!c) return "";
          if (c.type === "text") return String(c.text || "");
          if (c.type === "image") return `[图片 ${c.mimeType || "image"}，长度 ${String(c.data || "").length}]`;
          if (c.type === "resource") {
            return `[资源 ${c.resource?.uri || ""}]`;
          }
          return `[${c.type}]`;
        })
        .filter(Boolean)
        .join("\n");
      return { ok: true, content: text || "(无返回内容)", isError: !!res.isError };
    } catch (e) {
      return { ok: false, content: e.message || String(e), isError: true };
    }
  }

  async ping() {
    return this._request("ping", {}, TOOLS_TIMEOUT_MS);
  }

  stop() {
    this._exiting = true;
    this._kill();
    this._failAll("已停止");
    this._setStatus("stopped");
    this.child = null;
    this.rl = null;
    this._tools = null;
    this._exiting = false;
  }

  _kill() {
    if (!this.child) return;
    try {
      if (process.platform === "win32" && this.child.pid) {
        spawn("taskkill", ["/pid", String(this.child.pid), "/f", "/t"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        this.child.kill("SIGTERM");
      }
    } catch { /* ignore */ }
  }
}

/**
 * streamable HTTP MCP client（2025-03-26 传输）：
 * 请求-响应走 POST，响应头 Mcp-Session-Id 带回给后续请求；
 * 响应体为 JSON 直接解析，为 event-stream 时解析 event: message。
 */
class McpHttpClient {
  /**
   * @param {object} cfg { id, name, type:"http", url, headers, timeoutMs }
   * @param {object} opts { onStateChange(status, error), onToolsChange(tools) }
   */
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.opts = opts;
    this.status = "stopped";
    this.error = "";
    this.sessionId = null;
    this._reqId = 0;
    this._tools = null;
    this._fetch = typeof fetch === "function" ? fetch : null;
  }

  _setStatus(status, error = "") {
    this.status = status;
    this.error = error || "";
    try {
      this.opts.onStateChange?.(this.status, this.error);
    } catch { /* ignore */ }
  }

  get toolCount() {
    return Array.isArray(this._tools) ? this._tools.length : 0;
  }

  _timeout() {
    const t = Number(this.cfg.timeoutMs);
    if (Number.isFinite(t) && t > 0) return Math.min(300_000, Math.max(1_000, t));
    return DEFAULT_TIMEOUT_MS;
  }

  async start() {
    if (this.status === "running" || this.status === "connecting") return;
    this._setStatus("connecting");
    if (!this._fetch) {
      this._setStatus("error", "当前环境不支持 fetch");
      throw new Error("当前环境不支持 fetch");
    }
    try {
      const res = await this._request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        clientInfo: { name: "EMSoder", version: "2.0.0" },
      }, HANDSHAKE_TIMEOUT_MS);
      this._notify("notifications/initialized", {});
      this._setStatus("running");
      this.refreshTools().catch(() => { /* ignore */ });
      return res;
    } catch (e) {
      this._setStatus("error", e.message || String(e));
      throw e;
    }
  }

  async _post(payload, timeoutMs) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": PROTOCOL_VERSION,
      ...(this.cfg.headers || {}),
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await this._fetch(this.cfg.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const sid = resp.headers?.get?.("mcp-session-id");
      if (sid) this.sessionId = sid;
      const ctype = String(resp.headers?.get?.("content-type") || "");
      let text = "";
      try {
        text = await resp.text();
      } catch (e) {
        throw new Error(`读取响应失败: ${e.message}`);
      }
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
      }
      if (/text\/event-stream/i.test(ctype)) {
        // 从 SSE 流里提取最后一个 event: message 的 data
        let data = "";
        for (const line of text.split(/\r?\n/)) {
          if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        return data ? JSON.parse(data) : null;
      }
      return text ? JSON.parse(text) : null;
    } catch (e) {
      if (e?.name === "AbortError") {
        throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async _request(method, params, timeoutMs) {
    const id = ++this._reqId;
    const res = await this._post(
      { jsonrpc: "2.0", id, method, params },
      timeoutMs || this._timeout()
    );
    if (res?.error) {
      throw new Error(res.error.message || "JSON-RPC error");
    }
    return res?.result;
  }

  _notify(method, params) {
    // 通知类请求：发送后忽略响应（可能 202/204 或空）
    const id = ++this._reqId;
    this._post({ jsonrpc: "2.0", id, method, params }, this._timeout()).catch(
      () => { /* ignore */ }
    );
  }

  async refreshTools() {
    if (this.status !== "running") return [];
    const res = await this._request("tools/list", {}, TOOLS_TIMEOUT_MS);
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    this._tools = tools;
    try {
      this.opts.onToolsChange?.(tools);
    } catch { /* ignore */ }
    return tools;
  }

  async callTool(name, args) {
    if (this.status !== "running") {
      return { ok: false, content: "MCP server 未连接", isError: true };
    }
    try {
      const res = await this._request("tools/call", { name, arguments: args || {} }, CALL_TIMEOUT_MS);
      const parts = Array.isArray(res?.content) ? res.content : [];
      const text = parts
        .map((c) => {
          if (!c) return "";
          if (c.type === "text") return String(c.text || "");
          if (c.type === "image") return `[图片 ${c.mimeType || "image"}，长度 ${String(c.data || "").length}]`;
          if (c.type === "resource") return `[资源 ${c.resource?.uri || ""}]`;
          return `[${c.type}]`;
        })
        .filter(Boolean)
        .join("\n");
      return { ok: true, content: text || "(无返回内容)", isError: !!res.isError };
    } catch (e) {
      return { ok: false, content: e.message || String(e), isError: true };
    }
  }

  async ping() {
    return this._request("ping", {}, this._timeout());
  }

  stop() {
    this._setStatus("stopped");
    this.sessionId = null;
    this._tools = null;
  }
}

module.exports = {
  McpStdioClient,
  McpHttpClient,
  resolveCommand,
  PROTOCOL_VERSION,
  DEFAULT_TIMEOUT_MS,
};
