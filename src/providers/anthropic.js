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

function splitSystem(messages) {
  const systemParts = [];
  const out = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id,
            content: m.content,
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const content = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        let input = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          input = { raw: tc.function.arguments };
        }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return { system: systemParts.join("\n\n"), messages: out };
}

function toAnthropicTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

async function* streamAnthropicChat(provider, req) {
  const url = joinUrl(provider.baseUrl || "https://api.anthropic.com", "/v1/messages");
  const { system, messages } = splitSystem(req.messages);
  const body = {
    model: req.model,
    messages,
    max_tokens: req.maxTokens || 4096,
    stream: true,
    temperature: req.temperature ?? 0.2,
  };
  if (system) body.system = system;
  const tools = toAnthropicTools(req.tools);
  if (tools) body.tools = tools;

  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-api-key": provider.apiKey || "",
    ...(provider.headers || {}),
  };

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
        yield {
          type: "error",
          error: err?.message === "Request timeout" ? "请求超时" : "已停止",
        };
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
    const toolState = new Map();

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
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }

          if (json.type === "content_block_delta") {
            const delta = json.delta || {};
            if (delta.type === "text_delta" && delta.text) {
              yield { type: "text", text: delta.text };
            }
            if (delta.type === "input_json_delta" && delta.partial_json) {
              const index = json.index ?? 0;
              const st = toolState.get(index);
              if (st) {
                st.arguments += delta.partial_json;
                yield {
                  type: "tool_call",
                  toolCall: {
                    index,
                    id: st.id,
                    type: "function",
                    function: { name: st.name, arguments: st.arguments },
                  },
                };
              }
            }
          }
          if (json.type === "content_block_start") {
            const block = json.content_block;
            if (block?.type === "tool_use") {
              const index = json.index ?? 0;
              toolState.set(index, {
                id: block.id,
                name: block.name,
                arguments: "",
              });
              yield {
                type: "tool_call",
                toolCall: {
                  index,
                  id: block.id,
                  type: "function",
                  function: { name: block.name, arguments: "" },
                },
              };
            }
          }
          if (json.type === "message_start" && json.message?.usage) {
            yield {
              type: "usage",
              usage: normalizeAnthropicUsage(json.message.usage),
            };
          }
          if (json.type === "message_delta" && json.usage) {
            yield { type: "usage", usage: normalizeAnthropicUsage(json.usage) };
          }
          if (json.type === "message_stop") {
            yield { type: "done" };
            return;
          }
          if (json.type === "error") {
            yield {
              type: "error",
              error: json.error?.message || JSON.stringify(json.error),
            };
            return;
          }
        }
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

async function chatAnthropicOnce(provider, req) {
  const url = joinUrl(provider.baseUrl || "https://api.anthropic.com", "/v1/messages");
  const { system, messages } = splitSystem(req.messages);
  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-api-key": provider.apiKey || "",
    ...(provider.headers || {}),
  };
  const body = {
    model: req.model,
    messages,
    max_tokens: req.maxTokens || 4096,
    stream: false,
    temperature: req.temperature ?? 0.2,
  };
  if (system) body.system = system;

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
      const content = (json.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (req.returnUsage) {
        return {
          content,
          usage: json.usage ? normalizeAnthropicUsage(json.usage) : null,
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
          {
            name:
              name === "TimeoutError" || /timeout/i.test(msg)
                ? "TimeoutError"
                : "AbortError",
            cause: err,
          }
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

function normalizeAnthropicUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const cacheRead =
    usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: (Number(input) || 0) + (Number(output) || 0),
    cached_tokens: Number(cacheRead) || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: cacheRead,
    _raw: usage,
  };
}

module.exports = {
  streamAnthropicChat,
  chatAnthropicOnce,
  normalizeAnthropicUsage,
};
