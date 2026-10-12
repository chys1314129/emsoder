/** Git IPC handlers (pure delegation to tools/git.js). */
const git = require("../../tools/git");

function register(ipcMain, ctx) {
  const { cfg, dialog, getWindow } = ctx;

  ipcMain.handle("git:status", async () =>
    git.getStatus(cfg.lastWorkspace || "")
  );
  ipcMain.handle("git:diff", async (_e, opts) =>
    git.getDiff(cfg.lastWorkspace || "", opts || {})
  );
  ipcMain.handle("git:stage", async (_e, filePath) =>
    git.stage(cfg.lastWorkspace || "", filePath)
  );
  ipcMain.handle("git:unstage", async (_e, filePath) =>
    git.unstage(cfg.lastWorkspace || "", filePath)
  );
  ipcMain.handle("git:discard", async (_e, filePath) => {
    const r = await dialog.showMessageBox(getWindow(), {
      type: "warning",
      buttons: ["取消", "丢弃更改"],
      defaultId: 0,
      cancelId: 0,
      message: `丢弃对 ${filePath} 的未提交修改？`,
      detail: "此操作不可撤销。",
    });
    if (r.response !== 1) return { ok: false, cancelled: true };
    return git.discard(cfg.lastWorkspace || "", filePath);
  });
  ipcMain.handle("git:commit", async (_e, message) =>
    git.commit(cfg.lastWorkspace || "", message)
  );
  ipcMain.handle("git:log", async (_e, limit) =>
    git.getLog(cfg.lastWorkspace || "", limit || 20)
  );
}

module.exports = { register };
