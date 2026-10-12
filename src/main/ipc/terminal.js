/** Terminal (real PTY) IPC handlers. */
const { executionEnv } = require("../../tools/skillRuntime");
function register(ipcMain, ctx) {
  const { cfg, terminals } = ctx;

  ipcMain.handle("term:create", (_e, size) =>
    terminals.create(cfg.lastWorkspace || process.cwd(), size || {}, executionEnv(cfg))
  );
  ipcMain.handle("term:list", () => terminals.list());
  ipcMain.handle("term:write", (_e, { id, data }) =>
    terminals.write(id, data)
  );
  ipcMain.handle("term:resize", (_e, { id, cols, rows }) =>
    terminals.resize(id, cols, rows)
  );
  ipcMain.handle("term:interrupt", (_e, id) => terminals.interrupt(id));
  ipcMain.handle("term:kill", (_e, id) => terminals.kill(id));
  ipcMain.handle("term:dispose", (_e, id) => terminals.dispose(id));
  // legacy line-run: write command + Enter
  ipcMain.handle("term:run", async (_e, { id, command }) => {
    const cmd = String(command || "");
    if (!cmd) return { ok: true };
    return terminals.write(
      id,
      cmd.endsWith("\r") || cmd.endsWith("\n") ? cmd : cmd + "\r"
    );
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
}

module.exports = { register };
