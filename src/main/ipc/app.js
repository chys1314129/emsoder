/** App state / lifecycle IPC handlers. */
function register(ipcMain, ctx) {
  const { cfg, sessions, publicConfig, publicSession, allowClose, showMainWindow } = ctx;

  ipcMain.handle("app:get-state", () => {
    const active = sessions?.getActive?.();
    return {
      config: publicConfig(cfg),
      session: active ? publicSession(active) : null,
      sessions: sessions
        ? sessions.list().map((s) => ({
            id: s.id,
            title: s.title,
            updatedAt: s.updatedAt,
          }))
        : [],
      workspace: active?.workspaceRoot || cfg.lastWorkspace || "",
    };
  });

  ipcMain.handle("app:allow-close", () => {
    allowClose();
    return { ok: true };
  });

  // 悬浮球点"显示主窗口"用
  ipcMain.handle("app:show-main", () => {
    if (typeof showMainWindow === "function") showMainWindow();
    return { ok: true };
  });
}

module.exports = { register };
