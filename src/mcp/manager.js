/**
 * MCP 管理器：持有所有 MCP server 客户端，聚合工具供 Agent 使用。
 * 工具全名格式：mcp__<serverId>__<toolName>
 */
const { McpStdioClient, McpHttpClient } = require("./client");

const TOOL_PREFIX = "mcp__";

function createClient(s, onStateChange, onToolsChange) {
  const opts = { onStateChange, onToolsChange };
  if (s.type === "http") return new McpHttpClient(s, opts);
  return new McpStdioClient(s, opts);
}

class McpManager {
  /**
   * @param {object} opts { onEvent({type, id, ...}) }
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.servers = new Map(); // id -> McpStdioClient
    this.cfg = null;
  }

  _emit(data) {
    try {
      this.opts.onEvent?.(data);
    } catch { /* ignore */ }
  }

  /** 按配置重建全部 server（启动 enabled，保持 disabled 停止） */
  reload(cfg) {
    this.cfg = cfg || this.cfg || {};
    const wanted = new Set();
    for (const s of Array.isArray(this.cfg.mcpServers) ? this.cfg.mcpServers : []) {
      if (!s || !s.id || (!s.command && !s.url)) continue;
      wanted.add(s.id);
      const existing = this.servers.get(s.id);
      if (existing) {
        const same =
          existing.cfg.command === s.command &&
          existing.cfg.url === s.url &&
          existing.cfg.type === s.type &&
          JSON.stringify(existing.cfg.args || []) === JSON.stringify(s.args || []) &&
          JSON.stringify(existing.cfg.env || {}) === JSON.stringify(s.env || {}) &&
          JSON.stringify(existing.cfg.headers || {}) === JSON.stringify(s.headers || {});
        if (!same) {
          try { existing.stop(); } catch { /* ignore */ }
          this.servers.delete(s.id);
        } else {
          existing.cfg = s; // 名称/启用/超时等元信息更新
          if (!s.enabled && existing.status !== "stopped") {
            try { existing.stop(); } catch { /* ignore */ }
          } else if (s.enabled && existing.status === "stopped") {
            this.connect(s.id).catch(() => { /* ignore */ });
          }
          continue;
        }
      }
      const client = createClient(
        s,
        (status, error) =>
          this._emit({ type: "status", id: s.id, status, error }),
        () => this._emit({ type: "tools", id: s.id, toolCount: client.toolCount })
      );
      this.servers.set(s.id, client);
      if (s.enabled !== false) {
        this.connect(s.id).catch(() => { /* ignore */ });
      }
    }
    // 移除配置里已删除的 server
    for (const [id, client] of this.servers) {
      if (!wanted.has(id)) {
        try { client.stop(); } catch { /* ignore */ }
        this.servers.delete(id);
      }
    }
  }

  startAll(cfg) {
    this.reload(cfg);
  }

  async connect(id) {
    const client = this.servers.get(id);
    if (!client) throw new Error("MCP server 不存在");
    if (client.status === "running" || client.status === "connecting") return;
    try {
      await client.start();
    } catch (e) {
      this._emit({ type: "status", id, status: "error", error: e.message || String(e) });
      throw e;
    }
  }

  disconnect(id) {
    const client = this.servers.get(id);
    if (!client) throw new Error("MCP server 不存在");
    client.stop();
    this._emit({ type: "status", id, status: "stopped", error: "" });
  }

  stopAll() {
    for (const [, client] of this.servers) {
      try { client.stop(); } catch { /* ignore */ }
    }
    this.servers.clear();
  }

  list() {
    const out = [];
    for (const [id, client] of this.servers) {
      out.push({
        id,
        name: client.cfg.name || id,
        type: client.cfg.type === "http" ? "http" : "stdio",
        command: client.cfg.command || "",
        args: Array.isArray(client.cfg.args) ? client.cfg.args : [],
        cwd: client.cfg.cwd || "",
        env: client.cfg.env || {},
        url: client.cfg.url || "",
        headers: client.cfg.headers || {},
        timeoutMs: client.cfg.timeoutMs || 30_000,
        enabled: client.cfg.enabled !== false,
        status: client.status,
        error: client.error || "",
        toolCount: client.toolCount,
        tools: Array.isArray(client._tools)
          ? client._tools.map((t) => ({
              name: t?.name || "",
              description: t?.description || "",
              fullName: `${TOOL_PREFIX}${id}__${t?.name || ""}`,
            }))
          : [],
      });
    }
    return out;
  }

  /** 全部运行中 server 的工具（OpenAI 函数格式，与 AGENT_TOOLS 同构） */
  getTools() {
    const out = [];
    for (const [, client] of this.servers) {
      if (client.status !== "running" || !Array.isArray(client._tools)) continue;
      for (const t of client._tools) {
        if (!t || !t.name) continue;
        out.push({
          type: "function",
          function: {
            name: `${TOOL_PREFIX}${client.cfg.id}__${t.name}`,
            description: t.description || `MCP 工具（${client.cfg.name || client.cfg.id}）`,
            parameters: t.inputSchema || { type: "object", properties: {} },
          },
        });
      }
    }
    return out;
  }

  /** 按全名 mcp__<serverId>__<tool> 调用；argsRaw 为 JSON 字符串 */
  async callTool(fullName, argsRaw) {
    const parts = String(fullName || "").split("__");
    if (parts.length < 3 || parts[0] !== "mcp") {
      return { ok: false, content: `未知 MCP 工具: ${fullName}`, isError: true };
    }
    const serverId = parts[1];
    const toolName = parts.slice(2).join("__");
    const client = this.servers.get(serverId);
    if (!client) {
      return { ok: false, content: `MCP server 不存在: ${serverId}`, isError: true };
    }
    let args = {};
    try {
      args = argsRaw ? JSON.parse(argsRaw) : {};
    } catch {
      return { ok: false, content: `Invalid JSON arguments: ${argsRaw}`, isError: true };
    }
    return client.callTool(toolName, args);
  }
}

module.exports = { McpManager, TOOL_PREFIX };
