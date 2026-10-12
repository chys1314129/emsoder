/** PTY bridge IPC handlers (agent terminal mirroring). */
function register(ipcMain, ctx) {
  const { ptyBridge } = ctx;

  ipcMain.handle("pty:set-preferred", (_e, id) => ptyBridge.setPreferred(id));
  ipcMain.handle("pty:get-preferred", () => ({
    id: ptyBridge.getPreferred(),
  }));
  ipcMain.handle("pty:mirror", (_e, text) => ptyBridge.write(text));
}

module.exports = { register };
