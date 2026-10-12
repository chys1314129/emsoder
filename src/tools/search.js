const fs = require("fs/promises");
const path = require("path");
const { isHeavyDirName, resolveSafePath } = require("./paths");

/**
 * 扩展名/子串过滤（供 search 的「扩展过滤」输入使用，UI placeholder: .js / .ts）：
 * - 以 "." 开头（含 "*.js"、"*.ts" 归一化后）→ 文件名必须以该扩展名结尾（大小写不敏感）
 * - 其余（如 "test"、"config"）→ 文件名包含该子串即匹配（大小写不敏感）
 * 修复原实现：".ts" 会被误判为「文件名任意位置含 ts 子串」（atoms.js/tsconfig.json 误匹配）
 */
function matchesGlob(name, glob) {
  const g = String(glob || "").trim();
  if (!g) return true;
  const norm = g.replace(/^\*\./, ".");
  const lowerName = name.toLowerCase();
  if (norm.startsWith(".")) {
    return lowerName.endsWith(norm.toLowerCase());
  }
  return lowerName.includes(norm.toLowerCase());
}

/**
 * Recursive text search under workspace.
 */
async function searchWorkspace(workspaceRoot, options = {}) {
  const query = String(options.query || "");
  if (!query) return { ok: false, error: "query is empty", results: [] };
  if (!workspaceRoot) {
    return { ok: false, error: "未打开工作区", results: [] };
  }

  const baseRes = resolveSafePath(workspaceRoot, options.path || ".");
  if (!baseRes.ok) return { ok: false, error: baseRes.error, results: [] };

  const maxResults = Number(options.maxResults) > 0 ? Number(options.maxResults) : 50;
  const glob = options.glob ? String(options.glob).trim() : "";
  const results = [];
  const q = query.toLowerCase();

  async function walk(dir, depth) {
    if (results.length >= maxResults || depth > 10) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= maxResults) break;
      if (e.isDirectory()) {
        if (isHeavyDirName(e.name) || (e.name.startsWith(".") && e.name !== ".github")) {
          continue;
        }
        await walk(path.join(dir, e.name), depth + 1);
        continue;
      }
      if (glob && !matchesGlob(e.name, glob)) continue;
      const fp = path.join(dir, e.name);
      try {
        const stat = await fs.stat(fp);
        if (stat.size > 512 * 1024) continue;
        const text = await fs.readFile(fp, "utf8");
        // skip likely binary
        if (text.includes("\u0000")) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(q)) {
            results.push({
              path: fp,
              relative: path.relative(workspaceRoot, fp),
              line: i + 1,
              text: lines[i].trim().slice(0, 240),
            });
            if (results.length >= maxResults) break;
          }
        }
      } catch {
        /* unreadable */
      }
    }
  }

  await walk(baseRes.absolute, 0);
  return { ok: true, results, query, root: baseRes.absolute };
}

module.exports = { searchWorkspace, matchesGlob };
