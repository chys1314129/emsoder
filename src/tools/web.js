/**
 * 联网工具：web_search（DuckDuckGo 网页版，无需 Key）+ web_fetch（抓网页转纯文本）。
 * 让 Agent 摆脱「没有网络访问」——需要最新信息 / 查资料 / 读文档时直接联网。
 * 全部走主进程 fetch，受 http(s) 限制与体积/超时上限。
 */

const { assertPublicHttpUrl } = require("./netguard");

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 读取上限 2MB
const DEFAULT_MAX_CHARS = 24_000;
const MAX_MAX_CHARS = 100_000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 EMSoder/2.6";

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || "").trim());
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&hellip;/gi, "…");
}

function htmlToText(html) {
  let s = String(html || "");
  // 去掉不参与阅读的部分
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // 块级标签 → 换行，帮助保留段落结构
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  // 压缩空白但保留换行
  s = s.replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

async function fetchLimited(url, { maxBytes = MAX_BODY_BYTES, accept = "*/*" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let target = String(url);
    // 手动跟随重定向：每一跳都重新做内网校验，防止「公网 → 302 内网」绕过
    for (let hop = 0; hop < 6; hop++) {
      await assertPublicHttpUrl(target);
      const res = await fetch(target, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": UA,
          Accept: accept,
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { status: res.status, contentType: "", body: "", bytes: 0 };
        target = new URL(loc, target).toString();
        continue;
      }
      const contentType = String(res.headers.get("content-type") || "");
      if (res.body) {
        const reader = res.body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          chunks.push(value);
          if (size > maxBytes) break;
        }
        const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        return { status: res.status, contentType, body: buf.toString("utf8"), bytes: size };
      }
      return { status: res.status, contentType, body: "", bytes: 0 };
    }
    return { status: 0, contentType: "", body: "", bytes: 0, error: "重定向次数过多" };
  } finally {
    clearTimeout(timer);
  }
}

async function webFetch(url, args = {}) {
  const target = String(url || "").trim();
  if (!isHttpUrl(target)) {
    return { ok: false, content: `web_fetch 只接受 http(s) URL，收到: ${target || "(空)"}` };
  }
  try {
    await assertPublicHttpUrl(target);
  } catch (err) {
    return { ok: false, content: `web_fetch 拒绝访问（${err.message || err}）: ${target}` };
  }
  const maxChars = Math.min(
    MAX_MAX_CHARS,
    Math.max(1000, Number(args.maxChars) || DEFAULT_MAX_CHARS)
  );
  try {
    const { status, contentType, body, bytes } = await fetchLimited(target, {
      accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
    });
    if (status >= 400) {
      return { ok: false, content: `抓取失败：HTTP ${status}（${target}）` };
    }
    const isHtml = /text\/html|application\/xhtml/i.test(contentType);
    const text = isHtml ? htmlToText(body) : body;
    if (!text) return { ok: false, content: `页面没有可读文本（HTTP ${status}, ${bytes} bytes）` };
    const truncated = text.length > maxChars;
    return {
      ok: true,
      content: [
        `URL: ${target}`,
        `HTTP ${status} · ${contentType || "unknown"} · ${bytes} bytes`,
        "",
        text.slice(0, maxChars),
        truncated ? `\n…(已截断，共 ${text.length} 字符；可用 maxChars 调大上限)` : "",
      ].join("\n"),
    };
  } catch (err) {
    const msg = String(err?.message || err || "");
    const hint = /timeout|abort/i.test(msg)
      ? "请求超时（20s）。站点可能较慢或不可达。"
      : `请求失败: ${msg}`;
    return { ok: false, content: `web_fetch 失败（${target}）：${hint}` };
  }
}

function ddgUddgHref(href) {
  // DDG html 版的 href 形如 //duckduckgo.com/l/?uddg=<urlencoded>&rut=...
  try {
    const u = new URL(href.startsWith("//") ? "https:" + href : href);
    const uddg = u.searchParams.get("uddg");
    if (uddg) return uddg;
    return u.href;
  } catch {
    return href;
  }
}

async function ddgSearch(query) {
  const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
  const { status, body } = await fetchLimited(url, { accept: "text/html" });
  if (status !== 200) throw new Error(`DuckDuckGo HTTP ${status}`);
  const results = [];
  // 每个结果块：result__a（标题+链接）→ result__snippet（摘要）
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(body))) {
    const title = decodeEntities(htmlToText(m[2])).slice(0, 200);
    const snippet = decodeEntities(htmlToText(m[3])).slice(0, 400);
    if (title) results.push({ title, url: ddgUddgHref(m[1]), snippet });
    if (results.length >= 15) break;
  }
  return results;
}

async function bingSearch(query) {
  const url = "https://www.bing.com/search?q=" + encodeURIComponent(query) + "&setlang=zh-CN";
  const { status, body } = await fetchLimited(url, { accept: "text/html" });
  if (status !== 200) throw new Error(`Bing HTTP ${status}`);
  const results = [];
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/gi;
  let m;
  while ((m = re.exec(body))) {
    const title = decodeEntities(htmlToText(m[2])).slice(0, 200);
    const snippet = decodeEntities(htmlToText(m[3] || "")).slice(0, 400);
    if (title) results.push({ title, url: m[1], snippet });
    if (results.length >= 15) break;
  }
  return results;
}

async function webSearch(query, args = {}) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, content: "web_search 需要 query 参数。" };
  const count = Math.min(15, Math.max(1, Number(args.count) || 8));
  let results = [];
  let engine = "duckduckgo";
  try {
    results = await ddgSearch(q);
  } catch (err) {
    // 主引擎失败时换 Bing HTML 兜底
    try {
      results = await bingSearch(q);
      engine = "bing";
    } catch {
      /* both failed below */
    }
  }
  if (!results.length) {
    return {
      ok: false,
      content:
        `web_search 没有拿到结果（引擎 ${engine}）。可能被限流或网络不可达。` +
        `可以稍后重试，或用 run_terminal 执行 curl 兜底。`,
    };
  }
  const shown = results.slice(0, count);
  const content = [
    `Web 搜索: ${q} · 引擎 ${engine} · ${results.length} 条，显示 ${shown.length} 条`,
    "",
    ...shown.map((r, i) =>
      [
        `${i + 1}. ${r.title}`,
        `   ${r.url}`,
        r.snippet ? `   ${r.snippet}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    ),
    "",
    "需要更详细内容时，用 web_fetch 打开上面的链接。",
  ].join("\n");
  return { ok: true, content };
}

module.exports = { webFetch, webSearch, htmlToText, decodeEntities, isHttpUrl };
