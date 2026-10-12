const {
  DEFAULT_TIMEOUT_MS,
  MAX_RETRIES,
  isRetryableError,
  sleep,
  mergeAbortSignals,
} = require("./httpUtil");

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

function toOpenAIMessages(messages) {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        content: m.content,
        tool_call_id: m.tool_call_id,
        name: m.name,
      };
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.tool_calls,
      };
    }
    // multimodal user content: array of {type:text|image_url}
    if (Array.isArray(m.content)) {
      return { role: m.role, content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

/** OpenAI / Gemini / DeepSeek 等兼容接口的思考档位 → reasoning_effort */
function applyOpenAIReasoning(body, req) {
  const effort = String(req.reasoningEffort || "").toLowerCase().trim();
  if (!effort || effort === "off" || effort === "none") return;
  // OpenAI o-series / gpt-5 等：low|medium|high；超高映射 high（多数网关无 xhigh）
  // 部分兼容网关（OpenRouter、硅基流动、DeepSeek reasoner）会忽略未知字段
  const map = {
    low: "low",
    medium: "medium",
    high: "high",
    ultra: "high",
  };
  const mapped = map[effort];
  if (!mapped) return;
  body.reasoning_effort = mapped;
  // Pi 传入的动态思考 token 预算：部分网关（OpenRouter/DeepSeek 系）认这个字段
  if (req.thinkingBudget && Number(req.thinkingBudget) > 0) {
    body.thinking_token_budget = Math.floor(Number(req.thinkingBudget));
  }
  // 部分新模型用 max_completion_tokens 且不接受 temperature
  // 不主动删 temperature，由网关自行忽略
}

async function* streamOpenAIChat(provider, req) {
  const path = provider.chatPath || "/chat/completions";
  const url = joinUrl(provider.baseUrl, path);
  const body = {
    model: req.model,
    messages: toOpenAIMessages(req.messages),
    stream: true,
    temperature: req.temperature ?? 0.2,
    // Ask OpenAI-compatible gateways for final usage chunk (incl. cache fields when available)
    stream_options: { include_usage: true },
  };
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  if (req.tools?.length) {
    body.tools = req.tools;
    body.tool_choice = "auto";
  }
  applyOpenAIReasoning(body, req);

  const headers = {
    "Content-Type": "application/json",
    ...(provider.headers || {}),
  };
  const auth = req.oauthBearerToken || provider.apiKey;
  if (auth) headers.Authorization = `Bearer ${auth}`;

  const timeoutMs = req.timeoutMs ?? provider.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (req.signal?.aborted) {
      yield { type: "error", error: "aborted" };
      return;
    }
    const { signal, cleanup } = mergeAbortSignals(req.signal, timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      cleanup();
      lastError = err;
      if (err?.name === "AbortError" || req.signal?.aborted) {
        yield { type: "error", error: err?.message === "Request timeout" ? "请求超时" : "已停止" };
        return;
      }
      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        await sleep(400 * (attempt + 1), req.signal);
        continue;
      }
      yield { type: "error", error: `Network error: ${err.message || err}` };
      return;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      cleanup();
      if (attempt < MAX_RETRIES && isRetryableError(null, res.status)) {
        await sleep(500 * (attempt + 1), req.signal);
        continue;
      }
      yield { type: "error", error: `HTTP ${res.status}: ${text.slice(0, 800)}` };
      return;
    }
    if (!res.body) {
      cleanup();
      yield { type: "error", error: "Empty response body" };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolAcc = new Map();
    let sawCompletion = false;

    function* parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        sawCompletion = true;
        yield { type: "done" };
        return;
      }
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      // A 200 SSE stream may carry authentication/quota errors, not choices.
      if (json.error) {
        const remote = json.error;
        const status = Number(remote.status ?? remote.statusCode ?? json.status);
        const errorCode = String(remote.code || "remote_error");
        yield { type: "error", status: Number.isFinite(status) ? status : null, errorCode,
          error: `Provider error ${Number.isFinite(status) ? status : ""} ${errorCode}: ${String(remote.message || remote).slice(0, 800)}` };
        return;
      }
      // usage often arrives on a trailing chunk (with or without choices)
      if (json.usage) {
        yield { type: "usage", usage: normalizeOpenAIUsage(json.usage) };
      }
      const choice = json.choices?.[0];
      if (!choice) return;
      const finishReason = choice.finish_reason;
      if (finishReason != null) {
        if (finishReason !== "stop" && finishReason !== "tool_calls") {
          yield { type: "error", errorCode: "incomplete_response",
            error: `响应未成功完成（finish_reason: ${finishReason}）` };
          return;
        }
        sawCompletion = true;
      }
      const delta = choice.delta || {};
      if (typeof delta.content === "string" && delta.content) {
        yield { type: "text", text: delta.content };
      }
      const reasoning = delta.reasoning_content || delta.reasoning;
      if (typeof reasoning === "string" && reasoning) {
        yield { type: "reasoning", text: reasoning };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = typeof tc.index === "number" ? tc.index : 0;
          let acc = toolAcc.get(index);
          if (!acc) {
            acc = {
              id: tc.id || `call_${index}`,
              type: "function",
              function: { name: "", arguments: "" },
            };
            toolAcc.set(index, acc);
          }
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.function.name += tc.function.name;
          if (tc.function?.arguments) {
            acc.function.arguments += tc.function.arguments;
          }
          yield {
            type: "tool_call",
            toolCall: {
              index,
              id: acc.id,
              type: "function",
              function: {
                name: acc.function.name,
                arguments: acc.function.arguments,
              },
            },
          };
        }
      }
    }

    try {
      while (true) {
        if (req.signal?.aborted) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          yield { type: "error", error: "aborted" };
          return;
        }
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        if (done && buffer) {
          lines.push(buffer);
          buffer = "";
        }
        for (const line of lines) {
          for (const event of parseLine(line)) {
            yield event;
            if (event.type === "error" || event.type === "done") return;
          }
        }
        if (done) break;
      }
      if (toolAcc.size && !sawCompletion) {
        yield { type: "error", errorCode: "incomplete_response",
          error: "工具调用流提前结束，缺少成功完成标记" };
        return;
      }
      yield { type: "done" };
      return;
    } finally {
      cleanup();
      try {
        reader.releaseLock?.();
      } catch {
        /* ignore */
      }
    }
  }

  yield {
    type: "error",
    error: `Network error after retries: ${lastError?.message || lastError || "unknown"}`,
  };
}

