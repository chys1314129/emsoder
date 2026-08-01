const { getActiveModel, getActiveProvider } = require("../core/config");
const { streamOpenAIChat, chatOpenAIOnce } = require("./openai");
const { streamAnthropicChat, chatAnthropicOnce } = require("./anthropic");
const { fetchWithTimeout } = require("./httpUtil");

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

/** 整段异步操作硬超时（含读 body / JSON 解析） */
function withHardTimeout(promise, ms, label = "请求") {
  const timeoutMs = Math.max(2000, Number(ms) || 12000);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        Object.assign(
          new Error(
            `${label}超时（${Math.round(timeoutMs / 1000)}s），请检查 Base URL / 网络 / API Key`
          ),
          { name: "TimeoutError" }
        )
      );
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Connectivity test — short timeout, no long retries, always returns {ok,message}.
 */
async function testProvider(cfg, provider, model) {
  const start = Date.now();
  try {
    if (!provider?.baseUrl) {
      return { ok: false, message: "未配置 Base URL", latencyMs: 0 };
    }
    const useModel = model || (provider.models && provider.models[0]);
    if (!useModel) {
      return {
        ok: false,
        message: "未配置模型（请先填写模型列表，或点「刷新模型」拉取）",
        latencyMs: 0,
      };
    }

    // 先快速探活 /models（失败不阻断 chat 测试）
    let probeNote = "";
    try {
      const base = String(provider.baseUrl || "").replace(/\/+$/, "");
      const headers = { ...(provider.headers || {}) };
      if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
      if (provider.type !== "anthropic") {
        const res = await fetchWithTimeout(`${base}/models`, { headers }, 6000);
        // 必须完整消费/取消 body，但不能二次读取
        try {
          if (res.ok) {
            await withHardTimeout(res.arrayBuffer(), 4000, "读取 models 响应");
            probeNote = " · models端点OK";
          } else {
            await withHardTimeout(res.arrayBuffer(), 2000, "读取 models 错误体");
            probeNote = ` · models端点HTTP${res.status}`;
          }
        } catch {
          try {
            await res.body?.cancel?.();
          } catch {
            /* ignore */
          }
          probeNote = res.ok ? " · models端点OK" : ` · models端点HTTP${res.status}`;
        }
      }
    } catch (e) {
      probeNote = " · models端点不可达";
    }

    const text = await withHardTimeout(
      chatOnce(cfg, {
        provider,
        model: useModel,
        messages: [{ role: "user", content: "Reply with exactly: EMSoder OK" }],
        maxTokens: 32,
        temperature: 0,
        timeoutMs: 10000,
        maxRetries: 0,
      }),
      14000,
      "连通性测试"
    );

    const preview =
      typeof text === "string"
        ? text
        : text && typeof text === "object" && text.content != null
          ? String(text.content)
          : String(text ?? "");

    return {
      ok: true,
      message: `OK · ${useModel}${probeNote} · ${JSON.stringify(preview.slice(0, 80))}`,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      message: err?.message || String(err),
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Pull remote model list with hard abortable timeout covering body read.
 */
async function listRemoteModels(provider) {
  if (!provider) return [];
  if (provider.type === "anthropic") return (provider.models || []).slice();

  const base = String(provider.baseUrl || "").replace(/\/+$/, "");
  if (!base) {
    const err = new Error("未配置 Base URL");
    err.fallbackModels = (provider.models || []).slice();
    throw err;
  }

  // 常见 OpenAI 兼容路径：base 带 /v1 时直接 /models；不带时优先 /v1/models 再 /models
  const endsWithV1 = /\/v1$/i.test(base);
  const candidates = endsWithV1
    ? [`${base}/models`]
    : [`${base}/v1/models`, `${base}/models`];
  const urls = [...new Set(candidates)];

  const headers = { ...(provider.headers || {}) };
  if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
    // 部分国内网关也认这个
    if (!headers["api-key"]) headers["api-key"] = provider.apiKey;
  }

  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, { method: "GET", headers }, 10000);
      // 关键：超时必须覆盖 body 读取，否则会永远挂起
      const rawText = await withHardTimeout(
        res.text(),
        8000,
        "读取模型列表响应"
      );
      if (!res.ok) {
        lastErr = new Error(
          `HTTP ${res.status}${rawText ? ": " + rawText.slice(0, 160) : ""}`
        );
        continue;
      }
      let json;
      try {
        json = rawText ? JSON.parse(rawText) : {};
      } catch {
        lastErr = new Error("模型列表不是合法 JSON");
        continue;
      }
      const data = json.data || json.models || json.data?.models || json || [];
      const arr = Array.isArray(data) ? data : [];
      const ids = arr
        .map((m) => (typeof m === "string" ? m : m?.id || m?.name || m?.model))
        .filter((x) => typeof x === "string" && x.trim());
      if (!ids.length) {
        lastErr = new Error("接口未返回模型列表");
        continue;
      }
      const seen = new Set();
      const uniq = [];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        uniq.push(id);
      }
      return uniq;
    } catch (err) {
      lastErr = err;
    }
  }

  const err = lastErr || new Error("拉取模型列表失败");
  err.fallbackModels = (provider.models || []).slice();
  throw err;
}

module.exports = {
  streamChat,
  chatOnce,
  testProvider,
  listRemoteModels,
  withHardTimeout,
};
