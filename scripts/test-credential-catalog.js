#!/usr/bin/env node
const assert = require("assert");
const { listCredentials, setCredential, clearCredential, publicProvider, publicMcp } = require("../src/main/credentialCatalog");
const cfg = {
  pexelsApiKey: "PEXELS_SENTINEL", unsplashApiKey: "UNSPLASH_SENTINEL", imageGenApiKey: "IMAGE_SENTINEL",
  imageGenBackend: "openai", executionEnv: { CUSTOM_TOKEN: "CUSTOM_SENTINEL", PATH: "bad" },
  providers: [{ id: "p1", name: "Provider", type: "openai", baseUrl: "https://x", apiKey: "PROVIDER_SENTINEL", headers: { Authorization: "HEADER_SENTINEL" }, models: ["m"], enabled: true, oauthTokens: { accessToken: "OAUTH_SENTINEL" } }],
  mcpServers: [{ id: "m1", name: "MCP", type: "stdio", command: "node", env: { MCP_TOKEN: "MCP_ENV_SENTINEL" }, headers: { Authorization: "MCP_HEADER_SENTINEL" } }],
};
const items = listCredentials(cfg);
const wire = JSON.stringify(items);
for (const secret of ["PEXELS_SENTINEL", "UNSPLASH_SENTINEL", "IMAGE_SENTINEL", "CUSTOM_SENTINEL", "PROVIDER_SENTINEL", "HEADER_SENTINEL", "OAUTH_SENTINEL", "MCP_ENV_SENTINEL", "MCP_HEADER_SENTINEL"]) assert.ok(!wire.includes(secret), `catalog leaks ${secret}`);
assert.ok(items.some((x) => x.id === "execution/CUSTOM_TOKEN"));
assert.ok(!items.some((x) => x.id === "execution/PATH"), "reserved env omitted");
setCredential(cfg, { id: "execution/NEW_TOKEN", value: "NEW_VALUE" });
assert.strictEqual(cfg.executionEnv.NEW_TOKEN, "NEW_VALUE");
clearCredential(cfg, { id: "execution/NEW_TOKEN" });
assert.ok(!("NEW_TOKEN" in cfg.executionEnv));
setCredential(cfg, { id: "provider/p1/api-key", value: "REPLACED" });
assert.strictEqual(cfg.providers[0].apiKey, "REPLACED");
clearCredential(cfg, { id: "image-search/pexels" });
assert.strictEqual(cfg.pexelsApiKey, "");
const p = publicProvider(cfg.providers[0]);
const m = publicMcp(cfg.mcpServers[0]);
assert.ok(!JSON.stringify(p).includes("REPLACED"));
assert.ok(!JSON.stringify(m).includes("MCP_ENV_SENTINEL"));
assert.deepStrictEqual(m.envKeys, ["MCP_TOKEN"]);
console.log("OK credential catalog masks secrets and updates compatible fields");
