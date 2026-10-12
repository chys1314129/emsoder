const { createHash } = require("node:crypto");
const { normalizeOpenAIUsage } = require("./openai");
const { validateArguments } = require("../tools/validateArguments");

const POLLINATIONS_PROVIDER = Object.freeze({
  id: "pollinations-keyless",
  name: "Pollinations 无密钥",
  type: "openai",
  baseUrl: "https://text.pollinations.ai",
  chatPath: "/openai",
  models: Object.freeze(["openai"]),
  apiKey: "",
  keyless: true,
  enabled: true,
  timeoutMs: 120000,
});

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

function failure(errorCode, error, status = null) {
  return Object.assign(new Error(error), { errorCode, status });
}

function errorEvent(err) {
  return {
    type: "error",
    error: err.errorCode ? err.message : "Pollinations 请求失败",
    status: err.status ?? null,
    errorCode: err.errorCode || "invalid_response",
  };
}

function abortError(signal) {
  return signal.reason?.errorCode
    ? signal.reason
    : failure("aborted", "已停止");
}

function awaitAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(abortError(signal)); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (err) => { cleanup(); reject(err); }
    );
  });
}

function scopeFor(userSignal, timeoutMs, clock) {
  const controller = new AbortController();
  const stop = () => controller.abort(failure("aborted", "已停止"));
  if (userSignal?.aborted) stop();
  else userSignal?.addEventListener("abort", stop, { once: true });
  const timer = clock.setTimeout(
    () => controller.abort(failure("timeout", "Pollinations 请求超时（包含排队和响应读取）")),
    timeoutMs
  );
  return {
    signal: controller.signal,
    cleanup() {
      clock.clearTimeout(timer);
      userSignal?.removeEventListener("abort", stop);
      // 结束时停止仍在读取的底层 fetch；不能等待一个失去响应的 cancel。
      if (!controller.signal.aborted) controller.abort(failure("aborted", "已停止"));
    },
  };
}

function createScheduler(clock = realClock) {
  const states = new Map();
  function stateFor(key) {
    if (!states.has(key)) states.set(key, { next: -Infinity, blocked: -Infinity, queue: [], timer: null });
    return states.get(key);
  }
  function pump(state) {
    if (state.timer !== null) clock.clearTimeout(state.timer);
    state.timer = null;
    while (state.queue.length) {
      const item = state.queue[0];
      if (item.signal.aborted) { item.onAbort(); continue; }
      const delay = Math.max(state.next, state.blocked) - clock.now();
      if (delay > 0) {
        state.timer = clock.setTimeout(() => { state.timer = null; pump(state); }, delay);
        return;
      }
      state.queue.shift();
      item.signal.removeEventListener("abort", item.onAbort);
      state.next = clock.now() + (item.anonymous ? 16000 : 0);
      item.resolve();
    }
  }
  return {
    acquire(key, anonymous, signal) {
      if (signal.aborted) return Promise.reject(abortError(signal));
      const state = stateFor(key);
      return new Promise((resolve, reject) => {
        const item = { anonymous, signal, resolve, onAbort: null };
        item.onAbort = () => {
          const index = state.queue.indexOf(item);
          if (index < 0) return;
          state.queue.splice(index, 1);
          signal.removeEventListener("abort", item.onAbort);
          reject(abortError(signal));
          pump(state);
        };
        state.queue.push(item);
        signal.addEventListener("abort", item.onAbort, { once: true });
        pump(state);
      });
    },
    defer(key, ms) {
      const state = stateFor(key);
      state.blocked = Math.max(state.blocked, clock.now() + ms);
      pump(state);
    },
  };
}

// 同一 Node 进程中的模块副本共享队列；队列键不保存明文密钥。
const schedulerSymbol = Symbol.for("EMSoder.pollinations.scheduler");
const sharedScheduler = globalThis[schedulerSymbol] || (globalThis[schedulerSymbol] = createScheduler());
let testHooks = null;
function runtime() {
  return {
    clock: testHooks?.clock || realClock,
    scheduler: testHooks?.scheduler || sharedScheduler,
    fetch: testHooks?.fetch || globalThis.fetch,
  };
}

