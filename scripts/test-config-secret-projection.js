#!/usr/bin/env node
const assert = require("assert");
const { listCredentials, publicProvider, publicMcp } = require("../src/main/credentialCatalog");
const secret = "SECRET_DO_NOT_EXPOSE_81q";
const cfg = {
  pexelsApiKey: secret + "-pexels", unsplashApiKey: secret + "-unsplash", imageGenApiKey: secret + "-image",
  executionEnv: { CUSTOM_SECRET: secret + "-env" },
  providers: [{ id: "x", name: "X", type: "openai", baseUrl: "https://x", apiKey: secret + "-provider", headers: { Authorization: "Bearer " + secret }, oauth: { clientId: "public-client", authorizeUrl: "https://x/auth", tokenUrl: "https://x/token", clientSecret: secret + "-oauth-secret" }, oauthTokens: { accessToken: secret + "-access", refreshToken: secret + "-refresh" } }],
  mcpServers: [{ id: "m", name: "M", type: "http", url: "https://m", env: { API_TOKEN: secret + "-mcp-env" }, headers: { Authorization: "Bearer " + secret + "-mcp-header" } }],
};
const catalog = listCredentials(cfg);
const provider = publicProvider(cfg.providers[0]);
const mcp = publicMcp(cfg.mcpServers[0]);
const exported = JSON.stringify({ catalog, provider, mcp });
assert.ok(!exported.includes(secret), "renderer-safe projections never contain secret values");
assert.deepStrictEqual(provider.headerNames, ["Authorization"]);
assert.strictEqual(provider.apiKeyConfigured, true);
assert.strictEqual(provider.oauthConnected, true);
assert.strictEqual(provider.oauth.clientSecret, undefined);
assert.deepStrictEqual(mcp.envKeys, ["API_TOKEN"]);
assert.deepStrictEqual(mcp.headerNames, ["Authorization"]);
console.log("OK public credential projections contain metadata only");
