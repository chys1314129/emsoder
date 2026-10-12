#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const rendererPath = path.join(root, "renderer/js/modules/providers-modal.js");
const rendererSource = fs.readFileSync(rendererPath, "utf8");
const clone = (value) => structuredClone(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const oauthFields = ["pfOAuthAuthorizeUrl", "pfOAuthTokenUrl", "pfOAuthClientId", "pfOAuthScopes"];
const secrets = ["FOREIGN_API_KEY", "FOREIGN_TOKEN", "FOREIGN_HEADER", "OWN_API_KEY", "OWN_TOKEN", "OWN_HEADER"];
const presets = {
  pollinations: {
    id: "pollinations-keyless", name: "Pollinations 无密钥", type: "openai",
    baseUrl: "https://text.pollinations.ai", chatPath: "/openai", apiKey: "",
    models: "openai", keyless: true, enabled: true, timeoutMs: 120000,
  },
};

// 只在 VM 中加载纯投影与真实 upsert 分支；持久化替换为空操作。
function loadCommonJs(relativePath, dependencies) {
  const filename = path.join(root, relativePath);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, exports: module.exports, URL,
    require(id) {
      assert.ok(has(dependencies, id), `未声明的测试依赖：${id}`);
      return dependencies[id];
    },
  }, { filename });
  return module.exports;
}
const { publicProvider } = loadCommonJs("src/main/credentialCatalog.js", {
  "../tools/skillRuntime": {}, "../core/logger": {},
});
const { register } = loadCommonJs("src/main/ipc/providers.js", {
  "../../core/config": { saveConfig() {} },
  "../../providers": {}, "../credentialCatalog": { publicProvider }, "../../core/oauth": {},
});

function element(id) {
  const listeners = new Map();
  const classes = new Set();
  const attributes = new Map();
  return {
    id, value: "", disabled: false, placeholder: "", dataset: {},
    checked: false, hidden: true, type: "text", textContent: "", innerHTML: "", onclick: null,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => attributes.get(name) ?? null,
    removeAttribute: (name) => attributes.delete(name),
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    },
    async dispatch(name) {
      const callbacks = [...(listeners.get(name) || [])];
      if (typeof this[`on${name}`] === "function") callbacks.push(this[`on${name}`]);
      const event = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} };
      await Promise.all(callbacks.map((callback) => callback(event)));
    },
  };
}

function harness(config = {}) {
  const raw = clone({ activeProviderId: "primary", activeModel: "primary-model", providers: [], keylessFallbackEnabled: false, ...config });
  const calls = { presets: 0, upsert: [], update: [], active: [], list: 0, open: [], close: [], toast: [], chips: 0, quest: 0 };
  const elements = new Map([
    "keylessFallbackToggle", "providerList", "pfKeylessNotice", "editProviderTitle", "pfPreset",
    "pfId", "pfName", "pfType", "pfBaseUrl", "pfApiKey", "pfModels", "pfEnabled", ...oauthFields,
    "pfOAuthStatus", "btnToggleApiKey", "btnRefreshModelsInEdit", "btnAddProvider", "btnOAuthLogin",
    "btnSaveProvider", "btnTestProvider", "modalProviders", "modalEditProvider",
  ].map((id) => [id, element(id)]));
  const $ = (id) => {
    assert.ok(elements.has(id), `缺少 DOM mock：${id}`);
    return elements.get(id);
  };
  const publicConfig = (cfg) => clone({
    activeProviderId: cfg.activeProviderId, activeModel: cfg.activeModel,
    keylessFallbackEnabled: cfg.keylessFallbackEnabled === true,
    providers: cfg.providers.map(publicProvider),
  });
  const state = { config: publicConfig(raw) };
  const handlers = {};
  register({ handle: (name, callback) => { handlers[name] = callback; } }, { cfg: raw, publicConfig });
  const controls = { updateConfig: async (patch) => { Object.assign(raw, patch); } };
  const emsoder = {
    async getProviderPresets() { calls.presets++; return clone(presets); },
    async upsertProvider(provider) {
      calls.upsert.push(clone(provider));
      return handlers["providers:upsert"]({}, provider);
    },
    async updateConfig(patch) {
      calls.update.push(clone(patch));
      await controls.updateConfig(patch);
      return publicConfig(raw);
    },
    async setActiveProvider(providerId, model) {
      calls.active.push({ providerId, model });
      return handlers["providers:set-active"]({}, { providerId, model });
    },
    // 只测配置回填，不需要构建服务商列表 DOM。
    async listProviders() { calls.list++; return []; },
  };
  const EmsoderDom = {
    escapeHtml: (value) => String(value),
    toast: (...args) => calls.toast.push(args),
    openModal(id) { calls.open.push(id); $(id).classList.add("show"); },
    closeModal(id) { calls.close.push(id); $(id).classList.remove("show"); },
  };
  const window = { EmsoderApp: {
    refreshModelChips() { calls.chips++; },
    refreshQuestModels() { calls.quest++; },
  } };
  vm.runInNewContext(rendererSource, {
    EmsoderState: { state, $ }, emsoder, EmsoderDom, window, URL, setTimeout, clearTimeout,
    document: { createElement() { throw new Error("此测试不应构建服务商列表 DOM"); } },
  }, { filename: rendererPath });
  return { $, state, raw, calls, controls, api: window.EmsoderProviders, publicConfig };
}

