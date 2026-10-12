/**
 * Image search + download for installed document/PPT skills.
 * - search: Pexels (default) or Unsplash, via fetchWithTimeout (main-process fetch).
 * - download: fetch bytes to workspace exports/assets/, MIME + size guarded.
 * API keys come from cfg (never hardcoded, never logged).
 */
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { fetchWithTimeout } = require("../providers/httpUtil");
const { resolveSafePath } = require("./paths");
const { assertPublicHttpUrl } = require("./netguard");

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB per image
const IMAGE_MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/** 下载图片用：手动跟随重定向并逐跳校验内网，防止 302 内网绕过。 */
async function fetchImagePublic(url, timeoutMs) {
  let target = String(url);
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicHttpUrl(target);
    const res = await fetchWithTimeout(target, { redirect: "manual" }, timeoutMs);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      target = new URL(loc, target).toString();
      continue;
    }
    return res;
  }
  throw new Error("重定向次数过多");
}

function activeImageProvider(cfg) {
  return cfg?.imageProvider === "unsplash" ? "unsplash" : "pexels";
}

function providerKey(cfg, provider) {
  const k = provider === "unsplash" ? cfg?.unsplashApiKey : cfg?.pexelsApiKey;
  return k && String(k).trim() ? String(k).trim() : "";
}

/**
 * Search images. Returns { ok, provider, results:[{id,thumb,url,width,height,alt,credit,creditUrl}] }.
 */
async function searchImages(cfg, args = {}) {
  const query = String(args.query || "").trim();
  if (!query) return { ok: false, content: "缺少搜索关键词 query" };
  const count = Math.max(1, Math.min(30, Number(args.count) || 8));
  const orientation = ["landscape", "portrait", "square"].includes(args.orientation)
    ? args.orientation
    : "";
  const provider = activeImageProvider(cfg);
  const key = providerKey(cfg, provider);
  if (!key) {
    return {
      ok: false,
      content:
        `未配置${provider === "unsplash" ? " Unsplash" : " Pexels"} API Key。` +
        `请在「设置 → 图片搜索」填入 Key（${provider === "unsplash"
          ? "https://unsplash.com/developers"
          : "https://www.pexels.com/api/"} 免费申请）。`,
    };
  }

  try {
    if (provider === "unsplash") {
      const u = new URL("https://api.unsplash.com/search/photos");
      u.searchParams.set("query", query);
      u.searchParams.set("per_page", String(count));
      if (orientation) u.searchParams.set("orientation", orientation);
      const res = await fetchWithTimeout(
        u.toString(),
        { headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" } },
        15000
      );
      if (!res.ok) return { ok: false, content: `Unsplash 请求失败：HTTP ${res.status}` };
      const data = await res.json();
      const results = (data.results || []).map((p) => ({
        id: String(p.id),
        thumb: p.urls?.thumb || p.urls?.small || "",
        url: p.urls?.regular || p.urls?.full || p.urls?.raw || "",
        width: p.width,
        height: p.height,
        alt: p.alt_description || p.description || "",
        credit: p.user?.name || "",
        creditUrl: p.user?.links?.html || p.links?.html || "",
      }));
      return { ok: true, provider, results };
    }
    // Pexels
    const u = new URL("https://api.pexels.com/v1/search");
    u.searchParams.set("query", query);
    u.searchParams.set("per_page", String(count));
    if (orientation) u.searchParams.set("orientation", orientation);
    const res = await fetchWithTimeout(
      u.toString(),
      { headers: { Authorization: key } },
      15000
    );
    if (!res.ok) return { ok: false, content: `Pexels 请求失败：HTTP ${res.status}` };
    const data = await res.json();
    const results = (data.photos || []).map((p) => ({
      id: String(p.id),
      thumb: p.src?.tiny || p.src?.small || "",
      url: p.src?.large2x || p.src?.large || p.src?.original || "",
      width: p.width,
      height: p.height,
      alt: p.alt || "",
      credit: p.photographer || "",
      creditUrl: p.photographer_url || p.url || "",
    }));
    return { ok: true, provider, results };
  } catch (e) {
    return { ok: false, content: `图片搜索失败：${e.message || e}` };
  }
}

/**
 * Download an image URL into workspace (default exports/assets/).
 * Returns { ok, path (relative), absolute, bytes, mime }.
 */
async function downloadImage(ctx, root, args = {}) {
  const url = String(args.url || "").trim();
  if (!url) return { ok: false, content: "缺少图片 url" };
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, content: "只支持 http(s) 图片地址" };
  }
  if (!root) return { ok: false, content: "未打开工作区，无法保存图片" };

  const dir = String(args.dir || "exports/assets").replace(/^[/\\]+/, "");
  try {
    const res = await fetchImagePublic(url, 20000);
    if (!res.ok) return { ok: false, content: `下载失败：HTTP ${res.status}` };
    const mime = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const ext = IMAGE_MIME_EXT[mime];
    if (!ext) {
      return { ok: false, content: `不是支持的图片类型（content-type: ${mime || "未知"}）` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) {
      return { ok: false, content: `图片过大（${buf.length} 字节 > 8MB）` };
    }
    const base =
      String(args.name || "img")
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 32) || "img";
    const fname = `${base}-${crypto.randomBytes(4).toString("hex")}${ext}`;
    const rel = path.join(dir, fname);
    const resolved = resolveSafePath(root, rel);
    if (!resolved.ok) return { ok: false, content: resolved.error };
    await fs.mkdir(path.dirname(resolved.absolute), { recursive: true });
    await fs.writeFile(resolved.absolute, buf);
    ctx?.onFsChange?.(resolved.absolute, "write");
    return {
      ok: true,
      content: [
        "已下载图片",
        `相对路径: ${resolved.relative || rel}`,
        `绝对路径: ${resolved.absolute}`,
        `大小: ${buf.length} 字节`,
      ].join("\n"),
      path: resolved.relative || rel,
      absolute: resolved.absolute,
      bytes: buf.length,
      mime,
    };
  } catch (e) {
    return { ok: false, content: `下载图片失败：${e.message || e}` };
  }
}

/** Agent tool wrapper for search_images (formats a readable list). */
async function toolSearchImages(ctx, args) {
  const r = await searchImages(ctx?.cfg, args);
  if (!r.ok) return r;
  if (!r.results.length) {
    return { ok: true, content: `未找到与「${args.query}」相关的图片。` };
  }
  const lines = r.results.map(
    (im, i) =>
      `${i + 1}. [${im.width}x${im.height}] ${im.alt || "(无描述)"}\n   url: ${im.url}\n   缩略图: ${im.thumb}\n   作者: ${im.credit}`
  );
  return {
    ok: true,
    content:
      `来源 ${r.provider}，找到 ${r.results.length} 张（要用哪张就用 download_image 下 url 到 exports/assets/，再交给已加载的 PPT/PDF 技能使用）：\n\n` +
      lines.join("\n"),
    results: r.results,
  };
}

module.exports = {
  searchImages,
  downloadImage,
  toolSearchImages,
  activeImageProvider,
};
