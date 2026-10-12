const assert = require("assert");
const {
  listRemoteModels,
  testProvider,
  chatOnce,
  normalizeReasoningEffort,
} = require("../src/providers");
const {
  classifyProviderError,
  fetchWithTimeout,
} = require("../src/providers/httpUtil");
const { streamOpenAIChat } = require("../src/providers/openai");

function makeSSEResponse(chunks) {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          const bytes = Buffer.from(chunk);
          for (let offset = 0; offset < bytes.length; offset += 7) {
            controller.enqueue(bytes.subarray(offset, offset + 7));
          }
        }
        controller.close();
      },
    }),
  };
}

function sseData(data) {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

async function collectOpenAISSE(chunks, req = {}) {
  const mock = withMockFetch((_url, opts) => {
    assert.strictEqual(opts.headers.Authorization, `Bearer ${req.oauthBearerToken || "k"}`);
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.stream, true);
    assert.deepStrictEqual(body.stream_options, { include_usage: true });
    return makeSSEResponse(chunks);
  });
  try {
    const events = [];
    for await (const event of streamOpenAIChat(
      { baseUrl: "https://x.test/v1", apiKey: "k" },
      { model: "m", messages: [{ role: "user", content: "hi" }], ...req }
    )) events.push(event);
    assert.strictEqual(mock.calls.length, 1, "SSE 不得重试或重放请求");
    return events;
  } finally {
    mock.restore();
  }
}

function makeResponse(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return text; },
    async json() { return JSON.parse(text); },
    async arrayBuffer() { return Buffer.from(text); },
    body: { cancel() {} },
  };
}

function withMockFetch(fn) {
  const old = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return fn(String(url), opts, calls);
  };
  return {
    calls,
    restore() { global.fetch = old; },
  };
}

async function run(name, fn) {
  try {
    await fn();
    console.log("✓", name);
  } catch (err) {
    console.error("✗", name);
    console.error(err);
    process.exitCode = 1;
  }
}

