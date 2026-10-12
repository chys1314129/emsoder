/** Project rules IPC handlers. */
const { loadProjectRules } = require("../../tools/rules");

function register(ipcMain, ctx) {
  const { cfg } = ctx;

  ipcMain.handle("rules:list", async () => {
    const r = await loadProjectRules(cfg.lastWorkspace || "");
    return r;
  });
}

module.exports = { register };
