/** MCP server CRUD / connection IPC handlers. */
const { saveConfig } = require("../../core/config");
const { publicMcp } = require("../credentialCatalog");

function register(ipcMain, ctx) {
  const { cfg, mcpManager, assertTrustedSender } = ctx;

  // ── MCP ────────────────────────────────────────────────────────────
  function mcpServerList() {
    return Array.isArray(mcpManager?.list?.()) ? mcpManager.list() : [];
  }

  ipcMain.handle("mcp:list", (event) => {
    assertTrustedSender?.(event);
    return { ok: true, servers: mcpServerList().map(publicMcp) };
  });

  ipcMain.handle("mcp:upsert", (event, server = {}) => {
    assertTrustedSender?.(event);
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
    const previous = rawList.find((p) => p && p.id === id) || {};
    const preserveMasked = (incoming, existing) => {
      const out = {};
      for (const [key, value] of Object.entries(incoming || {})) {
        out[key] = value === "***" ? (existing?.[key] || "") : value;
      }
      return out;
    };
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
          ? preserveMasked(server.env, previous.env)
          : {},
      url: type === "http" ? url : "",
      headers:
        server.headers && typeof server.headers === "object" && !Array.isArray(server.headers)
          ? preserveMasked(server.headers, previous.headers)
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
    return { ok: true, servers: mcpServerList().map(publicMcp) };
  });

  ipcMain.handle("mcp:remove", (event, id) => {
    assertTrustedSender?.(event);
    cfg.mcpServers = (Array.isArray(cfg.mcpServers) ? cfg.mcpServers : []).filter(
      (p) => p && p.id !== id
    );
    saveConfig(cfg);
    try {
      mcpManager?.reload(cfg);
    } catch { /* ignore */ }
    return { ok: true, servers: mcpServerList().map(publicMcp) };
  });

  ipcMain.handle("mcp:connect", async (_e, id) => {
    try {
      await mcpManager?.connect(id);
      return { ok: true, servers: mcpServerList().map(publicMcp) };
    } catch (e) {
      return { ok: false, error: e.message || String(e), servers: mcpServerList() };
    }
  });

  ipcMain.handle("mcp:disconnect", (_e, id) => {
    try {
      mcpManager?.disconnect(id);
    } catch { /* ignore */ }
    return { ok: true, servers: mcpServerList().map(publicMcp) };
  });
}

module.exports = { register };
