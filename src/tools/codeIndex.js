const fs = require("fs/promises");
const path = require("path");
const { isHeavyDirName } = require("./paths");

const CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".html",
  ".htm",
]);

/**
 * Walk workspace for source files usable by Monaco TS/JS language service.
 */
async function listCodeFiles(workspaceRoot, options = {}) {
  if (!workspaceRoot) return { ok: false, files: [], error: "未打开工作区" };
  const maxFiles = Number(options.maxFiles) > 0 ? Number(options.maxFiles) : 350;
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : 400_000;
  const maxDepth = Number(options.maxDepth) > 0 ? Number(options.maxDepth) : 8;
  const files = [];

  async function walk(dir, depth) {
    if (files.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= maxFiles) break;
      if (e.isDirectory()) {
        if (isHeavyDirName(e.name)) continue;
        if (e.name.startsWith(".") && e.name !== ".github") continue;
        await walk(path.join(dir, e.name), depth + 1);
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      if (!CODE_EXTS.has(ext)) continue;
      // skip huge generated maps / lock-like
      if (e.name.endsWith(".min.js") || e.name.endsWith(".map")) continue;
      if (e.name === "package-lock.json" || e.name === "yarn.lock") continue;
      const abs = path.join(dir, e.name);
      try {
        const st = await fs.stat(abs);
        if (!st.isFile() || st.size > maxBytes) continue;
        files.push({
          path: abs,
          relative: path.relative(workspaceRoot, abs).replace(/\\/g, "/"),
          size: st.size,
          ext,
        });
      } catch {
        /* ignore */
      }
    }
  }

  await walk(path.resolve(workspaceRoot), 0);
  return { ok: true, files, root: workspaceRoot };
}

module.exports = { listCodeFiles, CODE_EXTS };