function isPollinationsProvider(provider) {
  try {
    const host = new URL(provider?.baseUrl).hostname;
    return host === "text.pollinations.ai" || host === "gen.pollinations.ai";
  } catch {
    return false;
  }
}

function endpointFor(provider, models = false) {
  let url;
  try { url = new URL(provider?.baseUrl); }
  catch { throw failure("invalid_endpoint", "Pollinations Base URL 无效"); }
  if (!isPollinationsProvider(provider) || url.protocol !== "https:" || url.username || url.password || url.port) {
    throw failure("invalid_endpoint", "仅允许 Pollinations 官方 HTTPS 主机，不允许 URL 凭据或自定义端口");
  }
  if (url.search || url.hash) throw failure("invalid_endpoint", "Pollinations Base URL 不允许查询参数或片段");
  const gen = url.hostname === "gen.pollinations.ai";
  if (gen && !String(provider.apiKey || "").trim()) {
    throw failure("auth", "gen.pollinations.ai 需要此服务商自己的 API Key，不是无密钥通道", 401);
  }
  const basePath = url.pathname.replace(/\/+$/, "");
  const allowed = gen ? ["", "/v1", "/v1/chat/completions"] : ["", "/openai", "/openai/chat/completions"];
  if (!allowed.includes(basePath)) throw failure("invalid_endpoint", "不支持的 Pollinations 接口路径");
  if (models) url.pathname = gen ? "/text/models" : "/models";
  else if (basePath.endsWith("/chat/completions") || (!gen && basePath === "/openai")) url.pathname = basePath;
  else {
    let path = provider.chatPath || (gen ? "/v1/chat/completions" : "/openai");
    if (gen && basePath === "/v1" && path === "/chat/completions") path = "/v1/chat/completions";
    if (!(gen ? ["/v1/chat/completions"] : ["/openai", "/openai/chat/completions"]).includes(path)) {
      throw failure("invalid_endpoint", "不支持的 Pollinations chatPath");
    }
    url.pathname = path;
  }
  return url.href;
}

function ownHeaders(provider, stream, models = false) {
  const headers = { Accept: stream ? "text/event-stream, application/json" : "application/json" };
  if (!models) headers["Content-Type"] = "application/json";
  // 只允许协商内容的必要头；Authorization 只能来自当前 provider.apiKey。
  for (const [name, value] of Object.entries(provider.headers || {})) {
    if (name.toLowerCase() === "accept" && typeof value === "string" && !/[\r\n]/.test(value)) headers.Accept = value;
  }
  const key = String(provider.apiKey || "").trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function textContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block?.type !== "text" || typeof block.text !== "string") {
        throw failure("unsupported_content", "Pollinations 文本通道不支持图片、音频或其他非文本块");
      }
      return block.text;
    }).join("\n");
  }
  throw failure("unsupported_content", "Pollinations 文本通道只支持字符串或 text blocks");
}

function makeBody(req, stream) {
  if (!Array.isArray(req.messages)) throw failure("invalid_request", "messages 必须为数组");
  const messages = req.messages.map((message) => {
    const out = { role: message.role, content: textContent(message.content) };
    if (message.role === "tool") {
      out.tool_call_id = message.tool_call_id;
      if (message.name) out.name = message.name;
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      out.content = out.content || null;
      out.tool_calls = message.tool_calls.map((call) => ({
        id: call.id, type: "function",
        function: { name: call.function?.name, arguments: call.function?.arguments },
      }));
    }
    return out;
  });
  const body = { model: req.model || "openai", messages, stream, temperature: req.temperature ?? 0.2 };
  if (req.maxTokens != null && Number(req.maxTokens) !== 0) {
    const max = Number(req.maxTokens);
    if (!Number.isInteger(max) || max < 0) throw failure("invalid_request", "maxTokens 必须是非负整数");
    body.max_tokens = max;
  }
  const efforts = { low: "low", medium: "medium", high: "high", ultra: "high" };
  const effort = String(req.reasoningEffort || "").trim().toLowerCase();
  if (Object.hasOwn(efforts, effort)) body.reasoning_effort = efforts[effort];
  if (req.tools?.length) {
    body.tools = req.tools.map((tool) => {
      if (tool.type !== "function" || typeof tool.function?.name !== "string" || !tool.function.name.trim()) {
        throw failure("invalid_request", "tools 必须包含具名 function");
      }
      const { name, description, parameters, strict } = tool.function;
      return { type: "function", function: { name, description, parameters, strict } };
    });
    body.tool_choice = "auto";
  }
  return body;
}