async function chatOpenAIOnce(provider, req) {
  const path = provider.chatPath || "/chat/completions";
  const url = joinUrl(provider.baseUrl, path);
  const headers = {
    "Content-Type": "application/json",
    ...(provider.headers || {}),
  };
  const auth = req.oauthBearerToken || provider.apiKey;
  if (auth) headers.Authorization = `Bearer ${auth}`;

  const body = {
    model: req.model,
    messages: toOpenAIMessages(req.messages),
    stream: false,
    temperature: req.temperature ?? 0.2,
  };
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  applyOpenAIReasoning(body, req);

  const timeoutMs = req.timeoutMs ?? provider.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries =
    req.maxRetries != null ? Math.max(0, Number(req.maxRetries) || 0) : MAX_RETRIES;
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { signal, cleanup } = mergeAbortSignals(req.signal, timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        cleanup();
        if (attempt < maxRetries && isRetryableError(null, res.status)) {
          await sleep(500 * (attempt + 1), req.signal);
          continue;
        }
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
      }
      const json = await res.json();
      cleanup();
      const content = json.choices?.[0]?.message?.content || "";
      if (req.returnUsage) {
        return {
          content,
          usage: json.usage ? normalizeOpenAIUsage(json.usage) : null,
        };
      }
      return content;
    } catch (err) {
      cleanup();
      lastErr = err;
      const name = err?.name || "";
      const msg = String(err?.message || err || "");
      if (
        name === "AbortError" ||
        name === "TimeoutError" ||
        req.signal?.aborted ||
        /timeout|aborted/i.test(msg)
      ) {
        throw Object.assign(
          new Error(
            name === "TimeoutError" || /timeout/i.test(msg)
              ? `请求超时（${Math.round(timeoutMs / 1000)}s）`
              : "已停止"
          ),
          { name: name === "TimeoutError" || /timeout/i.test(msg) ? "TimeoutError" : "AbortError", cause: err }
        );
      }
      if (attempt < maxRetries && isRetryableError(err)) {
        await sleep(400 * (attempt + 1), req.signal);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("chat failed");
}

function normalizeOpenAIUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const cached =
    usage.prompt_tokens_details?.cached_tokens ??
    usage.input_tokens_details?.cached_tokens ??
    usage.cached_tokens ??
    usage.prompt_cache_hit_tokens ??
    0;
  return {
    prompt_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
    cached_tokens: Number(cached) || 0,
    prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens,
    prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens,
    _raw: usage,
  };
}

module.exports = { streamOpenAIChat, chatOpenAIOnce, normalizeOpenAIUsage };
