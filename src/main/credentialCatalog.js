const { executionEnv } = require("../tools/skillRuntime");
const logger = require("../core/logger");

function providerAuthState(provider = {}) {
  if (provider.oauthTokens?.accessToken) return "oauth";
  if (provider.apiKey) return "configured";
  return "missing";
}

/** Renderer-safe credential metadata. Never include values/tokens/header bodies. */
function listCredentials(cfg = {}) {
  const items = [
    {
      id: "image-search/pexels", group: "built-in", label: "Pexels API Key",
      keyName: "PEXELS_API_KEY", source: "图片搜索", configured: !!String(cfg.pexelsApiKey || "").trim(),
      editable: true, description: "用于 Pexels 图片搜索",
    },
    {
      id: "image-search/unsplash", group: "built-in", label: "Unsplash Access Key",
      keyName: "UNSPLASH_ACCESS_KEY", source: "图片搜索", configured: !!String(cfg.unsplashApiKey || "").trim(),
      editable: true, description: "用于 Unsplash 图片搜索",
    },
    {
      id: "image-generation/api-key", group: "built-in", label: "图片生成 API Key",
      keyName: "IMAGE_GENERATION_API_KEY", source: "图片生成", configured: !!String(cfg.imageGenApiKey || "").trim(),
      editable: true, description: `用于 ${cfg.imageGenBackend || "modelscope"} 图片生成，仅限图片 Skill 子进程`,
    },
  ];
  for (const p of Array.isArray(cfg.providers) ? cfg.providers : []) {
    items.push({
      id: `provider/${p.id}/api-key`, group: "provider", label: `${p.name || p.id} API Key`,
      keyName: "API_KEY", source: p.baseUrl || "模型服务商", configured: providerAuthState(p) !== "missing",
      authState: providerAuthState(p), editable: true, providerId: p.id,
      description: providerAuthState(p) === "oauth" ? "已通过 OAuth 连接；替换 API Key 会作为 OAuth 回退凭据" : "用于模型服务商认证",
    });
  }
  for (const [key] of Object.entries(executionEnv(cfg))) {
    items.push({
      id: `execution/${key}`, group: "custom", label: key, keyName: key,
      source: "终端与技能", configured: true, editable: true, executionKey: key,
      description: "仅注入新终端、Agent run_terminal 和 Skill 脚本",
    });
  }
  for (const server of Array.isArray(cfg.mcpServers) ? cfg.mcpServers : []) {
    const envKeys = Object.keys(server.env || {}).sort();
    const headerNames = Object.keys(server.headers || {}).sort();
    if (!envKeys.length && !headerNames.length) continue;
    items.push({
      id: `mcp/${server.id}/overview`, group: "mcp", label: server.name || server.id,
      keyName: envKeys.concat(headerNames).join(", "), source: server.type === "http" ? "MCP HTTP" : "MCP stdio",
      configured: true, editable: false, mcpServerId: server.id, envKeys, headerNames,
      description: "MCP 凭据仍在 MCP 设置中管理；这里只显示变量和 Header 名称",
    });
  }
  return items;
}

function setCredential(cfg, { id, value, key } = {}) {
  const text = String(value ?? "");
  if (id === "image-search/pexels") cfg.pexelsApiKey = text;
  else if (id === "image-search/unsplash") cfg.unsplashApiKey = text;
  else if (id === "image-generation/api-key") cfg.imageGenApiKey = text;
  else if (String(id).startsWith("provider/") && String(id).endsWith("/api-key")) {
    const providerId = String(id).slice("provider/".length, -"/api-key".length);
    const provider = (cfg.providers || []).find((p) => p.id === providerId);
    if (!provider) throw new Error("服务商不存在");
    provider.apiKey = text;
  } else if (String(id).startsWith("execution/")) {
    const envKey = String(id).slice("execution/".length);
    const env = { ...(cfg.executionEnv || {}), [envKey]: text };
    cfg.executionEnv = executionEnv({ executionEnv: env });
    if (!Object.prototype.hasOwnProperty.call(cfg.executionEnv, envKey)) throw new Error("环境变量名或值无效");
  } else if (key) {
    const envKey = String(key).trim();
    const env = { ...(cfg.executionEnv || {}), [envKey]: text };
    cfg.executionEnv = executionEnv({ executionEnv: env });
    if (!Object.prototype.hasOwnProperty.call(cfg.executionEnv, envKey)) throw new Error("环境变量名或值无效");
  } else throw new Error("不支持的凭据类型");
  logger.info("凭据已设置", { id: String(id || key || "") });
  return listCredentials(cfg);
}

function clearCredential(cfg, { id } = {}) {
  if (id === "image-search/pexels") cfg.pexelsApiKey = "";
  else if (id === "image-search/unsplash") cfg.unsplashApiKey = "";
  else if (id === "image-generation/api-key") cfg.imageGenApiKey = "";
  else if (String(id).startsWith("provider/") && String(id).endsWith("/api-key")) {
    const providerId = String(id).slice("provider/".length, -"/api-key".length);
    const provider = (cfg.providers || []).find((p) => p.id === providerId);
    if (!provider) throw new Error("服务商不存在");
    provider.apiKey = "";
  } else if (String(id).startsWith("execution/")) {
    const envKey = String(id).slice("execution/".length);
    const env = { ...(cfg.executionEnv || {}) };
    delete env[envKey];
    cfg.executionEnv = executionEnv({ executionEnv: env });
  } else throw new Error("不支持的凭据类型");
  logger.info("凭据已清除", { id: String(id || "") });
  return listCredentials(cfg);
}

function publicProvider(provider = {}) {
  return {
    id: provider.id, name: provider.name || provider.id,
    type: provider.type === "anthropic" ? "anthropic" : "openai",
    baseUrl: String(provider.baseUrl || "").replace(/\/+$/, ""),
    models: Array.isArray(provider.models) ? provider.models : [],
    enabled: provider.enabled !== false,
    chatPath: provider.chatPath,
    keyless: provider.keyless === true,
    timeoutMs: provider.timeoutMs,
    headerNames: Object.keys(provider.headers || {}).sort(),
    oauth: provider.oauth && typeof provider.oauth === "object"
      ? { authorizeUrl: provider.oauth.authorizeUrl || "", tokenUrl: provider.oauth.tokenUrl || "", clientId: provider.oauth.clientId || "", scopes: provider.oauth.scopes || "" }
      : undefined,
    oauthConfigured: !!(provider.oauth?.clientId && provider.oauth?.authorizeUrl && provider.oauth?.tokenUrl),
    oauthConnected: !!provider.oauthTokens?.accessToken,
    apiKeyConfigured: !!String(provider.apiKey || "").trim(),
  };
}

function publicMcp(server = {}) {
  return {
    id: server.id, name: server.name || server.id, type: server.type,
    command: server.command || "", args: Array.isArray(server.args) ? server.args : [], cwd: server.cwd || "",
    url: server.url || "", enabled: server.enabled !== false, timeoutMs: server.timeoutMs,
    status: server.status || "stopped", error: server.error || "", toolCount: Number(server.toolCount) || 0,
    tools: Array.isArray(server.tools) ? server.tools : [],
    envKeys: Object.keys(server.env || {}).sort(), headerNames: Object.keys(server.headers || {}).sort(),
  };
}

module.exports = { listCredentials, setCredential, clearCredential, publicProvider, publicMcp, providerAuthState };
