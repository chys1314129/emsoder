/**
 * Generate Office / PDF documents inside the workspace.
 * Formats: docx, pdf, pptx (ppt maps to pptx).
 */
const fs = require("fs/promises");
const fsSync = require("fs"); // only for createWriteStream (pdfkit requires a stream)
const path = require("path");
const { resolveSafePath } = require("./paths");
const { maybeConfirm } = require("./confirm");

function normalizeFormat(fmt) {
  const f = String(fmt || "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  if (f === "doc" || f === "docx" || f === "word") return "docx";
  if (f === "pdf") return "pdf";
  if (f === "ppt" || f === "pptx" || f === "powerpoint") return "pptx";
  return "";
}

function ensureExt(filePath, format) {
  const ext = path.extname(filePath).toLowerCase();
  const want = "." + format;
  if (ext === want) return filePath;
  if (format === "pptx" && ext === ".ppt") {
    return filePath.replace(/\.ppt$/i, ".pptx");
  }
  if (format === "docx" && ext === ".doc") {
    return filePath.replace(/\.doc$/i, ".docx");
  }
  if (!ext) return filePath + want;
  return filePath.replace(/\.[^.]+$/, want);
}

function slidesFromArgs(args) {
  if (Array.isArray(args.slides) && args.slides.length) {
    return args.slides.map((s, i) => ({
      title: String(s.title || s.heading || `幻灯片 ${i + 1}`),
      bullets: normalizeBullets(s.bullets || s.points || s.content || s.body),
      notes: s.notes ? String(s.notes) : "",
    }));
  }
  // markdown-ish: sections split by ---
  const md = String(args.markdown || args.content || "").trim();
  if (!md) return [];
  const chunks = md.split(/\n---+\n/);
  return chunks.map((chunk, i) => {
    const lines = chunk
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    let title = `幻灯片 ${i + 1}`;
    const bullets = [];
    for (const line of lines) {
      if (/^#+\s+/.test(line) && bullets.length === 0 && title.startsWith("幻灯片")) {
        title = line.replace(/^#+\s+/, "");
        continue;
      }
      bullets.push(line.replace(/^[-*•]\s+/, ""));
    }
    return { title, bullets, notes: "" };
  });
}

function normalizeBullets(input) {
  if (Array.isArray(input)) {
    return input.map((x) => String(x ?? "").trim()).filter(Boolean);
  }
  if (input == null) return [];
  const t = String(input).trim();
  if (!t) return [];
  return t
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*•]\s+/, "").trim())
    .filter(Boolean);
}

