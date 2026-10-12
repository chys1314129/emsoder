const { getActiveModel, getActiveProvider } = require("../core/config");
const { streamOpenAIChat, chatOpenAIOnce } = require("./openai");
const { streamAnthropicChat, chatAnthropicOnce } = require("./anthropic");
const { fetchWithTimeout } = require("./httpUtil");
const { getOAuthBearerToken } = require("../core/oauth");
const {
  POLLINATIONS_PROVIDER,
  isPollinationsProvider,
  streamPollinationsChat,
  chatPollinationsOnce,
  listPollinationsModels,
} = require("./pollinations");

function keylessFallback(cfg, req, primary) {
  // Test/completion paths that explicitly select a provider must not silently switch.
  if (cfg.keylessFallbackEnabled !== true || req.provider || req.allowFallback === false || isPollinationsProvider(primary)) return null;
  const p = (cfg.providers || []).find((p) => p.id === POLLINATIONS_PROVIDER.id);
  if (!p || p.enabled === false || !isPollinationsProvider(p) || new URL(p.baseUrl).hostname !== "text.pollinations.ai") return null;
  return { ...POLLINATIONS_PROVIDER, ...p, apiKey: "", headers: undefined, oauth: undefined };
}

async function* dispatchStream(provider, full) {
  if (isPollinationsProvider(provider)) yield* streamPollinationsChat(provider, full);
  else if (provider.type === "anthropic") yield* streamAnthropicChat(provider, full);
  else yield* streamOpenAIChat(provider, full);
}

function resolveProvider(cfg, provider) {
  const p = provider || getActiveProvider(cfg);
  if (!p) {
    throw new Error(
      "未配置模型服务商。请在设置里添加 Ollama / DeepSeek / OpenAI 兼容接口。"
    );
  }
  return p;
}

function normalizeReasoningEffort(v) {
  const s = String(v || "").toLowerCase().trim();
  if (s === "off" || s === "none" || s === "关闭" || s === "关闭思考") return "off";
  if (s === "low" || s === "medium" || s === "high" || s === "ultra") return s;
  // Chinese aliases
  if (s === "低") return "low";
  if (s === "中") return "medium";
  if (s === "高") return "high";
  if (s === "超高") return "ultra";
  return "medium";
}

async function* streamChat(cfg, req) {
  const provider = resolveProvider(cfg, req.provider);
  const model = req.model || getActiveModel(cfg);
  const full = {
    ...req,
    model,
    temperature: req.temperature ?? cfg.temperature ?? 0.2,
    // 0 / 空 = 自动（不发 max_tokens，让服务端用模型默认上限）
    maxTokens: req.maxTokens ?? cfg.maxTokens ?? 0,
    reasoningEffort: normalizeReasoningEffort(
      req.reasoningEffort ?? cfg.reasoningEffort
    ),
  };
  // The Pollinations lane only uses its own explicit key, never OAuth credentials.
  if (isPollinationsProvider(provider)) {
    yield* streamPollinationsChat(provider, full);
    return;
  }
  // Pi OAuth provider：服务商配置了 OAuth 时用 Bearer token（自动刷新）覆盖 apiKey
  try {
    const oauthToken = await getOAuthBearerToken(cfg, provider.id);
    if (typeof oauthToken === "string" && oauthToken) full.oauthBearerToken = oauthToken;
  } catch { /* OAuth 不可用时回退 apiKey */ }
  const fallback = keylessFallback(cfg, req, provider);
  let committed = false;
  let primaryError = null;
  const pending = [];
  try {
    for await (const chunk of dispatchStream(provider, full)) {
      if (chunk.type === "error") { primaryError = chunk; break; }
      if (["text", "reasoning", "tool_call"].includes(chunk.type)) committed = true;
      if (!committed && fallback) pending.push(chunk);
      else {
        for (const event of pending.splice(0)) yield event;
        yield chunk;
      }
    }
  } catch (error) {
    primaryError = { type: "error", error: String(error?.message || error) };
  }
  if (!primaryError && !committed && fallback) {
    primaryError = { type: "error", error: "Empty response from primary provider" };
  }
  if (!primaryError) {
    for (const event of pending) yield event;
    return;
  }
  // Never replay after output/tools, on user stop, or to bypass quota/auth restrictions.
  const blocked = [401, 402, 403, 429].includes(Number(primaryError.status)) || /\b(?:401|402|403|429)\b|quota|credits|billing|balance|rate.?limit|too many|invalid.*key|unauthorized|forbidden|额度|欠费|限流|无权限/i.test(`${primaryError.errorCode || ""} ${primaryError.error || ""}`);
  const unavailable = /\b5\d\d\b|network|fetch failed|econn|enotfound|socket|timeout|超时|empty response|empty.*body|不可达/i.test(primaryError.error || "");
  if (!fallback || !unavailable || committed || req.signal?.aborted || /abort|已停止/i.test(primaryError.error || "") || blocked) {
    yield primaryError;
    return;
  }
  yield { type: "status", status: `主服务商不可用，正在切换 Pollinations 无密钥（已开启自动兜底）` };
  yield* streamPollinationsChat(fallback, { ...full, model: "openai", oauthBearerToken: undefined });
}

async function chatOnce(cfg, req) {
  const provider = resolveProvider(cfg, req.provider);
  const model = req.model || getActiveModel(cfg);
  const full = {
    ...req,
    model,
    temperature: req.temperature ?? cfg.temperature ?? 0.2,
    maxTokens: req.maxTokens ?? cfg.maxTokens ?? 0,
    reasoningEffort: normalizeReasoningEffort(
      req.reasoningEffort ?? cfg.reasoningEffort
    ),
  };
  if (isPollinationsProvider(provider)) {
    const result = await chatPollinationsOnce(provider, full);
    if (result?.type === "error") throw Object.assign(new Error(result.error), { status: result.status, errorCode: result.errorCode });
    return result;
  }
  try {
    const oauthToken = await getOAuthBearerToken(cfg, provider.id);
    if (typeof oauthToken === "string" && oauthToken) full.oauthBearerToken = oauthToken;
  } catch { /* OAuth 不可用时回退 apiKey */ }
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
      if (provider.type !== "anthropic" && !isPollinationsProvider(provider)) {
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
  if (isPollinationsProvider(provider)) {
    const result = await listPollinationsModels({ ...provider, timeoutMs: 12000, maxRetries: 0 });
    if (result?.type === "error") {
      throw Object.assign(new Error(result.error), { status: result.status, errorCode: result.errorCode, fallbackModels: [...(provider.models || [])] });
    }
    return result;
  }
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
  normalizeReasoningEffort,
};