function cleanToolName(raw, allowed) {
  if (allowed.has(raw)) return raw;
  // 只移除已知 Harmony 命名边界，不做模糊匹配、子串匹配或未知命名空间猜测。
  const clean = raw.trim()
    .split(/<\|(?:channel|im_sep|im_end|end|return|fim_suffix)\|>/)[0].trim()
    .replace(/^to=/, "").replace(/^functions\./, "").replace(/:\d+$/, "").trim();
  if (allowed.has(clean)) return clean;
  throw failure("unknown_tool", "Pollinations 返回了不在请求白名单中的工具");
}

function validateTools(acc, allowed, schemas) {
  const ids = new Set();
  return [...acc.entries()].sort(([a], [b]) => a - b).map(([index, call]) => {
    const name = cleanToolName(call.name, allowed);
    let args;
    try { args = JSON.parse(call.arguments); }
    catch { throw failure("invalid_tool_arguments", "工具参数不是完整、合法的 JSON"); }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw failure("invalid_tool_arguments", "工具参数必须是 JSON object，不能为数组、null 或标量");
    }
    try { validateArguments(args, schemas.get(name)); }
    catch { throw failure("invalid_tool_arguments", `工具 ${name} 参数不符合请求的 schema`); }
    const id = call.id || `call_${index}`;
    if (ids.has(id)) throw failure("invalid_tool_call", "工具调用 ID 重复");
    ids.add(id);
    return { index, id, type: "function", function: { name, arguments: JSON.stringify(args) } };
  });
}

function httpFailure(status) {
  const info = {
    401: ["auth", "API Key 缺失或无效"],
    402: ["quota", "额度不足或需要付费；不会重试或绕过限制"],
    403: ["forbidden", "没有访问权限"],
    429: ["rate_limit", "触发限流，请稍后再试"],
    503: ["unavailable", "服务暂不可用"],
  }[status] || [status >= 500 ? "server_error" : "http_error", "HTTP 请求失败"];
  return failure(info[0], `Pollinations HTTP ${status}：${info[1]}`, status);
}

function remoteFailure(json) {
  const error = json.error;
  const status = Number(error?.status ?? error?.statusCode ?? json.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) return httpFailure(status);
  const code = String(error?.code || "").toLowerCase();
  if (/quota|credit|balance|payment|billing/.test(code)) return httpFailure(402);
  if (/rate_limit|too_many/.test(code)) return httpFailure(429);
  if (/auth|api_key/.test(code)) return httpFailure(401);
  return failure("remote_error", "Pollinations 返回错误 JSON", 200);
}

function retryDelay(res, clock) {
  const value = res.headers?.get?.("retry-after");
  if (value == null) return 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - clock.now()) : 1000;
}

async function fetchResponse(rt, url, opts, signal) {
  try {
    if (signal.aborted) throw abortError(signal);
    return await awaitAbort(rt.fetch(url, { ...opts, signal, redirect: "error" }), signal);
  }
  catch (err) {
    if (signal.aborted) throw abortError(signal);
    throw failure("network", "Pollinations 网络连接失败（或重定向被拒绝）");
  }
}

