const { getActiveModel, getActiveProvider } = require("../core/config");
const { streamOpenAIChat, chatOpenAIOnce } = require("./openai");
const { streamAnthropicChat, chatAnthropicOnce } = require("./anthropic");

function resolveProvider(cfg, provider) {
  const p = provider || getActiveProvider(cfg);
  if (!p) {
    throw new Error(
      "未配置模型服务商。请在设置里添加 Ollama / DeepSeek / OpenAI 兼容接口。"
    );
  }
  return p;
}

async function* streamChat(cfg, req) {
  const provider = resolveProvider(cfg, req.provider);
  const model = req.model || getActiveModel(cfg);
  const full = {
    ...req,
    model,
    temperature: req.temperature ?? cfg.temperature ?? 0.2,
    maxTokens: req.maxTokens ?? cfg.maxTokens ?? 8192,
  };
  if (provider.type === "anthropic") {
    yield* streamAnthropicChat(provider, full);
  } else {
    yield* streamOpenAIChat(provider, full);
  }
}

async function chatOnce(cfg, req) {
  const provider = resolveProvider(cfg, req.provider);
  const model = req.model || getActiveModel(cfg);
  const full = {
    ...req,
    model,
    temperature: req.temperature ?? cfg.temperature ?? 0.2,
    maxTokens: req.maxTokens ?? cfg.maxTokens ?? 8192,
  };
  if (provider.type === "anthropic") {
    return chatAnthropicOnce(provider, full);
  }
  return chatOpenAIOnce(provider, full);
}

async function testProvider(cfg, provider, model) {
  const start = Date.now();
  try {
    const useModel = model || provider.models[0];
    if (!useModel) {
      return { ok: false, message: "未配置模型", latencyMs: 0 };
    }
    const text = await chatOnce(cfg, {
      provider,
      model: useModel,
      messages: [{ role: "user", content: "Reply with exactly: EMSoder OK" }],
      maxTokens: 32,
      temperature: 0,
    });
    return {
      ok: true,
      message: `OK · ${useModel} · ${JSON.stringify(String(text).slice(0, 80))}`,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      message: err.message || String(err),
      latencyMs: Date.now() - start,
    };
  }
}

async function listRemoteModels(provider) {
  if (provider.type === "anthropic") return provider.models.slice();
  const url = `${String(provider.baseUrl).replace(/\/+$/, "")}/models`;
  const headers = { ...(provider.headers || {}) };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return provider.models.slice();
    const json = await res.json();
    const data = json.data || json.models || [];
    const ids = data
      .map((m) => m.id || m.name)
      .filter((x) => typeof x === "string");
    return ids.length ? ids : provider.models.slice();
  } catch {
    return provider.models.slice();
  }
}

module.exports = { streamChat, chatOnce, testProvider, listRemoteModels };
