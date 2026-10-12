/**
 * OAuth 2.0 (authorization code + PKCE) 支持，供 Pi OAuth provider 使用。
 * - 授权码流程：本地回环 redirect_uri + code_challenge(S256) + token 交换
 * - token 存储：provider.oauthTokens = { accessToken, refreshToken, expiresAt, tokenType }
 * - 自动刷新：access token 过期且带 refreshToken 时走 tokenUrl 刷新
 * - 请求注入：provider 带 oauth 时用 Bearer token 代替 apiKey
 */
const crypto = require("crypto");
const http = require("http");

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pkcePair() {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function oauthConfigOf(provider) {
  const o = provider?.oauth;
  if (!o || typeof o !== "object") return null;
  if (typeof o.authorizeUrl !== "string" || typeof o.tokenUrl !== "string" || typeof o.clientId !== "string") {
    return null;
  }
  return o;
}

function tokenExpired(provider) {
  const tokens = provider?.oauthTokens;
  if (!tokens?.accessToken) return true;
  if (!tokens.expiresAt) return false; // 无过期信息：假定长期有效
  return Number(tokens.expiresAt) <= Date.now() + 30_000; // 提前 30s 视为过期
}

async function postForm(url, params, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!res.ok && !data.access_token) {
      throw new Error(`OAuth token 请求失败 HTTP ${res.status}: ${String(data.error_description || data.error || text || "").slice(0, 300)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function applyTokenResponse(tokens, data) {
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("OAuth 响应缺少 access_token");
  }
  const expiresIn = Number(data.expires_in);
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : tokens?.refreshToken || "",
    tokenType: String(data.token_type || "Bearer"),
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
  };
}

/** 授权码兑换（PKCE）→ 返回持久化到 provider.oauthTokens 的 token 对象。 */
async function exchangeCode(provider, code, verifier, redirectUri) {
  const o = oauthConfigOf(provider);
  if (!o) throw new Error("该服务商未配置 OAuth");
  const data = await postForm(o.tokenUrl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: o.clientId,
    code_verifier: verifier,
    ...(o.clientSecret ? { client_secret: o.clientSecret } : {}),
  });
  return applyTokenResponse(provider.oauthTokens, data);
}

async function refreshTokens(provider) {
  const o = oauthConfigOf(provider);
  const tokens = provider.oauthTokens;
  if (!o || !tokens?.refreshToken) throw new Error("无 refresh token，无法刷新 OAuth 凭证");
  const data = await postForm(o.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: o.clientId,
    ...(o.clientSecret ? { client_secret: o.clientSecret } : {}),
  });
  return applyTokenResponse(tokens, data);
}

/**
 * 取当前可用的 Bearer token（必要时刷新）。返回 string | null。
 * provider 无 OAuth 配置时返回 null——调用方继续走 apiKey 路径。
 */
async function getOAuthBearerToken(cfg, providerId = "") {
  const providers = Array.isArray(cfg?.providers) ? cfg.providers : [];
  const provider = providers.find((p) => p.id === providerId) || providers.find((p) => p.oauth) || null;
  if (!provider || !oauthConfigOf(provider)) return null;
  if (!provider.oauthTokens?.accessToken) return null;
  if (tokenExpired(provider)) {
    try {
      provider.oauthTokens = await refreshTokens(provider);
      // 刷新后回写配置（调用方持有 cfg 引用）
      if (typeof cfg.save === "function") { try { cfg.save(); } catch { /* ignore */ } }
    } catch {
      // 刷新失败仍可返回旧 token 尝试一次（很多网关过期校验宽松）
    }
  }
  return provider.oauthTokens?.accessToken || null;
}

/**
 * 启动本地回环服务器等待授权码回调。
 * resolve = { server, port, redirectUri, codePromise }；codePromise 30 分钟超时后 reject。
 */
async function startAuthServer(pathPrefix = "/emsoder-oauth-callback") {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (!url.pathname.startsWith(pathPrefix)) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><body style="font-family:sans-serif;background:#082f49;color:#e0f2fe;padding:40px">
        <h2>${code ? "授权成功" : "授权失败"}</h2>
        <p>${code ? "可以关闭本窗口，回到 EMSoder。" : "授权被取消或失败：" + (error || "未知错误")}</p>
        </body></html>`);
      server.close();
      codePromiseHandle.resolve(code ? { code } : { error });
    });
    let codePromiseHandle;
    const codePromise = new Promise((res2, rej2) => {
      codePromiseHandle = { resolve: res2, reject: rej2 };
      setTimeout(() => rej2(new Error("OAuth 授权超时（30 分钟）")), 30 * 60 * 1000);
    });
    server.on("error", (err) => {
      reject(new Error(`OAuth 回调服务器启动失败: ${err?.message || err}`));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        redirectUri: `http://127.0.0.1:${port}${pathPrefix}`,
        codePromise,
      });
    });
  });
}

module.exports = {
  pkcePair,
  oauthConfigOf,
  exchangeCode,
  refreshTokens,
  getOAuthBearerToken,
  startAuthServer,
  tokenExpired,
};