async function* packets(res, signal) {
  if (!res.body) throw failure("empty_body", "Pollinations 响应 body 为空", res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", mode = null, data = [], hadBytes = false, ended = false;
  function parseData(value) {
    if (value.trim() === "[DONE]") return { done: true };
    try { return { json: JSON.parse(value), complete: false }; }
    catch { throw failure("invalid_json", "Pollinations SSE 包含非法 JSON", res.status); }
  }
  try {
    while (!ended) {
      let part;
      try { part = await awaitAbort(reader.read(), signal); }
      catch (err) {
        if (signal.aborted) throw abortError(signal);
        throw failure("network", "Pollinations 响应流中断");
      }
      try { buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true }); }
      catch { throw failure("invalid_response", "Pollinations 响应不是合法 UTF-8", res.status); }
      if (!part.done && part.value?.byteLength) hadBytes = true;
      if (!mode && buffer.trimStart()) mode = /^[\[{]/.test(buffer.trimStart()) ? "json" : "sse";
      if (mode === "sse") {
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n");
          const line = buffer.slice(0, end).replace(/\r$/, "");
          buffer = buffer.slice(end + 1);
          if (!line) {
            if (data.length) {
              const packet = parseData(data.join("\n"));
              data = [];
              yield packet;
              if (packet.done) { ended = true; break; }
            }
          } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (part.done) {
        if (!hadBytes) throw failure("empty_body", "Pollinations 响应 body 为空", res.status);
        if (mode === "json") {
          let json;
          try { json = JSON.parse(buffer); }
          catch { throw failure("invalid_json", "Pollinations 响应包含非法 JSON", res.status); }
          yield { json, complete: true };
        } else {
          const line = buffer.replace(/\r$/, "");
          if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          if (data.length) yield parseData(data.join("\n"));
        }
        break;
      }
    }
  } finally {
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* 已关闭的流无需取消 */ }
    try { reader.releaseLock(); } catch { /* 读取取消可能尚未结束 */ }
  }
}

function accumulate(state, packet) {
  if (packet.done) { state.done = true; return []; }
  const json = packet.json;
  if (!json || typeof json !== "object" || Array.isArray(json)) throw failure("invalid_response", "Pollinations 返回了无效响应结构");
  if (json.error) throw remoteFailure(json);
  const events = [];
  if (json.usage) events.push({ type: "usage", usage: normalizeOpenAIUsage(json.usage) });
  const choice = json.choices?.[0];
  const message = choice?.message || choice?.delta || {};
  if (packet.complete && choice?.message) state.complete = true;
  const content = textContent(message.content);
  if (content) { state.text = true; state.output = true; events.push({ type: "text", text: content }); }
  const reasoning = textContent(message.reasoning_content ?? message.reasoning ?? json.reasoning_content ?? json.reasoning);
  if (reasoning) { state.output = true; events.push({ type: "reasoning", text: reasoning }); }
  if (!choice) return events;
  if (message.tool_calls != null) {
    if (!Array.isArray(message.tool_calls)) throw failure("invalid_tool_call", "tool_calls 必须为数组");
    for (const [position, tool] of message.tool_calls.entries()) {
      state.output = true;
      if (state.finish) throw failure("invalid_tool_call", "响应结束标记之后仍收到工具分片");
      const index = tool.index ?? position;
      if (!Number.isInteger(index) || index < 0 || (tool.type && tool.type !== "function")) {
        throw failure("invalid_tool_call", "工具调用类型或索引无效");
      }
      if (!tool.function || typeof tool.function !== "object") throw failure("invalid_tool_call", "工具调用缺少 function");
      const call = state.tools.get(index) || { id: "", name: "", arguments: "" };
      if (tool.id != null) {
        if (typeof tool.id !== "string" || (call.id && call.id !== tool.id)) throw failure("invalid_tool_call", "工具调用 ID 无效或发生变化");
        call.id = tool.id;
      }
      for (const field of ["name", "arguments"]) {
        if (tool.function[field] != null) {
          if (typeof tool.function[field] !== "string") throw failure("invalid_tool_arguments", "工具名称及参数分片必须是字符串");
          call[field] += tool.function[field];
        }
      }
      state.tools.set(index, call);
    }
  }
  if (choice.finish_reason != null) {
    if (!["stop", "tool_calls", "function_call"].includes(choice.finish_reason)) {
      throw failure(choice.finish_reason === "length" ? "truncated" : "incomplete_response", "Pollinations 响应未完整完成，不提交工具调用");
    }
    state.finish = choice.finish_reason;
  }
  return events;
}

async function* chatEvents(provider, req, stream) {
  const rt = runtime();
  let scope;
  try {
    const timeoutMs = Number(req.timeoutMs ?? provider.timeoutMs ?? 120000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw failure("invalid_request", "timeoutMs 必须为正数");
    scope = scopeFor(req.signal, timeoutMs, rt.clock);
    if (scope.signal.aborted) throw abortError(scope.signal);
    const url = endpointFor(provider);
    const body = makeBody(req, stream);
    const headers = ownHeaders(provider, stream);
    const ownKey = String(provider.apiKey || "").trim();
    const queueKey = createHash("sha256").update(`${new URL(url).origin}\0${ownKey}`).digest("hex");
    const maxRetries = req.maxRetries == null ? 1 : Math.min(1, Math.max(0, Math.floor(Number(req.maxRetries) || 0)));
    const allowed = new Set((body.tools || []).map((tool) => tool.function.name));
    const schemas = new Map((body.tools || []).map((tool) => [tool.function.name, tool.function.parameters]));
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let response;
      const state = { tools: new Map(), finish: null, done: false, complete: false, text: false, output: false };
      try {
        await rt.scheduler.acquire(queueKey, !ownKey, scope.signal);
        const res = await fetchResponse(rt, url, { method: "POST", headers, body: JSON.stringify(body) }, scope.signal);
        response = res;
        if (!res.ok) {
          try { Promise.resolve(res.body?.cancel()).catch(() => {}); } catch { /* HTTP 错误无需读取 body */ }
          throw httpFailure(res.status);
        }
        for await (const packet of packets(res, scope.signal)) {
          for (const event of accumulate(state, packet)) yield event;
        }
        if (scope.signal.aborted) throw abortError(scope.signal);
        if (!state.text && !state.tools.size) throw failure("empty_response", "Pollinations 未返回文本或工具调用（usage/reasoning 不算成功内容）", res.status);
        if (!state.complete && !state.done && !state.finish) throw failure("incomplete_response", "Pollinations 流缺少完成标记，不提交工具调用", res.status);
        if (state.tools.size && !state.complete && !state.finish) throw failure("incomplete_response", "工具响应缺少 finish_reason，不提交工具调用", res.status);
        if (state.finish === "tool_calls" && !state.tools.size) throw failure("invalid_tool_call", "finish_reason 为 tool_calls，但没有工具调用", res.status);
        const tools = validateTools(state.tools, allowed, schemas);
        // 批量校验先完成，再分别发出每个工具的一次性完整事件。
        for (const toolCall of tools) {
          if (scope.signal.aborted) throw abortError(scope.signal);
          yield { type: "tool_call", toolCall };
        }
        yield { type: "done" };
        return;
      } catch (err) {
        if (scope.signal.aborted) throw abortError(scope.signal);
        if (response && (err.status === 429 || err.status >= 500)) {
          rt.scheduler.defer(queueKey, retryDelay(response, rt.clock));
        }
        const retryable = err.errorCode === "network" || err.status === 429 || err.status >= 500;
        if (attempt < maxRetries && !state.output && retryable) {
          if (err.errorCode === "network") rt.scheduler.defer(queueKey, 1000);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    yield errorEvent(err);
  } finally {
    scope?.cleanup();
  }
}

async function* streamPollinationsChat(provider, req) {
  yield* chatEvents(provider, req, true);
}

async function chatPollinationsOnce(provider, req) {
  let content = "", reasoning = "", usage = null;
  const tool_calls = [];
  for await (const event of chatEvents(provider, req, false)) {
    if (event.type === "error") return event;
    if (event.type === "text") content += event.text;
    if (event.type === "reasoning") reasoning += event.text;
    if (event.type === "usage") usage = event.usage;
    if (event.type === "tool_call") {
      const { index, ...call } = event.toolCall;
      tool_calls.push(call);
    }
  }
  if (req.returnMessage) {
    const message = { role: "assistant", content: content || null };
    if (tool_calls.length) message.tool_calls = tool_calls;
    if (reasoning) message.reasoning_content = reasoning;
    if (req.returnUsage) message.usage = usage;
    return message;
  }
  if (!content && tool_calls.length) return errorEvent(failure("tool_only", "响应仅包含工具调用，请使用 returnMessage 或流式接口"));
  return req.returnUsage ? { content, usage } : content;
}

async function listPollinationsModels(provider) {
  const rt = runtime();
  let scope;
  try {
    const timeoutMs = Number(provider.timeoutMs ?? 120000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw failure("invalid_request", "timeoutMs 必须为正数");
    scope = scopeFor(provider.signal, timeoutMs, rt.clock);
    const url = endpointFor(provider, true);
    const ownKey = String(provider.apiKey || "").trim();
    const key = createHash("sha256").update(`${new URL(url).origin}\0${ownKey}`).digest("hex");
    const maxRetries = provider.maxRetries == null ? 1 : Math.min(1, Math.max(0, Math.floor(Number(provider.maxRetries) || 0)));
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let response;
      try {
        await rt.scheduler.acquire(key, !ownKey, scope.signal);
        const res = await fetchResponse(rt, url, { method: "GET", headers: ownHeaders(provider, false, true) }, scope.signal);
        response = res;
        if (!res.ok) {
          try { Promise.resolve(res.body?.cancel()).catch(() => {}); } catch { /* 错误 body 无需读取 */ }
          throw httpFailure(res.status);
        }
        let json;
        try {
          const text = await awaitAbort(res.text(), scope.signal);
          if (!text.trim()) throw failure("empty_body", "Pollinations 模型列表 body 为空", res.status);
          json = JSON.parse(text);
        } catch (err) {
          if (scope.signal.aborted) throw abortError(scope.signal);
          if (err.errorCode) throw err;
          if (err instanceof SyntaxError) throw failure("invalid_json", "模型列表 JSON 无效", res.status);
          throw failure("network", "模型列表响应读取中断");
        }
        if (json?.error) throw remoteFailure(json);
        const items = Array.isArray(json) ? json : json?.data || json?.models;
        if (!Array.isArray(items)) throw failure("invalid_response", "模型列表格式无效", res.status);
        const models = [...new Set(items.map((model) => typeof model === "string" ? model : model?.id || model?.name).filter((name) => typeof name === "string" && name.trim()))];
        if (!models.length) throw failure("empty_response", "模型列表为空", res.status);
        return models;
      } catch (err) {
        if (scope.signal.aborted) throw abortError(scope.signal);
        if (response && (err.status === 429 || err.status >= 500)) {
          rt.scheduler.defer(key, retryDelay(response, rt.clock));
        }
        if (attempt < maxRetries && (err.errorCode === "network" || err.status === 429 || err.status >= 500)) {
          if (err.errorCode === "network") rt.scheduler.defer(key, 1000);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    return errorEvent(err);
  } finally {
    scope?.cleanup();
  }
}

module.exports = { POLLINATIONS_PROVIDER, isPollinationsProvider, streamPollinationsChat, chatPollinationsOnce, listPollinationsModels };
// 独立测试可替换时钟、fetch 和调度器，不改变默认导出接口或生产限流值。
Object.defineProperty(module.exports, "__test", {
  value: {
    createScheduler,
    setHooks(hooks) {
      const previous = testHooks;
      testHooks = hooks;
      return () => { testHooks = previous; };
    },
  },
});
