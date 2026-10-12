/** Native dialog IPC handlers. */
function register(ipcMain, ctx) {
  const { dialog, getWindow } = ctx;

  ipcMain.handle("dialog:message", async (_e, opts) => {
    const r = await dialog.showMessageBox(getWindow(), opts);
    return r;
  });
}

module.exports = { register };
