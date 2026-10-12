/** Node debugger IPC handlers. */
function register(ipcMain, ctx) {
  const { cfg, nodeDebugger } = ctx;

  ipcMain.handle("debug:state", () => nodeDebugger.state);
  ipcMain.handle("debug:launch", async (_e, opts) => {
    try {
      return await nodeDebugger.launch({
        program: opts?.program,
        args: opts?.args || [],
        cwd: opts?.cwd || cfg.lastWorkspace || process.cwd(),
      });
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle("debug:stop", async () => nodeDebugger.stop());
  ipcMain.handle("debug:continue", async () => {
    try {
      return await nodeDebugger.continue();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("debug:pause", async () => {
    try {
      return await nodeDebugger.pause();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("debug:step-over", async () => {
    try {
      return await nodeDebugger.stepOver();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("debug:step-into", async () => {
    try {
      return await nodeDebugger.stepInto();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("debug:step-out", async () => {
    try {
      return await nodeDebugger.stepOut();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("debug:evaluate", async (_e, { expression, callFrameId }) => {
    try {
      return await nodeDebugger.evaluate(expression, callFrameId);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("debug:set-breakpoint", (_e, { path: filePath, line }) =>
    nodeDebugger.setBreakpoint(filePath, line)
  );
  ipcMain.handle("debug:remove-breakpoint", (_e, { path: filePath, line }) =>
    nodeDebugger.removeBreakpoint(filePath, line)
  );
  ipcMain.handle("debug:clear-breakpoints", () =>
    nodeDebugger.clearBreakpoints()
  );
  ipcMain.handle("debug:list-breakpoints", () => ({
    breakpoints: nodeDebugger.listBreakpoints(),
  }));
}

module.exports = { register };