function paragraphsFromArgs(args) {
  if (Array.isArray(args.paragraphs) && args.paragraphs.length) {
    return args.paragraphs.map((p) => String(p ?? "").trim()).filter(Boolean);
  }
  const body = String(args.content || args.markdown || args.body || "").trim();
  if (!body) return [];
  return body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Agent tool: create_document
 */
async function createDocument(ctx, root, args) {
  const format = normalizeFormat(args.format || args.type);
  if (!format) {
    return {
      ok: false,
      content:
        "format 必须是 docx / pdf / pptx 之一（也可用 doc、ppt 别名）",
    };
  }

  let relPath = String(args.path || args.filename || "").trim();
  if (!relPath) {
    const base = String(args.title || "document")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .slice(0, 40);
    relPath = path.join("exports", `${base || "document"}.${format}`);
  }
  relPath = ensureExt(relPath, format);

  const resolved = resolveSafePath(root, relPath);
  if (!resolved.ok) return { ok: false, content: resolved.error };

  const title = String(args.title || path.basename(resolved.absolute, path.extname(resolved.absolute)));
  const author = String(args.author || "EMSoder");

  // confirm write (same spirit as write_file)
  if (!(await maybeConfirmWrite(ctx, resolved.absolute))) {
    return { ok: false, content: "用户取消生成文档", needConfirm: true };
  }

  await fs.mkdir(path.dirname(resolved.absolute), { recursive: true });

  if (format === "docx") {
    await writeDocx(resolved.absolute, {
      title,
      author,
      paragraphs: paragraphsFromArgs(args),
      heading: args.heading != null ? String(args.heading) : title,
    });
  } else if (format === "pdf") {
    await writePdf(resolved.absolute, {
      title,
      author,
      paragraphs: paragraphsFromArgs(args),
      heading: args.heading != null ? String(args.heading) : title,
    });
  } else {
    const slides = slidesFromArgs(args);
    if (!slides.length) {
      return {
        ok: false,
        content:
          "pptx 需要 slides 数组，或 content/markdown（用 --- 分页）。示例 slides:[{title,bullets:[]}]",
      };
    }
    await writePptx(resolved.absolute, { title, author, slides });
  }

  ctx.onFsChange?.(resolved.absolute, "write");
  return {
    ok: true,
    content: [
      `已生成 ${format.toUpperCase()}`,
      `路径: ${resolved.relative || resolved.absolute}`,
      `绝对路径: ${resolved.absolute}`,
      title ? `标题: ${title}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

async function maybeConfirmWrite(ctx, absolute) {
  return maybeConfirm(ctx, `生成并写入文档？\n${absolute}`);
}

async function writeDocx(filePath, { title, author, paragraphs, heading }) {
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    AlignmentType,
  } = require("docx");

  const kids = [];
  if (heading) {
    kids.push(
      new Paragraph({
        text: heading,
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 240 },
      })
    );
  }
  const paras = paragraphs.length
    ? paragraphs
    : ["（无正文内容，请补充 content 或 paragraphs）"];
  for (const p of paras) {
    kids.push(
      new Paragraph({
        children: [
          new TextRun({
            text: p,
            size: 22, // half-points
          }),
        ],
        spacing: { after: 160 },
        alignment: AlignmentType.LEFT,
      })
    );
  }

  const doc = new Document({
    creator: author || "EMSoder",
    title: title || "Document",
    description: "Generated by EMSoder",
    sections: [{ properties: {}, children: kids }],
  });
  const buf = await Packer.toBuffer(doc);
  await fs.writeFile(filePath, buf);
}

async function resolveCjkFont() {
  // Prefer single-face TTF — pdfkit often fails on .ttc collections
  const candidates = [
    process.env.EMSODER_PDF_FONT,
    "C:\\Windows\\Fonts\\simhei.ttf",
    "C:\\Windows\\Fonts\\msyh.ttf",
    "C:\\Windows\\Fonts\\simkai.ttf",
    "C:\\Windows\\Fonts\\simfang.ttf",
    "C:\\Windows\\Fonts\\msyh.ttc",
    "C:\\Windows\\Fonts\\simsun.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
  ].filter(Boolean);
  for (const f of candidates) {
    try {
      await fs.access(f);
      return f;
    } catch {
      /* not found, try next */
    }
  }
  return null;
}

async function writePdf(filePath, { title, author, paragraphs, heading }) {
  const PDFDocument = require("pdfkit");
  const fontPath = await resolveCjkFont();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margin: 50,
      info: {
        Title: title || "Document",
        Author: author || "EMSoder",
        Creator: "EMSoder",
      },
    });
    const stream = fsSync.createWriteStream(filePath);
    doc.pipe(stream);

    if (fontPath) {
      try {
        // ttc collections: pdfkit uses first face when possible
        doc.font(fontPath);
      } catch {
        try {
          doc.font("Helvetica");
        } catch {
          /* ignore */
        }
      }
    } else {
      try {
        doc.font("Helvetica");
      } catch {
        /* ignore */
      }
    }

    if (heading) {
      doc.fontSize(18).text(heading, { underline: false });
      doc.moveDown();
    }
    doc.fontSize(11);
    const paras = paragraphs.length
      ? paragraphs
      : ["(No body content. Provide content or paragraphs.)"];
    for (const p of paras) {
      doc.text(p, { align: "left", lineGap: 4 });
      doc.moveDown(0.8);
    }
    if (!fontPath) {
      doc.moveDown();
      doc.fontSize(9).fillColor("#666").text(
        "Note: No CJK font found on system; Chinese glyphs may not render. Install Microsoft YaHei / set EMSODER_PDF_FONT."
      );
    }
    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

async function writePptx(filePath, { title, author, slides }) {
  const PptxGenJS = require("pptxgenjs");
  const pptx = new PptxGenJS();
  pptx.author = author || "EMSoder";
  pptx.title = title || "Presentation";
  pptx.subject = "Generated by EMSoder";

  for (const slide of slides) {
    const s = pptx.addSlide();
    s.addText(slide.title || "Slide", {
      x: 0.5,
      y: 0.35,
      w: 9,
      h: 0.7,
      fontSize: 26,
      bold: true,
      color: "0F172A",
    });
    const bullets = slide.bullets || [];
    if (bullets.length) {
      s.addText(
        bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        {
          x: 0.6,
          y: 1.2,
          w: 8.8,
          h: 4.5,
          fontSize: 16,
          color: "1E293B",
          valign: "top",
        }
      );
    }
    if (slide.notes) {
      try {
        s.addNotes(String(slide.notes));
      } catch {
        /* optional */
      }
    }
  }

  await pptx.writeFile({ fileName: filePath });
}

module.exports = {
  createDocument,
  normalizeFormat,
  ensureExt,
};
