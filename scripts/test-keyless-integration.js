const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emsoder-keyless-"));
require.cache[require.resolve("electron")] = { id: "electron", filename: "electron", loaded: true, exports: { app: { getPath: () => dir } } };
const config = require("../src/core/config");
const api = require("../src/providers");
const pollinations = require("../src/providers/pollinations");
const { publicProvider } = require("../src/main/credentialCatalog");
const { register } = require("../src/main/ipc/providers");
const fallback = structuredClone(pollinations.POLLINATIONS_PROVIDER);
const primary = { id: "primary", type: "openai", baseUrl: "https://primary.test/v1", apiKey: "PRIVATE_KEY", models: ["primary-model"], enabled: true };
const cfg = { activeProviderId: "primary", activeModel: "primary-model", providers: [primary, fallback], keylessFallbackEnabled: true, reasoningEffort: "medium" };
const req = { messages: [{ role: "user", content: "hello" }], maxRetries: 0 };
const json = () => new Response(JSON.stringify({ choices: [{ message: { content: "fallback answer" }, finish_reason: "stop" }] }));
const sse = (delta) => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
const collect = async (c, r = req) => { const out = []; for await (const e of api.streamChat(c, r)) out.push(e); return out; };
let count = 0;
async function test(name, fn) { await fn(); count++; console.log("OK", name); }
async function mock(fn, run) {
  const old = global.fetch;
  const calls = [];
  const restore = pollinations.__test.setHooks({ scheduler: { acquire: async () => {}, defer() {} } });
  global.fetch = async (url, opts = {}) => { calls.push({ url: String(url), opts }); return fn(String(url), opts, calls); };
  try { await run(calls); } finally { global.fetch = old; restore(); }
}
(async () => {
  await test("fresh config includes keyless default, fallback opt-in", async () => {
    const c = config.loadConfig();
    assert.equal(c.activeProviderId, "pollinations-keyless");
    assert.equal(c.activeModel, "openai");
    assert.equal(c.keylessFallbackEnabled, false);
    assert(config.PROVIDER_PRESETS.pollinations.chatPath === "/openai");
  });
  await test("existing config migration retains active selection, additions survive reload", async () => {
    fs.writeFileSync(config.configPath(), JSON.stringify({ ...cfg, providers: [primary], pollinationsProviderMigrated: undefined }));
    const c = config.loadConfig();
    assert.equal(c.activeProviderId, "primary");
    assert.equal(c.activeModel, "primary-model");
    assert(c.providers.some((p) => p.id === fallback.id));
    config.saveConfig(c);
    assert(config.loadConfig().keylessFallbackEnabled);
    c.providers = [];
    config.saveConfig(c);
    assert.equal(config.loadConfig().providers.length, 0, "explicit removal is not undone");
  });
  await test("runtime and public projection preserve new fields without secrets", async () => {
    const p = config.getProviders({ providers: [fallback] })[0];
    assert.equal(p.chatPath, "/openai");
    assert.equal(p.keyless, true);
    assert.equal(p.timeoutMs, 120000);
    const pub = publicProvider(p);
    assert.equal(pub.keyless, true);
    assert.equal(pub.apiKey, undefined);
  });
  await test("IPC preset switch clears old key/OAuth/header safely", async () => {
    const local = { providers: [{ ...primary, headers: { Authorization: "SECRET" }, oauthTokens: { accessToken: "TOKEN" } }] };
    const handlers = {};
    register({ handle: (name, fn) => { handlers[name] = fn; } }, { cfg: local, publicConfig: (c) => c });
    handlers["providers:upsert"]({}, { ...fallback, id: "primary", resetAuth: true });
    const saved = local.providers[0];
    assert.equal(saved.apiKey, "");
    assert.equal(saved.headers, undefined);
    assert.equal(saved.oauthTokens, undefined);
    assert.equal(saved.chatPath, "/openai");
  });
  await test("IPC manual origin switch clears foreign key; same-origin edit preserves own key", async () => {
    const local = { providers: [{ ...primary, headers: { Authorization: "SECRET" }, oauthTokens: { accessToken: "TOKEN" } }] };
    const handlers = {};
    register({ handle: (name, fn) => { handlers[name] = fn; } }, { cfg: local, publicConfig: (c) => c });
    handlers["providers:upsert"]({}, { ...fallback, id: "primary", keyless: false });
    assert.equal(local.providers[0].apiKey, "");
    assert.equal(local.providers[0].oauthTokens, undefined);
    local.providers[0].apiKey = "OWN_KEY";
    handlers["providers:upsert"]({}, { ...fallback, id: "primary" });
    assert.equal(local.providers[0].apiKey, "OWN_KEY");
    local.providers.push({ ...primary, id: "other", oauthTokens: { accessToken: "KEEP" } });
    handlers["providers:remove"]({}, "primary");
    assert.equal(local.providers[0].oauthTokens.accessToken, "KEEP");
  });
  await test("200 SSE quota error never switches to third-party lane", async () => {
    await mock(() => new Response('data: {"error":{"status":402,"code":"insufficient_quota"}}\n\ndata: [DONE]\n\n'), async (calls) => {
      const out = await collect(cfg);
      assert.equal(out.at(-1).type, "error");
      assert.equal(calls.length, 1);
      assert.equal(out.at(-1).status, 402);
    });
  });
  await test("direct stream uses dedicated URL without OAuth/private primary key", async () => {
    await mock(() => json(), async (calls) => {
      const out = await collect({ ...cfg, activeProviderId: fallback.id, activeModel: "openai" });
      assert(out.some((e) => e.text === "fallback answer"));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://text.pollinations.ai/openai");
      assert(!JSON.stringify(calls[0].opts).includes("PRIVATE_KEY"));
    });
  });
  await test("direct chatOnce errors throw and empty response never passes testProvider", async () => {
    await mock(() => new Response("{}"), async () => {
      await assert.rejects(api.chatOnce(cfg, { ...req, provider: fallback }), /未返回文本/);
      const result = await api.testProvider(cfg, fallback);
      assert.equal(result.ok, false);
    });
  });
  await test("connectivity test sends only one chat request to Pollinations", async () => {
    await mock(() => json(), async (calls) => {
      assert.equal((await api.testProvider(cfg, fallback)).ok, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].opts.method, "POST");
    });
  });
  await test("model refresh uses legacy GET models, failures preserve model list", async () => {
    await mock(() => new Response(JSON.stringify([{ name: "openai" }])), async (calls) => {
      assert.deepEqual(await api.listRemoteModels(fallback), ["openai"]);
      assert.equal(calls[0].url, "https://text.pollinations.ai/models");
    });
    await mock(() => new Response("{}", { status: 402 }), async () => {
      await assert.rejects(api.listRemoteModels(fallback), (e) => e.status === 402 && e.fallbackModels[0] === "openai");
    });
  });
  await test("opted-in connection failure switches visibly before output only", async () => {
    await mock((url) => { if (url.includes("primary.test")) throw new Error("connection refused"); return json(); }, async (calls) => {
      const out = await collect(cfg);
      assert(out.some((e) => e.type === "status"));
      assert(out.some((e) => e.text === "fallback answer"));
      const p = calls.find((c) => c.url.includes("pollinations"));
      assert(p);
      assert.equal(p.opts.headers.Authorization, undefined);
      assert.equal(JSON.parse(p.opts.body).model, "openai");
    });
  });
  await test("disabled fallback never sends conversation to third party", async () => {
    await mock(() => { throw new Error("connection refused"); }, async (calls) => {
      const out = await collect({ ...cfg, keylessFallbackEnabled: false });
      assert.equal(out.at(-1).type, "error");
      assert(calls.every((c) => c.url.includes("primary.test")));
    });
  });
  for (const status of [401, 402, 403, 429]) await test(`HTTP ${status} never changes provider to bypass restrictions`, async () => {
    await mock(() => new Response("restricted", { status }), async (calls) => {
      const out = await collect(cfg);
      assert.equal(out.at(-1).type, "error");
      assert(calls.every((c) => c.url.includes("primary.test")));
    });
  });
  await test("partial text followed by stream error is never replayed", async () => {
    await mock(() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`)); }, pull(c) { c.error(new Error("stream interrupted")); } })), async (calls) => {
      const out = await collect(cfg);
      assert(out.some((e) => e.text === "partial"));
      assert.equal(out.at(-1).type, "error");
      assert.equal(calls.length, 1);
    });
  });
  await test("explicit provider selection excludes fallback", async () => {
    await mock(() => { throw new Error("connection refused"); }, async (calls) => {
      const out = await collect(cfg, { ...req, provider: primary });
      assert.equal(out.at(-1).type, "error");
      assert(calls.every((c) => c.url.includes("primary.test")));
    });
  });
  await test("normal primary output unchanged", async () => {
    await mock(() => sse({ content: "primary works" }), async (calls) => {
      const out = await collect(cfg);
      assert.equal(out.find((e) => e.type === "text").text, "primary works");
      assert.equal(calls.length, 1);
    });
  });
  console.log(`PASS ${count} keyless integration cases`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