(async () => {
  await run("listRemoteModels parses data[].id and dedupes", async () => {
    const mock = withMockFetch((url) => {
      assert(url.endsWith("/v1/models"), "should call /v1/models for /v1 base");
      return makeResponse(200, { data: [{ id: "a" }, { id: "b" }, { id: "a" }] });
    });
    try {
      const models = await listRemoteModels({ baseUrl: "https://x.test/v1", apiKey: "k", models: [] });
      assert.deepStrictEqual(models, ["a", "b"]);
      assert.strictEqual(mock.calls[0].opts.headers.Authorization, "Bearer k");
      assert.strictEqual(mock.calls[0].opts.headers["api-key"], "k");
    } finally {
      mock.restore();
    }
  });

  await run("listRemoteModels parses models[].name", async () => {
    const mock = withMockFetch(() => makeResponse(200, { models: [{ name: "m1" }, { model: "m2" }] }));
    try {
      const models = await listRemoteModels({ baseUrl: "https://x.test/v1", models: [] });
      assert.deepStrictEqual(models, ["m1", "m2"]);
    } finally {
      mock.restore();
    }
  });

  await run("listRemoteModels parses string arrays", async () => {
    const mock = withMockFetch(() => makeResponse(200, ["s1", "s2"]));
    try {
      const models = await listRemoteModels({ baseUrl: "https://x.test/v1", models: [] });
      assert.deepStrictEqual(models, ["s1", "s2"]);
    } finally {
      mock.restore();
    }
  });

  await run("listRemoteModels falls back from /v1/models to /models", async () => {
    const mock = withMockFetch((url) => {
      if (url.endsWith("/v1/models")) return makeResponse(404, { error: "not found" });
      return makeResponse(200, { data: [{ id: "fallback-ok" }] });
    });
    try {
      const models = await listRemoteModels({ baseUrl: "https://x.test", models: [] });
      assert.deepStrictEqual(models, ["fallback-ok"]);
      assert.strictEqual(mock.calls.length, 2);
    } finally {
      mock.restore();
    }
  });

  await run("listRemoteModels throws with fallbackModels on invalid response", async () => {
    const mock = withMockFetch(() => makeResponse(200, { data: [] }));
    try {
      let err;
      try {
        await listRemoteModels({ baseUrl: "https://x.test/v1", models: ["old"] });
      } catch (e) { err = e; }
      assert(err, "should throw");
      assert.deepStrictEqual(err.fallbackModels, ["old"]);
    } finally {
      mock.restore();
    }
  });

  await run("anthropic refresh returns configured models without fetch", async () => {
    const mock = withMockFetch(() => { throw new Error("should not fetch"); });
    try {
      const models = await listRemoteModels({ type: "anthropic", models: ["claude-x"] });
      assert.deepStrictEqual(models, ["claude-x"]);
      assert.strictEqual(mock.calls.length, 0);
    } finally {
      mock.restore();
    }
  });

  await run("testProvider returns structured failure with no model", async () => {
    const r = await testProvider({}, { baseUrl: "https://x.test/v1", models: [] });
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /未配置模型/);
  });

  await run("testProvider succeeds with mocked OpenAI chat", async () => {
    const mock = withMockFetch((url) => {
      if (url.endsWith("/models")) return makeResponse(200, { data: [{ id: "m" }] });
      if (url.endsWith("/chat/completions")) {
        return makeResponse(200, { choices: [{ message: { content: "EMSoder OK" } }] });
      }
      return makeResponse(404, {});
    });
    try {
      const r = await testProvider({}, {
        type: "openai",
        baseUrl: "https://x.test/v1",
        apiKey: "k",
        models: ["m"],
      });
      assert.strictEqual(r.ok, true);
      assert.match(r.message, /OK · m/);
    } finally {
      mock.restore();
    }
  });

  await run("normalizeReasoningEffort preserves off and maps none", async () => {
    assert.strictEqual(normalizeReasoningEffort("off"), "off");
    assert.strictEqual(normalizeReasoningEffort("none"), "off");
    assert.strictEqual(normalizeReasoningEffort("关闭思考"), "off");
    assert.strictEqual(normalizeReasoningEffort("low"), "low");
    assert.strictEqual(normalizeReasoningEffort("unknown"), "medium");
  });

  await run("OpenAI off omits reasoning_effort", async () => {
    const mock = withMockFetch((_url, opts) => {
      const body = JSON.parse(opts.body);
      assert(!Object.hasOwn(body, "reasoning_effort"), "off must omit reasoning_effort");
      assert(!Object.keys(body).some((k) => /reasoning|thinking/i.test(k)), "off must omit reasoning fields");
      return makeResponse(200, { choices: [{ message: { content: "ok" } }] });
    });
    try {
      const out = await chatOnce(
        { reasoningEffort: "off", maxTokens: 0 },
        { provider: { type: "openai", baseUrl: "https://x.test/v1", apiKey: "k" }, messages: [{ role: "user", content: "hi" }], reasoningEffort: "off", maxRetries: 0 }
      );
      assert.strictEqual(out, "ok");
    } finally { mock.restore(); }
  });

  await run("OpenAI low sends reasoning_effort", async () => {
    const mock = withMockFetch((_url, opts) => {
      const body = JSON.parse(opts.body);
      assert.strictEqual(body.reasoning_effort, "low");
      return makeResponse(200, { choices: [{ message: { content: "ok" } }] });
    });
    try {
      await chatOnce(
        { reasoningEffort: "medium" },
        { provider: { type: "openai", baseUrl: "https://x.test/v1", apiKey: "k" }, messages: [{ role: "user", content: "hi" }], reasoningEffort: "low", maxRetries: 0 }
      );
    } finally { mock.restore(); }
  });

  await run("Anthropic off omits thinking", async () => {
    const mock = withMockFetch((_url, opts) => {
      const body = JSON.parse(opts.body);
      assert(!Object.hasOwn(body, "thinking"), "off must omit thinking");
      assert.strictEqual(body.max_tokens, 4096, "Anthropic keeps protocol fallback only");
      return makeResponse(200, { content: [{ type: "text", text: "ok" }] });
    });
    try {
      const out = await chatOnce(
        { reasoningEffort: "off" },
        { provider: { type: "anthropic", baseUrl: "https://x.test", apiKey: "k" }, messages: [{ role: "user", content: "hi" }], reasoningEffort: "off", maxTokens: 0, maxRetries: 0 }
      );
      assert.strictEqual(out, "ok");
    } finally { mock.restore(); }
  });

  await run("Anthropic high enables thinking budget", async () => {
    const mock = withMockFetch((_url, opts) => {
      const body = JSON.parse(opts.body);
      assert.deepStrictEqual(body.thinking, { type: "enabled", budget_tokens: 10000 });
      assert(body.max_tokens >= 11024, "max_tokens must exceed thinking budget");
      return makeResponse(200, { content: [{ type: "text", text: "ok" }] });
    });
    try {
      await chatOnce(
        {},
        { provider: { type: "anthropic", baseUrl: "https://x.test", apiKey: "k" }, messages: [{ role: "user", content: "hi" }], reasoningEffort: "high", maxTokens: 0, maxRetries: 0 }
      );
    } finally { mock.restore(); }
  });

  await run("classifyProviderError common provider errors", async () => {
    assert.strictEqual(classifyProviderError("HTTP 401 invalid api key").code, "auth");
    assert.strictEqual(classifyProviderError("HTTP 403 forbidden").code, "forbidden");
    assert.strictEqual(classifyProviderError("HTTP 429 rate limit").code, "rate_limit");
    assert.strictEqual(classifyProviderError("model not found").code, "model");
    assert.strictEqual(classifyProviderError("请求超时").code, "timeout");
  });

  await run("fetchWithTimeout returns response body still readable", async () => {
    const mock = withMockFetch(() => makeResponse(200, { data: [{ id: "ok" }] }));
    try {
      const res = await fetchWithTimeout("https://x.test/v1/models", {}, 1000);
      const text = await res.text();
      assert.match(text, /ok/);
    } finally {
      mock.restore();
    }
  });

  for (const [status, statusField] of [[401, "status"], [402, "statusCode"], [403, null], [429, "status"]]) {
    await run(`OpenAI SSE 无换行尾行保留 ${status} 错误`, async () => {
      const remote = { code: `remote_${status}`, message: "认证或额度错误" };
      const payload = { error: remote };
      if (statusField) remote[statusField] = status;
      else payload.status = status;
      const events = await collectOpenAISSE([sseData(payload).trimEnd()]);
      assert.deepStrictEqual(events, [{
        type: "error", status, errorCode: remote.code,
        error: `Provider error ${status} ${remote.code}: ${remote.message}`,
      }]);
    });
  }

  const toolFragments = [
    sseData({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read", function: { name: "read_", arguments: '{"path":' } }] } }] }),
    sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: '"目录/a"}' } }] } }] }),
  ];
  for (const completion of ["stop", "tool_calls", "[DONE]"]) {
    await run(`OpenAI SSE 工具 fragment 由 ${completion} 显式完成`, async () => {
      const marker = completion === "[DONE]"
        ? sseData(completion)
        : sseData({ choices: [{ delta: {}, finish_reason: completion }] });
      const events = await collectOpenAISSE([...toolFragments, marker.trimEnd()]);
      assert.deepStrictEqual(events, [
        { type: "tool_call", toolCall: { index: 0, id: "call_read", type: "function", function: { name: "read_", arguments: '{"path":' } } },
        { type: "tool_call", toolCall: { index: 0, id: "call_read", type: "function", function: { name: "read_file", arguments: '{"path":"目录/a"}' } } },
        { type: "done" },
      ]);
      assert.deepStrictEqual(JSON.parse(events[1].toolCall.function.arguments), { path: "目录/a" });
    });
  }

  for (const reason of ["length", "content_filter", "unknown"]) {
    await run(`OpenAI SSE 工具参数遇 ${reason} 返回 error 而非 done`, async () => {
      const finish = sseData({ choices: [{ delta: {}, finish_reason: reason }] });
      for (const chunks of [
        [toolFragments[0], finish.trimEnd()],
        [...toolFragments, finish, sseData("[DONE]")],
        [...toolFragments, sseData({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }), finish, sseData("[DONE]")],
      ]) {
        const events = await collectOpenAISSE(chunks);
        assert(events.some((event) => event.type === "tool_call"));
        assert.strictEqual(events.at(-1).type, "error");
        assert.strictEqual(events.at(-1).errorCode, "incomplete_response");
        assert.match(events.at(-1).error, new RegExp(reason));
        assert(!events.some((event) => event.type === "done"));
      }
      const textEvents = await collectOpenAISSE([
        sseData({ choices: [{ delta: { content: "部分文本" } }] }), finish.trimEnd(),
      ]);
      assert.strictEqual(textEvents.at(-1).type, "error");
      assert(!textEvents.some((event) => event.type === "done"));
    });
  }

  await run("OpenAI SSE 工具 EOF 缺完成标记必须返回 error", async () => {
    for (const chunks of [[toolFragments[0].trimEnd()], [toolFragments[0], toolFragments[1].trimEnd()]]) {
      const events = await collectOpenAISSE(chunks);
      assert.strictEqual(events.at(-1).type, "error");
      assert.strictEqual(events.at(-1).errorCode, "incomplete_response");
      assert.match(events.at(-1).error, /缺少成功完成标记/);
      assert(!events.some((event) => event.type === "done"));
    }
  });

  await run("OpenAI SSE 成功 finish 后的无换行远端错误仍为 error", async () => {
    const events = await collectOpenAISSE([
      ...toolFragments,
      sseData({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      sseData({ error: { status: 429, code: "rate_limit", message: "稍后重试" } }).trimEnd(),
    ]);
    assert.strictEqual(events.at(-1).type, "error");
    assert.strictEqual(events.at(-1).status, 429);
    assert(!events.some((event) => event.type === "done"));
  });

  await run("OpenAI SSE 文本 DONE、reasoning 别名及 usage 字段回归", async () => {
    const usage = {
      prompt_tokens: 20, completion_tokens: 5, total_tokens: 25,
      prompt_tokens_details: { cached_tokens: 7 },
      prompt_cache_hit_tokens: 7, prompt_cache_miss_tokens: 13,
    };
    const events = await collectOpenAISSE([
      ": 心跳\r\n\r\n",
      sseData({ choices: [{ delta: { reasoning: "思考一" } }] }),
      sseData({ choices: [{ delta: { reasoning_content: "思考二", reasoning: "不重复" } }] }),
      sseData({ choices: [{ delta: { content: "你好" } }] }).replace(/\n/g, "\r\n"),
      sseData({ choices: [{ delta: { content: "世界" }, finish_reason: "stop" }] }),
      sseData({ choices: [], usage }),
      sseData("[DONE]").trimEnd(),
    ], { oauthBearerToken: "oauth-token" });
    assert.deepStrictEqual(events, [
      { type: "reasoning", text: "思考一" },
      { type: "reasoning", text: "思考二" },
      { type: "text", text: "你好" },
      { type: "text", text: "世界" },
      { type: "usage", usage: {
        prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, cached_tokens: 7,
        prompt_cache_hit_tokens: 7, prompt_cache_miss_tokens: 13, _raw: usage,
      } },
      { type: "done" },
    ]);
    const aliasUsage = { input_tokens: 3, output_tokens: 2, total_tokens: 5, input_tokens_details: { cached_tokens: 1 } };
    const aliasEvents = await collectOpenAISSE([sseData({ usage: aliasUsage }).trimEnd()]);
    assert.deepStrictEqual(aliasEvents, [
      { type: "usage", usage: {
        prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cached_tokens: 1,
        prompt_cache_hit_tokens: undefined, prompt_cache_miss_tokens: undefined, _raw: aliasUsage,
      } },
      { type: "done" },
    ]);
  });

  await run("OpenAI SSE 普通文本无 finish 的 EOF 仍兼容 done", async () => {
    for (const tail of ["", "\n\n", sseData("[DONE]").trimEnd()]) {
      const events = await collectOpenAISSE([
        sseData({ choices: [{ delta: { content: "末行文本" } }] }).trimEnd() + (tail.startsWith("data:") ? "\n\n" : "") + tail,
      ]);
      assert.deepStrictEqual(events, [{ type: "text", text: "末行文本" }, { type: "done" }]);
    }
  });

  if (process.exitCode) process.exit(process.exitCode);
})();