function provider(overrides = {}) {
  return {
    id: "p", name: "测试服务商", type: "openai", baseUrl: "https://provider.test/v1",
    models: ["first", "selected"], enabled: true, ...overrides,
  };
}
function assertNoSecrets(value) {
  const text = JSON.stringify(value);
  for (const secret of secrets) assert.ok(!text.includes(secret), `公开值或请求泄露凭据：${secret}`);
}
let passed = 0;
let failed = 0;
async function test(name, run) {
  try {
    await run();
    passed++;
    console.log(`OK ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}\n${error.stack || error}`);
  }
}

(async () => {
  await test("切换 Pollinations 清空外站已输入的 API Key 与 OAuth 字段", async () => {
    const h = harness();
    await h.api.loadPresets();
    assert.equal(h.calls.presets, 1);
    h.api.openEdit(null);
    assert.equal(h.$("pfId").disabled, false);
    h.$("pfApiKey").value = "FOREIGN_API_KEY";
    for (const id of oauthFields) h.$(id).value = "外站 OAuth 字段";
    h.api.applyPreset("pollinations");
    assert.equal(h.$("pfApiKey").value, "");
    for (const id of oauthFields) assert.equal(h.$(id).value, "");
    assert.equal(h.$("pfId").value, presets.pollinations.id);
    assert.equal(h.$("pfModels").value, "openai");
    assert.equal(h.$("pfEnabled").value, "true");
    assert.equal(h.$("pfKeylessNotice").hidden, false);
    assert.ok(h.$("pfApiKey").placeholder.includes("自己的 Key"));
    assert.ok(h.$("modalEditProvider").classList.contains("show"));
  });

  await test("预设只提交一次 resetAuth；再次保存保留后来配置的 own key", async () => {
    const foreign = provider({
      apiKey: "FOREIGN_API_KEY", headers: { Authorization: "FOREIGN_HEADER" },
      oauth: { authorizeUrl: "https://foreign.test/auth", tokenUrl: "https://foreign.test/token", clientId: "foreign", scopes: "chat" },
      oauthTokens: { accessToken: "FOREIGN_TOKEN" },
    });
    const h = harness({ providers: [foreign] });
    await h.api.loadPresets();
    h.api.openEdit(h.state.config.providers[0]);
    h.$("pfApiKey").value = "FOREIGN_API_KEY";
    h.api.applyPreset("pollinations");
    assert.equal(h.$("pfId").value, "p", "编辑已有服务商时 ID 保持不变");
    assert.equal(h.$("pfId").disabled, true);
    for (const id of oauthFields) assert.equal(h.$(id).value, "");
    const saved = await h.api.saveFromForm(false, { setActive: false });
    const request = h.calls.upsert[0];
    assert.equal(request.chatPath, "/openai");
    assert.equal(request.keyless, true);
    assert.equal(request.timeoutMs, 120000);
    assert.equal(request.resetAuth, true);
    assert.equal(request.apiKey, "");
    assert.equal(has(request, "oauth"), false);
    assert.deepEqual(clone(saved), request);
    assert.equal(h.raw.providers[0].apiKey, "");
    for (const key of ["oauth", "oauthTokens", "headers", "resetAuth"]) assert.equal(has(h.raw.providers[0], key), false);
    h.raw.providers[0].apiKey = "OWN_API_KEY";
    await h.api.saveFromForm(false, { setActive: false });
    assert.equal(h.calls.upsert.length, 2);
    assert.equal(has(h.calls.upsert[1], "resetAuth"), false);
    assert.equal(h.raw.providers[0].apiKey, "OWN_API_KEY");
    assert.equal(h.state.config.providers[0].apiKeyConfigured, true);
    assertNoSecrets(h.calls.upsert);
    assertNoSecrets(h.state.config);
    assert.equal(h.calls.active.length, 0);
    assert.equal(h.calls.chips, 2);
    assert.equal(h.calls.quest, 2);
  });

  await test("普通 keyless 编辑保留 own 凭据及配置标志，不发送 resetAuth", async () => {
    const own = provider({
      keyless: true, chatPath: "/own-chat", timeoutMs: 65432, apiKey: "OWN_API_KEY",
      headers: { Authorization: "OWN_HEADER" },
      oauth: { authorizeUrl: "https://provider.test/auth", tokenUrl: "https://provider.test/token", clientId: "own-client", scopes: "chat" },
      oauthTokens: { accessToken: "OWN_TOKEN" },
    });
    const h = harness({ providers: [own] });
    const p = h.state.config.providers[0];
    assert.equal(p.apiKeyConfigured, true);
    assert.equal(p.oauthConfigured, true);
    assert.equal(p.oauthConnected, true);
    assertNoSecrets(p);
    h.api.openEdit(p);
    assert.equal(h.$("pfApiKey").value, "");
    assert.equal(h.$("pfApiKey").placeholder, "已配置（输入新值以替换）");
    assert.equal(h.$("pfApiKey").type, "password");
    assert.equal(h.$("pfOAuthStatus").textContent, "已授权（token 已保存）");
    assert.deepEqual(oauthFields.map((id) => h.$(id).value), Object.values(own.oauth));
    h.$("pfName").value = "修改名称";
    await h.api.saveFromForm(false, { setActive: false });
    const request = h.calls.upsert[0];
    assert.equal(request.name, "修改名称");
    assert.equal(request.keyless, true);
    assert.equal(request.chatPath, "/own-chat");
    assert.equal(request.timeoutMs, 65432);
    assert.equal(request.apiKey, "");
    assert.equal(has(request, "resetAuth"), false);
    for (const key of ["apiKey", "headers", "oauthTokens"]) assert.deepEqual(clone(h.raw.providers[0][key]), own[key]);
    assertNoSecrets(request);
    assertNoSecrets(h.state.config);
  });

  await test("未连接但已配置 OAuth 的普通编辑显示配置提示", async () => {
    const h = harness({ providers: [provider({ oauth: {
      authorizeUrl: "https://provider.test/auth", tokenUrl: "https://provider.test/token", clientId: "own-client",
    } })] });
    h.api.openEdit(h.state.config.providers[0]);
    assert.equal(h.$("pfApiKey").placeholder, "未配置");
    assert.equal(h.$("pfOAuthStatus").textContent, "已配置，点「OAuth 登录」完成授权");
    await h.api.saveFromForm(false, { setActive: false });
    assert.equal(has(h.calls.upsert[0], "resetAuth"), false);
    assert.equal(h.calls.upsert[0].oauth.clientId, "own-client");
  });

  await test("兜底 checkbox false→true→false 保存与重新打开回填一致", async () => {
    const h = harness();
    const toggle = h.$("keylessFallbackToggle");
    toggle.checked = true;
    await h.api.show();
    assert.equal(toggle.checked, false);
    for (const enabled of [true, false]) {
      toggle.checked = enabled;
      const pending = toggle.dispatch("change");
      assert.equal(toggle.disabled, true);
      await pending;
      assert.equal(toggle.disabled, false);
      assert.equal(toggle.checked, enabled);
      assert.equal(h.state.config.keylessFallbackEnabled, enabled);
      assert.deepEqual(h.calls.update.at(-1), { keylessFallbackEnabled: enabled });
      toggle.checked = !enabled;
      await h.api.show();
      assert.equal(toggle.checked, enabled);
    }
    assert.equal(h.calls.list, 3);
    assert.equal(h.calls.toast.length, 2);
  });

  for (const before of [false, true]) {
    await test(`兜底保存失败恢复 checked=${before} 并解除 disabled`, async () => {
      const h = harness({ keylessFallbackEnabled: before });
      await h.api.show();
      const toggle = h.$("keylessFallbackToggle");
      h.controls.updateConfig = async () => { throw new Error("模拟保存失败"); };
      toggle.checked = !before;
      const pending = toggle.dispatch("change");
      assert.equal(toggle.disabled, true);
      await pending;
      assert.equal(toggle.checked, before);
      assert.equal(toggle.disabled, false);
      assert.equal(h.state.config.keylessFallbackEnabled, before);
      assert.equal(h.raw.keylessFallbackEnabled, before);
      assert.deepEqual(h.calls.update, [{ keylessFallbackEnabled: !before }]);
      assert.equal(h.calls.toast.at(-1)[1], true);
      assert.ok(h.calls.toast.at(-1)[0].includes("模拟保存失败"));
      await h.api.show();
      assert.equal(toggle.checked, before);
    });
  }

  await test("legacy 与 gen 端点均显示 notice；第三方 URL 和不完整输入隐藏", async () => {
    const h = harness();
    for (const baseUrl of ["https://text.pollinations.ai", "https://gen.pollinations.ai/v1"]) {
      h.api.openEdit(provider({ baseUrl }));
      assert.equal(h.$("pfKeylessNotice").hidden, false);
      assert.ok(h.$("pfApiKey").placeholder.includes("自己的 Key"));
    }
    for (const baseUrl of [
      "https://provider.test/v1", "https://text.pollinations.ai.evil.test/v1",
      "https://provider.test/text.pollinations.ai", "https://gen.pollinations.ai@provider.test/v1", "https://",
    ]) {
      h.$("pfBaseUrl").value = baseUrl;
      await h.$("pfBaseUrl").dispatch("input");
      assert.equal(h.$("pfKeylessNotice").hidden, true, baseUrl);
    }
    h.$("pfBaseUrl").value = "https://text.pollinations.ai/openai";
    await h.$("pfBaseUrl").dispatch("input");
    assert.equal(h.$("pfKeylessNotice").hidden, false);
    h.api.openEdit(provider());
    assert.equal(h.$("pfKeylessNotice").hidden, true);
  });

  await test("默认保存非 active 服务商不强行切换，并关闭编辑弹窗", async () => {
    const h = harness();
    h.api.openEdit(provider());
    await h.api.saveFromForm();
    assert.equal(h.calls.active.length, 0);
    assert.equal(h.state.config.activeProviderId, "primary");
    assert.equal(h.state.config.activeModel, "primary-model");
    assert.deepEqual(h.calls.close, ["modalEditProvider"]);
    assert.equal(h.$("modalEditProvider").classList.contains("show"), false);
    assert.equal(h.calls.list, 1);
    // saveFromForm 未 await showProviders，等待它完成异步列表刷新。
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(h.$("modalProviders").classList.contains("show"));
    assert.equal(h.calls.chips, 1);
    assert.equal(h.calls.quest, 1);
  });

  await test("保存原 active 服务商保留已选的非首个 model", async () => {
    const h = harness({ activeProviderId: "p", activeModel: "selected" });
    h.api.openEdit(provider());
    await h.api.saveFromForm(false);
    assert.deepEqual(h.calls.active, [{ providerId: "p", model: "selected" }]);
    assert.equal(h.state.config.activeProviderId, "p");
    assert.equal(h.state.config.activeModel, "selected");
  });

  await test("明确 forceActive 可主动切换，原 model 有效时保持不变", async () => {
    const h = harness({ activeModel: "selected" });
    h.api.openEdit(provider());
    await h.api.saveFromForm(false, { forceActive: true });
    assert.deepEqual(h.calls.active, [{ providerId: "p", model: "selected" }]);
    assert.equal(h.state.config.activeProviderId, "p");
    assert.equal(h.state.config.activeModel, "selected");
  });

  await test("无 active 时保存选首个 model；setActive:false 不主动设置", async () => {
    for (const setActive of [true, false]) {
      const h = harness({ activeProviderId: "", activeModel: "" });
      h.api.openEdit(provider());
      await h.api.saveFromForm(false, { setActive });
      assert.deepEqual(h.calls.active, setActive ? [{ providerId: "p", model: "first" }] : []);
      assert.equal(h.state.config.activeProviderId, setActive ? "p" : "");
    }
  });

  await test("Pollinations keyless 请求及 publicConfig 均不含 secret 值", async () => {
    const h = harness({ providers: [provider({
      id: "primary", apiKey: "FOREIGN_API_KEY", headers: { Authorization: "FOREIGN_HEADER" },
      oauthTokens: { accessToken: "FOREIGN_TOKEN" },
    })] });
    await h.api.loadPresets();
    h.api.openEdit(null);
    h.$("pfPreset").value = "pollinations";
    await h.$("pfPreset").dispatch("change");
    await h.api.saveFromForm(false);
    const request = h.calls.upsert[0];
    assert.equal(request.id, "pollinations-keyless");
    assert.equal(request.apiKey, "");
    assert.equal(request.keyless, true);
    assert.equal(request.chatPath, "/openai");
    assert.equal(request.timeoutMs, 120000);
    for (const key of ["headers", "oauth", "oauthTokens", "apiKeyConfigured"]) assert.equal(has(request, key), false);
    assertNoSecrets(request);
    const pub = h.publicConfig(h.raw);
    assert.deepEqual(h.state.config, pub);
    assertNoSecrets(pub);
    for (const p of pub.providers) {
      for (const key of ["apiKey", "headers", "oauthTokens", "resetAuth"]) assert.equal(has(p, key), false);
    }
    const p = pub.providers.find((item) => item.id === request.id);
    assert.equal(p.keyless, true);
    assert.equal(p.chatPath, "/openai");
    assert.equal(p.timeoutMs, 120000);
    assert.equal(p.apiKeyConfigured, false);
    assert.equal(pub.providers.find((item) => item.id === "primary").apiKeyConfigured, true);
    assert.equal(h.raw.providers.find((item) => item.id === "primary").apiKey, "FOREIGN_API_KEY");
    assert.equal(pub.activeProviderId, "primary");
    assert.equal(h.calls.active.length, 0);
  });

  console.log(`${failed ? "FAIL" : "PASS"} ${passed} 个 keyless UI 回归用例；失败 ${failed}`);
  if (failed) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
