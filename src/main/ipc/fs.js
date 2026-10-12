/** Filesystem IPC handlers (read-dir / read-file / write-file / pick-attach / search / etc). */
const path = require("path");
const fs = require("fs/promises");
const { isHeavyDirName } = require("../../tools/paths");
const { searchWorkspace } = require("../../tools/search");
const { listCodeFiles } = require("../../tools/codeIndex");

function register(ipcMain, ctx) {
  const {
    cfg,
    assertTrustedSender,
    isAllowedFile,
    assertAllowedDir,
    dialog,
    getWindow,
    openFileDialog,
  } = ctx;

  /** Walk workspace for @-mention autocomplete (lightweight: paths + dirs). */
  ipcMain.handle("fs:walk-files", async (event, opts = {}) => {
    assertTrustedSender(event);
    const root = cfg.lastWorkspace || "";
    if (!root) return { ok: false, files: [], error: "未打开工作区" };
    const max = Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : 600;
    const maxDepth = Number(opts.maxDepth) > 0 ? Number(opts.maxDepth) : 10;
    const files = [];
    const dirs = [];
    const walk = async (dir, depth) => {
      if (files.length + dirs.length >= max || depth > maxDepth) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch { return; }
      for (const e of entries) {
        if (files.length + dirs.length >= max) break;
        if (e.name.startsWith(".") && e.name !== ".github") continue;
        if (isHeavyDirName(e.name)) continue;
        const abs = path.join(dir, e.name);
        const rel = path.relative(root, abs).replace(/\\/g, "/");
        if (e.isDirectory()) {
          dirs.push({ path: rel, isDirectory: true });
          await walk(abs, depth + 1);
        } else {
          files.push({ path: rel, isDirectory: false, ext: path.extname(e.name).toLowerCase() });
        }
      }
    };
    await walk(root, 0);
    return { ok: true, files, dirs, root };
  });

  ipcMain.handle("fs:read-dir", async (event, dirPath) => {
    assertTrustedSender(event);
    const root = assertAllowedDir(dirPath);
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => {
        if (e.name === ".gitignore" || e.name === ".env.example") return true;
        if (e.name.startsWith(".") && e.name !== ".github") return false;
        return true;
      })
      .map((e) => ({
        name: e.name,
        path: path.join(root, e.name),
        isDirectory: e.isDirectory(),
        heavy: e.isDirectory() && isHeavyDirName(e.name),
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  });

  ipcMain.handle("fs:read-file", async (event, filePath) => {
    assertTrustedSender(event);
    if (typeof filePath !== "string" || !filePath) throw new Error("非法路径");
    if (!isAllowedFile(filePath)) {
      throw new Error("越界：只能读取工作区内或已打开过的文件");
    }
    const abs = path.resolve(filePath);
    const stat = await fs.stat(abs);
    if (stat.size > 2 * 1024 * 1024) {
      throw new Error("文件过大（>2MB），请用外部编辑器打开");
    }
    const buf = await fs.readFile(abs);
    if (buf.includes(0)) {
      throw new Error("二进制文件，无法作为文本打开");
    }
    const content = buf.toString("utf8");
    return { path: abs, content, size: stat.size };
  });

  ipcMain.handle("fs:write-file", async (event, { filePath, content }) => {
    assertTrustedSender(event);
    if (typeof filePath !== "string" || !filePath) throw new Error("非法路径");
    if (typeof content !== "string") throw new Error("非法内容");
    if (!isAllowedFile(filePath)) {
      throw new Error("越界：只能保存工作区内或已打开过的文件");
    }
    const abs = path.resolve(filePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return { ok: true, path: abs };
  });

  ipcMain.handle("fs:open-dialog", async (event) => {
    assertTrustedSender(event);
    const files = await openFileDialog();
    if (files?.length) {
      getWindow()?.webContents.send("files:open", files);
    }
    return files;
  });

  /** Pick files as chat attachments (do NOT open in editor) */
  ipcMain.handle("fs:pick-attach", async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      properties: ["openFile", "multiSelections"],
      defaultPath: cfg.lastWorkspace || undefined,
      filters: [
        {
          name: "Code & text",
          extensions: [
            "js",
            "ts",
            "tsx",
            "jsx",
            "json",
            "md",
            "txt",
            "py",
            "go",
            "rs",
            "java",
            "c",
            "cpp",
            "h",
            "cs",
            "css",
            "html",
            "vue",
            "yml",
            "yaml",
            "toml",
            "xml",
            "sql",
            "sh",
            "bat",
            "ps1",
            "log",
          ],
        },
        {
          name: "Images (vision)",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"],
        },
        { name: "All", extensions: ["*"] },
      ],
    });
    if (res.canceled || !res.filePaths?.length) return [];
    const out = [];
    const imageMime = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
    };
    for (const filePath of res.filePaths.slice(0, 8)) {
      try {
        const stat = await fs.stat(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const isImage = !!imageMime[ext];
        let content = "";
        let kind = isImage ? "image" : "text";
        let dataUrl = "";
        let mime = "";
        if (isImage) {
          // vision: embed as base64 data URL (cap ~4MB file)
          if (stat.size > 4 * 1024 * 1024) {
            kind = "path";
            content = `(图片过大 ${(stat.size / 1024 / 1024).toFixed(1)}MB，未嵌入，仅路径)`;
          } else {
            const buf = await fs.readFile(filePath);
            mime = imageMime[ext] || "image/png";
            dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
            content = ""; // never dump base64 into chat text
          }
        } else if (stat.size > 256 * 1024) {
          content = `(文件过大 ${(stat.size / 1024).toFixed(0)}KB，仅附路径，未内嵌内容)`;
          kind = "path";
        } else {
          const buf = await fs.readFile(filePath);
          if (buf.includes(0)) {
            content = "(二进制文件，仅附路径)";
            kind = "path";
          } else {
            content = buf.toString("utf8");
          }
        }
        out.push({
          path: filePath,
          name: path.basename(filePath),
          size: stat.size,
          kind,
          content,
          dataUrl,
          mime,
        });
      } catch (e) {
        out.push({
          path: filePath,
          name: path.basename(filePath),
          size: 0,
          kind: "path",
          content: "",
          dataUrl: "",
          mime: "",
          error: e.message || String(e),
        });
      }
    }
    return out;
  });

  ipcMain.handle("fs:search", async (event, opts) => {
    assertTrustedSender(event);
    return searchWorkspace(cfg.lastWorkspace || "", opts || {});
  });

  ipcMain.handle("fs:list-code-files", async (event, opts) => {
    assertTrustedSender(event);
    return listCodeFiles(cfg.lastWorkspace || "", opts || {});
  });
}

module.exports = { register };
