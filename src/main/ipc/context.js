/** Context stats IPC handlers. */
const {
  tracker: contextStats,
  formatContextLabel,
  formatCacheLabel,
  resolveContextWindow,
} = require("../../core/contextStats");
const { getActiveModel } = require("../../core/config");

function register(ipcMain, ctx) {
  const { cfg } = ctx || {};
  ipcMain.handle("context:stats", () => {
    const snap = contextStats.getSnapshot();
    // 还没有任何请求样本时（刚启动/重启后），getSnapshot 只会回退到
    // 128k 默认值——这里改用用户配置的 contextWindow / 模型窗口解析，
    // 让底栏显示真实生效的容量而不是 128k。
    if (!contextStats.last && !contextStats.lastEstimate && cfg) {
      const win = resolveContextWindow(getActiveModel(cfg), cfg);
      if (win > 0) {
        snap.contextWindow = win;
        const used = snap.usedTokens || 0;
        snap.fillRatio = win > 0 ? used / win : 0;
        snap.fillPercent = Math.round((used / Math.max(1, win)) * 1000) / 10;
      }
    }
    return {
      ...snap,
      labelContext: formatContextLabel(snap),
      labelCache: formatCacheLabel(snap),
    };
  });

  // tsconfig / LSP project options lives here too (single handler)
  const { loadWorkspaceTsconfig } = require("../../tools/tsconfig");
  ipcMain.handle("lsp:tsconfig", async (_e) => {
    const { cfg } = _ctx || {};
    return loadWorkspaceTsconfig(cfg?.lastWorkspace || "");
  });
}

module.exports = { register };
