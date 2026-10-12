/**
 * Read Office documents as text for the Agent.
 * Generation lives in installed skills; this module only preserves local reading.
 */
const fs = require("fs/promises");
const path = require("path");
const { resolveSafePath } = require("./paths");

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function readDocument(ctx, root, args) {
  const relPath = String(args.path || args.filename || "").trim();
  if (!relPath) return { ok: false, content: "缺少 path" };
  const resolved = resolveSafePath(root, relPath);
  if (!resolved.ok) return { ok: false, content: resolved.error };

  let stat = null;
  try {
    stat = await fs.stat(resolved.absolute);
  } catch {
    return { ok: false, content: `File not found: ${resolved.absolute}` };
  }
  if (stat.size > 25 * 1024 * 1024) {
    return { ok: false, content: `File too large (${stat.size} bytes > 25MB).` };
  }

  const ext = path.extname(resolved.absolute).toLowerCase();
  const maxChars = Math.max(1000, Math.min(200000, Number(args.maxChars) || 40000));

  try {
    if (ext === ".docx" || ext === ".doc" || ext === ".wps") {
      const mammoth = require("mammoth");
      const { value } = await mammoth.extractRawText({ path: resolved.absolute });
      const original = String(value || "").trim();
      if (!original) return { ok: true, content: "(空文档或无可提取文本)" };
      const text = original.length > maxChars
        ? original.slice(0, maxChars) + `\n…(截断，原长 ${original.length})`
        : original;
      return { ok: true, content: `文档: ${resolved.absolute}\n\n${text}` };
    }

    if (ext === ".xlsx" || ext === ".xls" || ext === ".et") {
      const ExcelJS = require("exceljs");
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(resolved.absolute);
      const parts = [];
      let used = 0;
      wb.eachSheet((ws) => {
        if (used >= maxChars) return;
        const lines = [`# 工作表: ${ws.name}`];
        ws.eachRow({ includeEmpty: false }, (row) => {
          const vals = [];
          row.eachCell({ includeEmpty: true }, (cell) => {
            let v = cell.value;
            if (v && typeof v === "object") {
              v = v.text ?? v.result ?? v.hyperlink ?? v.formula ?? JSON.stringify(v);
            }
            vals.push(csvCell(v));
          });
          lines.push(vals.join(","));
        });
        const block = lines.join("\n");
        parts.push(block);
        used += block.length;
      });
      const original = parts.join("\n\n");
      const text = original.length > maxChars
        ? original.slice(0, maxChars) + `\n…(截断，原长 ${original.length})`
        : original;
      return { ok: true, content: `表格: ${resolved.absolute}\n\n${text}` };
    }

    if (ext === ".csv" || ext === ".txt" || ext === ".tsv") {
      const original = await fs.readFile(resolved.absolute, "utf8");
      const text = original.length > maxChars
        ? original.slice(0, maxChars) + `\n…(截断，原长 ${original.length})`
        : original;
      return { ok: true, content: `文件: ${resolved.absolute}\n\n${text}` };
    }

    if (ext === ".pptx" || ext === ".ppt" || ext === ".dps") {
      return {
        ok: false,
        content:
          "暂不支持读取 PPT/PPTX/DPS 文本。请 load_skill 合适的文档/PPT 技能后按它的解析流程处理。",
      };
    }
    return {
      ok: false,
      content: `不支持的文档类型: ${ext}。支持 .docx/.doc/.wps/.xlsx/.xls/.et/.csv。二进制旧格式请先转 OOXML。`,
    };
  } catch (e) {
    return { ok: false, content: `读取文档失败: ${e.message || e}` };
  }
}

module.exports = { readDocument, csvCell };
