/**
 * 联网工具的内网/本机地址防护（SSRF 缓解）。
 * web_fetch / download_image 等抓取用户/模型指定 URL 前调用
 * assertPublicHttpUrl()，阻断回环、内网、链路本地、云元数据等地址，
 * 并对 DNS 解析结果再做一次校验，降低重定向 / DNS 重绑定绕过风险。
 */
const dns = require("dns");
const net = require("net");
const logger = require("../core/logger");

function isPrivateIPv4(a, b, c, d) {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, 192.0.2.0/24
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24
  if (a >= 224) return true; // 组播 / 保留
  return false;
}

/** 判断一个 IP 字符串是否属于内网/保留地址（IPv4 + IPv6）。 */
function isPrivateIP(ip) {
  const s = String(ip || "").trim();
  const v = net.isIP(s);
  if (v === 4) {
    const oct = s.split(".").map(Number);
    if (oct.length === 4 && oct.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      return isPrivateIPv4(oct[0], oct[1], oct[2], oct[3]);
    }
    return false;
  }
  if (v === 6) {
    const lower = s.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (/^ff/.test(lower)) return true; // ff00::/8 multicast
    if (lower.startsWith("2001:db8:")) return true; // 2001:db8::/32 文档
    if (lower.startsWith("::ffff:")) return isPrivateIP(lower.slice(7)); // IPv4-mapped
    return false;
  }
  return false;
}

/** 主机名字面是否明显是内网（localhost / IP 字面量）。 */
function hostLooksBlocked(hostname) {
  const h = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .trim();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (net.isIP(h)) return isPrivateIP(h);
  return false;
}

function lookupAll(hostname) {
  return new Promise((resolve) => {
    dns.lookup(hostname, { all: true, family: 0 }, (err, addresses) => {
      if (err || !Array.isArray(addresses)) return resolve([]);
      resolve(addresses.map((a) => String(a?.address || "")).filter(Boolean));
    });
  });
}

/**
 * 校验 URL 为可访问的公网 http(s) 地址；命中内网/本机则抛错。
 * @param {string} urlString
 * @returns {Promise<URL>}
 */
async function assertPublicHttpUrl(urlString) {
  let u;
  try {
    u = new URL(String(urlString || ""));
  } catch {
    throw new Error("无效 URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("仅允许 http(s) 地址");
  }
  const host = u.hostname;
  if (hostLooksBlocked(host)) {
    logger.warn("SSRF 拦截：内网/本机地址", { url: u.toString(), host });
    throw new Error("禁止访问内网/本机地址");
  }
  // DNS 解析后二次校验：任一解析结果为内网地址即拒绝
  const addrs = await lookupAll(host);
  if (addrs.length && addrs.some((a) => isPrivateIP(a))) {
    logger.warn("SSRF 拦截：DNS 解析为内网地址", { url: u.toString(), host, addrs });
    throw new Error("禁止访问内网/本机地址");
  }
  return u;
}

module.exports = {
  isPrivateIP,
  isPrivateIPv4,
  hostLooksBlocked,
  assertPublicHttpUrl,
};
