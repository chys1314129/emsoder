#!/usr/bin/env node
/**
 * Smoke test for read_document and image search/download guards.
 * Document generation is intentionally delegated to installed Skills.
 * Usage: node scripts/test-documents.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}

async function main() {
  const { readDocument } = require("../src/tools/documentReader");
  const im = require("../src/tools/imageSearch");
  const ExcelJS = require("exceljs");
  const { resolveSafePath } = require("../src/tools/paths");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "emsoder-doc-read-"));
  const ctx = { workspaceRoot: root, onFsChange() {} };
  try {
    fs.mkdirSync(path.join(root, "exports"), { recursive: true });
    fs.writeFileSync(path.join(root, "exports", "notes.csv"), "姓名,分数\n甲,90\n乙,85\n", "utf8");

    let r = await readDocument(ctx, root, { path: "exports/notes.csv" });
    assert(r.ok, "csv read ok");
    assert(r.content.includes("姓名,分数"), "csv content returned");

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("数据");
    ws.addRow(["项目", "数量"]);
    ws.addRow(["A", 12]);
    await wb.xlsx.writeFile(path.join(root, "exports", "data.xlsx"));
    r = await readDocument(ctx, root, { path: "exports/data.xlsx" });
    assert(r.ok, "xlsx read ok");
    assert(r.content.includes("# 工作表: 数据"), "sheet name returned");
    assert(r.content.includes("项目,数量"), "xlsx row returned");

    r = await readDocument(ctx, root, { path: "missing.docx" });
    assert(!r.ok && /not found/i.test(r.content), "missing file rejected");

    // image search/download guards stay available for skills
    let s = await im.searchImages({ imageProvider: "pexels", pexelsApiKey: "" }, { query: "cat" });
    assert(!s.ok && /未配置/.test(s.content), "no key -> clear error");
    s = await im.searchImages({ imageProvider: "pexels", pexelsApiKey: "x" }, { query: "" });
    assert(!s.ok && /关键词/.test(s.content), "empty query rejected");
    let d = await im.downloadImage(ctx, root, { url: "file:///etc/passwd" });
    assert(!d.ok && /http/.test(d.content), "non-http rejected");
    d = await im.downloadImage(ctx, "", { url: "https://x/y.png" });
    assert(!d.ok && /工作区/.test(d.content), "no workspace rejected");
    assert(im.activeImageProvider({ imageProvider: "unsplash" }) === "unsplash", "provider resolves");

    // skill directory sandbox remains bounded
    const skill = path.join("C:", "skills", "ppt-master");
    let p = resolveSafePath(root, path.join(skill, "scripts", "x.py"));
    assert(!p.ok, "skill path blocked without allowedRoots");
    p = resolveSafePath(root, path.join(skill, "scripts", "x.py"), { allowedRoots: [skill] });
    assert(p.ok, "skill path allowed with allowedRoots");
    p = resolveSafePath(root, "../escape", { allowedRoots: [skill] });
    assert(!p.ok, "parent escape still blocked");
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  console.log("OK document reading + image tools smoke test");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
