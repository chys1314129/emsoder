/** Long-term memory CRUD IPC handlers. */
function register(ipcMain, ctx) {
  const { cfg, sessions, memoryStore } = ctx;

  ipcMain.handle("memory:list", (_e, opts) => {
    try {
      return { ok: true, memories: memoryStore?.list(opts || {}) || [] };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle("memory:add", (_e, mem) => {
    try {
      return { ok: true, memory: memoryStore.add(mem) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle("memory:update", (_e, { id, patch }) => {
    try {
      const m = memoryStore.update(id, patch);
      return m ? { ok: true, memory: m } : { ok: false, error: "not found" };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle("memory:remove", (_e, { id }) => {
    try {
      return { ok: memoryStore.remove(id) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle("memory:search", (_e, { query, topK }) => {
    try {
      return { ok: true, memories: memoryStore.search(query, { topK }) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle("memory:extract-now", async (_e) => {
    try {
      const added = await memoryStore.extractFromSession(
        sessions.getActive(),
        cfg
      );
      return { ok: true, added };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle("memory:clear", () => {
    try {
      memoryStore.clear();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

module.exports = { register };
