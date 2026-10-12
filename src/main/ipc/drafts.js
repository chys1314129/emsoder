/** Dirty draft recovery IPC handlers (pure fs). */
const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { draftsPath } = require("./_shared");

function register(ipcMain, _ctx) {
  ipcMain.handle("drafts:save", (_e, drafts) => {
    try {
      const p = draftsPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const list = Array.isArray(drafts) ? drafts.slice(0, 30) : [];
      const tmp = p + ".tmp";
      fs.writeFileSync(
        tmp,
        JSON.stringify({ savedAt: Date.now(), drafts: list }, null, 2),
        "utf8"
      );
      fs.renameSync(tmp, p);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("drafts:load", () => {
    try {
      const p = draftsPath();
      if (!fs.existsSync(p)) return { drafts: [] };
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      return {
        drafts: Array.isArray(data.drafts) ? data.drafts : [],
        savedAt: data.savedAt,
      };
    } catch {
      return { drafts: [] };
    }
  });

  ipcMain.handle("drafts:clear", () => {
    try {
      const p = draftsPath();
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

module.exports = { register };
