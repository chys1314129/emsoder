const assert = require("node:assert/strict");
const adapter = require("../src/providers/pollinations");
const { POLLINATIONS_PROVIDER: DEFAULT, isPollinationsProvider, streamPollinationsChat, chatPollinationsOnce, listPollinationsModels, __test } = adapter;

class MockClock {
  constructor() { this.time = 0; this.nextId = 0; this.timers = new Map(); }
  now = () => this.time;
  setTimeout = (fn, ms) => {
    const id = ++this.nextId;
    this.timers.set(id, { fn, at: this.time + ms });
    return id;
  };
  clearTimeout = (id) => { this.timers.delete(id); };
  advance(ms) {
    const target = this.time + ms;
    while (true) {
      const timer = [...this.timers.entries()].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!timer) break;
      this.time = timer[1].at;
      this.timers.delete(timer[0]);
      timer[1].fn();
    }
    this.time = target;
  }
}

const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
const request = (extra = {}) => ({ messages: [{ role: "user", content: "你好" }], maxRetries: 0, ...extra });
const provider = (extra = {}) => ({ ...DEFAULT, ...extra });
const tool = (name) => ({ type: "function", function: { name, parameters: { type: "object", properties: {} } } });
const tools = [tool("read_file"), tool("write_file")];
const call = (index, name, args, id = `id_${index}`) => ({ index, id, type: "function", function: { name, arguments: args } });
const chunk = (delta = {}, finish_reason = null, extra = {}) => ({ choices: [{ delta, finish_reason }], ...extra });
const jsonResponse = (message = { content: "正常回答" }, extra = {}) => new Response(JSON.stringify({ choices: [{ message }], ...extra }), { headers: { "content-type": "application/json" } });
const sseText = (chunks, done = true) => chunks.map((item) => `data: ${typeof item === "string" ? item : JSON.stringify(item)}\r\n\r\n`).join("") + (done ? "data: [DONE]\r\n\r\n" : "");
const sseResponse = (chunks, done = true) => new Response(sseText(chunks, done), { headers: { "content-type": "text/event-stream" } });

async function collect(p = provider(), req = request()) {
  const events = [];
  for await (const event of streamPollinationsChat(p, req)) events.push(event);
  return events;
}
function success(events) {
  assert.equal(events.at(-1)?.type, "done", JSON.stringify(events));
  assert.equal(events.filter((event) => event.type === "error").length, 0);
}
function failed(events, code, status) {
  assert.equal(events.at(-1)?.type, "error", JSON.stringify(events));
  assert.equal(events.at(-1).errorCode, code);
  if (status !== undefined) assert.equal(events.at(-1).status, status);
  assert.equal(events.some((event) => event.type === "done"), false);
  assert.equal(events.some((event) => event.type === "tool_call"), false);
}

async function mock(fn, run) {
  const clock = new MockClock();
  const calls = [];
  const scheduler = __test.createScheduler(clock);
  const restore = __test.setHooks({ clock, scheduler, fetch: async (url, opts) => {
    calls.push({ url: String(url), opts, at: clock.now() });
    return fn(String(url), opts, calls);
  } });
  try { await run({ clock, calls }); }
  finally { restore(); }
  assert.equal(clock.timers.size, 0, "请求结束必须清理超时及排队定时器");
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("固定配置和五个公开接口", async () => {
  assert.deepEqual(Object.keys(adapter), ["POLLINATIONS_PROVIDER", "isPollinationsProvider", "streamPollinationsChat", "chatPollinationsOnce", "listPollinationsModels"]);
  assert.deepEqual({ ...DEFAULT, models: [...DEFAULT.models] }, { id: "pollinations-keyless", name: "Pollinations 无密钥", type: "openai", baseUrl: "https://text.pollinations.ai", chatPath: "/openai", models: ["openai"], apiKey: "", keyless: true, enabled: true, timeoutMs: 120000 });
});

test("识别只按确切 hostname，不信任 id", async () => {
  for (const baseUrl of ["https://text.pollinations.ai", "https://gen.pollinations.ai/v1"]) assert.equal(isPollinationsProvider({ baseUrl }), true);
  for (const baseUrl of ["https://text.pollinations.ai.evil.test", "https://evil.test/text.pollinations.ai", "https://text.pollinations.ai@evil.test", "无效地址", ""]) assert.equal(isPollinationsProvider({ id: DEFAULT.id, baseUrl }), false);
  assert.equal(isPollinationsProvider({ id: DEFAULT.id }), false);
});

test("legacy 直接 POST /openai，无其他 provider 凭据和重定向", async () => {
  await mock(() => jsonResponse(), async ({ calls }) => {
    success(await collect(provider({ headers: { Authorization: "Bearer foreign", "api-key": "other", Cookie: "secret", "X-Api-Key": "secret", Origin: "fake", "User-Agent": "fake", Accept: "application/json" } }), request({ oauthBearerToken: "oauth-secret", headers: { Authorization: "req-secret" } })));
    const { url, opts } = calls[0];
    assert.equal(url, "https://text.pollinations.ai/openai");
    assert.equal(opts.method, "POST");
    assert.equal(opts.redirect, "error");
    assert.deepEqual(opts.headers, { Accept: "application/json", "Content-Type": "application/json" });
    assert(!JSON.stringify(opts).includes("secret"));
    const body = JSON.parse(opts.body);
    assert.equal(body.model, "openai");
    assert.equal(body.stream, true);
    assert(!("stream_options" in body));
  });
});

for (const base of ["https://text.pollinations.ai/openai", "https://text.pollinations.ai/openai/", "https://text.pollinations.ai/openai/chat/completions"]) {
  test(`用户 base 不重复追加路径：${new URL(base).pathname}`, async () => {
    await mock(() => jsonResponse(), async ({ calls }) => {
      success(await collect(provider({ baseUrl: base })));
      assert.equal(calls[0].url, base.replace(/\/+$/, ""));
    });
  });
}

test("gen 不允许无 key，不继承 oauth", async () => {
  await mock(() => { throw new Error("不应 fetch"); }, async ({ calls }) => {
    failed(await collect(provider({ baseUrl: "https://gen.pollinations.ai/v1/chat/completions" }), request({ oauthBearerToken: "other" })), "auth", 401);
    assert.equal(calls.length, 0);
  });
});

test("gen 带 own key，仅发送自己的 Bearer", async () => {
  await mock(() => jsonResponse(), async ({ calls }) => {
    success(await collect(provider({ baseUrl: "https://gen.pollinations.ai/v1/chat/completions", apiKey: "own-key", headers: { Authorization: "other" } }), request({ oauthBearerToken: "oauth-other" })));
    assert.equal(calls[0].url, "https://gen.pollinations.ai/v1/chat/completions");
    assert.equal(calls[0].opts.headers.Authorization, "Bearer own-key");
    assert(!JSON.stringify(calls[0]).includes("oauth-other"));
  });
});

for (const base of ["http://text.pollinations.ai", "https://user:secret@text.pollinations.ai", "https://text.pollinations.ai:8443", "https://text.pollinations.ai?key=other", "https://evil.test", "https://text.pollinations.ai/other"]) {
  test(`拒绝危险端点：${base.replace("user:secret@", "凭据@")}`, async () => {
    await mock(() => { throw new Error("不应 fetch"); }, async ({ calls }) => {
      failed(await collect(provider({ baseUrl: base })), "invalid_endpoint");
      assert.equal(calls.length, 0);
    });
  });
}

test("body 保留 tool 回传、assistant 调用及 text blocks", async () => {
  await mock(() => jsonResponse(), async ({ calls }) => {
    const priorCall = { id: "prev", type: "function", function: { name: "read_file", arguments: "{}" } };
    const req = request({ tools, model: "用户模型", maxTokens: 999999, temperature: 0.7, reasoningEffort: "ultra", thinkingBudget: 4000, messages: [
      { role: "user", content: [{ type: "text", text: "甲" }, { type: "text", text: "乙" }] },
      { role: "assistant", content: null, tool_calls: [priorCall] },
      { role: "tool", content: [{ type: "text", text: "回传" }], tool_call_id: "prev", name: "read_file" },
    ] });
    success(await collect(provider(), req));
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.messages[0].content, "甲\n乙");
    assert.deepEqual(body.messages[1], { role: "assistant", content: null, tool_calls: [priorCall] });
    assert.deepEqual(body.messages[2], { role: "tool", content: "回传", tool_call_id: "prev", name: "read_file" });
    assert.equal(body.model, "用户模型");
    assert.equal(body.max_tokens, 999999);
    assert.equal(body.temperature, 0.7);
    assert.equal(body.reasoning_effort, "high");
    assert.equal(body.tool_choice, "auto");
    assert.deepEqual(body.tools, tools);
    assert(!("thinking_token_budget" in body));
    assert(!("stream_options" in body));
  });
});

for (const effort of ["low", "medium", "high", "off"]) {
  test(`reasoningEffort ${effort} 和 maxTokens 0`, async () => {
    await mock(() => jsonResponse(), async ({ calls }) => {
      success(await collect(provider(), request({ maxTokens: 0, reasoningEffort: effort })));
      const body = JSON.parse(calls[0].opts.body);
      assert(!("max_tokens" in body));
      assert.equal(body.reasoning_effort, effort === "off" ? undefined : effort);
    });
  });
}

for (const type of ["image_url", "input_audio", "audio", "image"]) {
  test(`文本通道拒绝 ${type}`, async () => {
    await mock(() => { throw new Error("不应 fetch"); }, async ({ calls }) => {
      failed(await collect(provider(), request({ messages: [{ role: "user", content: [{ type: "text", text: "描述" }, { type, image_url: { url: "data:image/png;base64,AA" }, input_audio: { data: "AA" } }] }] })), "unsupported_content");
      assert.equal(calls.length, 0);
    });
  });
}

test("两工具多索引交错分片，一次性完成提交", async () => {
  const chunks = [
    chunk({ tool_calls: [call(1, "write_", '{"path":', "b"), call(0, "read_", '{"path":', "a")] }),
    chunk({ tool_calls: [{ index: 0, function: { name: "file", arguments: '"a"}' } }, { index: 1, function: { name: "file", arguments: '"b"}' } }] }),
    chunk({}, "tool_calls"),
  ];
  await mock(() => sseResponse(chunks), async () => {
    const events = await collect(provider(), request({ tools }));
    success(events);
    const emitted = events.filter((event) => event.type === "tool_call").map((event) => event.toolCall);
    assert.equal(emitted.length, 2);
    assert.deepEqual(emitted.map((item) => [item.index, item.id, item.function.name, JSON.parse(item.function.arguments)]), [[0, "a", "read_file", { path: "a" }], [1, "b", "write_file", { path: "b" }]]);
  });
});

test("finish 前没有可执行的工具事件", async () => {
  let control;
  const body = new ReadableStream({ start(c) { control = c; c.enqueue(Buffer.from(sseText([chunk({ tool_calls: [call(0, "read_file", "{}") ] })], false))); } });
  await mock(() => new Response(body), async () => {
    const events = [];
    const pending = (async () => { for await (const event of streamPollinationsChat(provider(), request({ tools }))) events.push(event); })();
    await flush();
    assert.equal(events.length, 0);
    control.enqueue(Buffer.from(sseText([chunk({}, "tool_calls")])));
    await pending;
    success(events);
    assert.equal(events.filter((event) => event.type === "tool_call").length, 1);
  });
});

for (const dirty of ["functions.read_file", "to=functions.read_file:0", "functions.read_file<|channel|>analysis", " read_file<|im_end|> "]) {
  test(`Harmony 工具名仅恢复白名单：${dirty}`, async () => {
    await mock(() => sseResponse([chunk({ tool_calls: [call(0, dirty, "{}")] }), chunk({}, "tool_calls")]), async () => {
      const events = await collect(provider(), request({ tools }));
      success(events);
      assert.equal(events[0].toolCall.function.name, "read_file");
    });
  });
}

for (const name of ["delete_everything", "evil.read_file", "read_file_suffix", "functions.unknown<|im_end|>"]) {
  test(`拒绝未知工具及模糊匹配：${name}`, async () => {
    await mock(() => sseResponse([chunk({ tool_calls: [call(0, "read_file", "{}"), call(1, name, "{}")] }), chunk({}, "tool_calls")]), async () => {
      failed(await collect(provider(), request({ tools })), "unknown_tool");
    });
  });
}

for (const args of ["{", "{bad json}", "[]", "null", '"字符串"', "42", ""]) {
  test(`坏 JSON 或非 object 工具参数：${args || "空"}`, async () => {
    await mock(() => sseResponse([chunk({ tool_calls: [call(0, "read_file", "{}"), call(1, "write_file", args)] }), chunk({}, "tool_calls")]), async () => {
      failed(await collect(provider(), request({ tools })), "invalid_tool_arguments");
    });
  });
}

test("工具参数必须满足传入 schema：缺失写入内容不能执行", async () => {
  const writeTool = { type: "function", function: { name: "write_file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } };
  for (const args of ['{"path":"a.txt"}', '{"path":"a.txt","content":null}', '{"path":42,"content":"ok"}']) {
    await mock(() => jsonResponse({ tool_calls: [call(0, "write_file", args)] }), async () => failed(await collect(provider(), request({ tools: [writeTool] })), "invalid_tool_arguments"));
  }
  await mock(() => jsonResponse({ tool_calls: [call(0, "write_file", '{"path":"a.txt","content":""}')] }), async () => success(await collect(provider(), request({ tools: [writeTool] }))));
});

test("未传工具白名单时拒绝任何工具", async () => {
  await mock(() => jsonResponse({ tool_calls: [call(0, "read_file", "{}")] }), async () => failed(await collect(), "unknown_tool"));
});

test("length 截断即使之前工具 JSON 完整也不能执行", async () => {
  await mock(() => sseResponse([chunk({ tool_calls: [call(0, "read_file", "{}")] }), chunk({}, "length")]), async () => failed(await collect(provider(), request({ tools })), "truncated"));
});

test("流 EOF 无 finish/DONE，不提交工具", async () => {
  await mock(() => sseResponse([chunk({ tool_calls: [call(0, "read_file", "{}")] })], false), async () => failed(await collect(provider(), request({ tools })), "incomplete_response"));
});

test("只有 DONE 无 tool finish，不提交工具", async () => {
  await mock(() => sseResponse([chunk({ tool_calls: [call(0, "read_file", "{}")] })]), async () => failed(await collect(provider(), request({ tools })), "incomplete_response"));
});

test("finish_reason 无 DONE，末行无换行也完成", async () => {
  await mock(() => new Response(`data: ${JSON.stringify(chunk({ content: "尾行" }, "stop"))}`), async () => {
    const events = await collect();
    success(events);
    assert.equal(events[0].text, "尾行");
  });
});

test("工具 finish 无 DONE 正常完成", async () => {
  await mock(() => sseResponse([chunk({ tool_calls: [call(0, "read_file", "{}")] }), chunk({}, "tool_calls")], false), async () => success(await collect(provider(), request({ tools }))));
});

test("UTF-8 每字节切块、跨块 CRLF、末行 DONE", async () => {
  const bytes = Buffer.from(sseText([chunk({ content: "你好，中文" }), chunk({}, "stop")], false) + "data: [DONE]");
  await mock(() => new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } })), async () => {
    const events = await collect();
    success(events);
    assert.equal(events.filter((event) => event.type === "text").map((event) => event.text).join(""), "你好，中文");
  });
});

test("多行 SSE data、注释和 event 字段", async () => {
  const wire = ': 心跳\r\nevent: message\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"多行"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]';
  await mock(() => new Response(wire), async () => {
    const events = await collect(); success(events); assert.equal(events[0].text, "多行");
  });
});

test("stream 返回完整 JSON fallback、reasoning 与 usage", async () => {
  await mock(() => jsonResponse({ content: [{ type: "text", text: "JSON回答" }], reasoning: "思考过程" }, { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, input_tokens_details: { cached_tokens: 1 } } }), async () => {
    const events = await collect(); success(events);
    assert.equal(events.find((event) => event.type === "text").text, "JSON回答");
    assert.equal(events.find((event) => event.type === "reasoning").text, "思考过程");
    assert.equal(events.find((event) => event.type === "usage").usage.cached_tokens, 1);
  });
});

test("reasoning/reasoning_content 分片规范成 reasoning 事件", async () => {
  await mock(() => sseResponse([chunk({ reasoning: "推理一" }), chunk({ reasoning_content: "推理二" }), chunk({ content: "结论" }, "stop")]), async () => {
    const events = await collect(); success(events);
    assert.deepEqual(events.filter((event) => event.type === "reasoning").map((event) => event.text), ["推理一", "推理二"]);
  });
});

for (const body of [{}, { usage: { total_tokens: 1 } }, { choices: [{ message: { reasoning: "只有推理" } }] }]) {
  test(`200 无文本/工具不能假成功：${Object.keys(body).join(",") || "空对象"}`, async () => {
    await mock(() => new Response(JSON.stringify(body)), async () => failed(await collect(), "empty_response", 200));
  });
}

test("空 SSE DONE 不能假成功", async () => {
  await mock(() => sseResponse([]), async () => failed(await collect(), "empty_response", 200));
});

for (const res of [() => new Response(null), () => new Response("")]) {
  test("200 空 body 明确 empty_body", async () => {
    await mock(res, async () => failed(await collect(), "empty_body", 200));
  });
}

for (const [status, code] of [[401, "auth"], [402, "quota"], [403, "forbidden"], [429, "rate_limit"], [503, "unavailable"], [500, "server_error"]]) {
  test(`HTTP ${status} 分类且 maxRetries:0`, async () => {
    await mock(() => new Response('{"error":"包含私密信息也不回显"}', { status }), async ({ calls }) => {
      const events = await collect(); failed(events, code, status);
      assert.equal(calls.length, 1);
      assert(!events.at(-1).error.includes("私密信息"));
    });
  });
}

test("402 默认也不重试、不绕限流", async () => {
  await mock(() => new Response("", { status: 402 }), async ({ calls }) => {
    failed(await collect(provider(), request({ maxRetries: undefined })), "quota", 402);
    assert.equal(calls.length, 1);
  });
});

test("错误 JSON 和非法 SSE JSON 都明确失败", async () => {
  await mock(() => sseResponse([{ error: { code: "insufficient_quota" } }]), async () => failed(await collect(), "quota", 402));
  await mock(() => sseResponse(["{坏JSON"]), async () => failed(await collect(), "invalid_json", 200));
  await mock(() => new Response("{坏JSON"), async () => failed(await collect(), "invalid_json", 200));
});

test("第一真实输出后错误不可重放", async () => {
  await mock(() => sseResponse([chunk({ content: "已经输出" }), { error: { status: 503 } }]), async ({ calls }) => {
    const events = await collect(provider(), request({ maxRetries: 9 })); failed(events, "unavailable", 503);
    assert.equal(events[0].text, "已经输出"); assert.equal(calls.length, 1);
  });
});

test("完整 tool finish 后仍中断，所有工具不能执行", async () => {
  let read = 0;
  const response = { ok: true, status: 200, body: { getReader: () => ({ read: async () => {
    if (!read++) return { done: false, value: Buffer.from(sseText([chunk({ tool_calls: [call(0, "read_file", "{}")] }), chunk({}, "tool_calls")], false)) };
    throw new Error("连接中断");
  }, cancel() {}, releaseLock() {} }) } };
  await mock(() => response, async ({ calls }) => {
    failed(await collect(provider(), request({ tools, maxRetries: 1 })), "network"); assert.equal(calls.length, 1);
  });
});

test("预先停止不 fetch，error 收尾不 throw", async () => {
  const controller = new AbortController(); controller.abort();
  await mock(() => { throw new Error("不应 fetch"); }, async ({ calls }) => {
    failed(await collect(provider(), request({ signal: controller.signal })), "aborted"); assert.equal(calls.length, 0);
  });
});

test("body 永久等待时停止仍立即取消，无工具提交", async () => {
  await mock(() => new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from(sseText([chunk({ tool_calls: [call(0, "read_file", "{}")] })], false))); } })), async () => {
    const controller = new AbortController();
    const pending = collect(provider(), request({ tools, signal: controller.signal }));
    await flush(); controller.abort(); failed(await pending, "aborted");
  });
});

test("总 timeout 覆盖 body 等待", async () => {
  await mock(() => new Response(new ReadableStream({ start() {} })), async ({ clock, calls }) => {
    const pending = collect(provider(), request({ timeoutMs: 100 }));
    await flush(); assert.equal(calls.length, 1);
    clock.advance(100); failed(await pending, "timeout");
    assert.equal(calls[0].opts.signal.aborted, true);
  });
});

test("总 timeout 覆盖排队，匿名等待不真实睡 16 秒", async () => {
  await mock(() => jsonResponse(), async ({ clock, calls }) => {
    success(await collect());
    const pending = collect(provider(), request({ timeoutMs: 500 }));
    await flush(); assert.equal(calls.length, 1);
    clock.advance(500); failed(await pending, "timeout"); assert.equal(calls.length, 1);
  });
});

test("进程共享 endpoint+ownkey 队列匿名最小 16s", async () => {
  await mock(() => jsonResponse(), async ({ clock, calls }) => {
    const first = collect(provider(), request());
    const second = collect(provider({ id: "另一 id" }), request());
    await first; await flush(); assert.equal(calls.length, 1);
    clock.advance(15999); await flush(); assert.equal(calls.length, 1);
    clock.advance(1); success(await second);
    assert.deepEqual(calls.map((item) => item.at), [0, 16000]);
  });
});

test("排队可取消且不占用后续 16s 配额", async () => {
  await mock(() => jsonResponse(), async ({ clock, calls }) => {
    success(await collect());
    const controller = new AbortController();
    const second = collect(provider(), request({ signal: controller.signal }));
    const third = collect();
    await flush(); controller.abort(); failed(await second, "aborted");
    clock.advance(16000); success(await third);
    assert.deepEqual(calls.map((item) => item.at), [0, 16000]);
  });
});

test("own key 独立排队，匿名同主机不同路径仍共享间隔", async () => {
  await mock(() => jsonResponse(), async ({ calls, clock }) => {
    const first = [collect(), collect(provider({ apiKey: "own-a" })), collect(provider({ apiKey: "own-b" }))];
    const alias = collect(provider({ baseUrl: "https://text.pollinations.ai/openai/chat/completions" }));
    (await Promise.all(first)).forEach(success);
    await flush();
    assert.equal(calls.length, 3);
    clock.advance(16000);
    success(await alias);
    assert.equal(calls.length, 4);
    assert.equal(calls[3].at, 16000);
  });
});

test("429 Retry-After 20s 同 key 队列严格等待，只重试一次", async () => {
  await mock(() => new Response("", { status: 429, headers: { "Retry-After": "20" } }), async ({ clock, calls }) => {
    const pending = collect(provider(), request({ maxRetries: 99 }));
    await flush(); assert.equal(calls.length, 1);
    clock.advance(19999); await flush(); assert.equal(calls.length, 1);
    clock.advance(1); failed(await pending, "rate_limit", 429);
    assert.deepEqual(calls.map((item) => item.at), [0, 20000]);
  });
});

test("HTTP 日期 Retry-After，同 own key 新请求也尊重退避", async () => {
  const retryAt = new Date(30000).toUTCString();
  await mock((_url, _opts, calls) => calls.length === 1 ? new Response("", { status: 503, headers: { "Retry-After": retryAt } }) : jsonResponse(), async ({ clock, calls }) => {
    const p = provider({ apiKey: "same-own" });
    failed(await collect(p), "unavailable", 503);
    const pending = collect(p); await flush(); assert.equal(calls.length, 1);
    clock.advance(29999); await flush(); assert.equal(calls.length, 1);
    clock.advance(1); success(await pending); assert.equal(calls[1].at, 30000);
  });
});

test("网络失败最多重试一次，匿名重试仍等 16s", async () => {
  await mock((_url, _opts, calls) => { if (calls.length === 1) throw new TypeError("fetch failed secret"); return jsonResponse(); }, async ({ clock, calls }) => {
    const pending = collect(provider(), request({ maxRetries: 1 }));
    await flush(); assert.equal(calls.length, 1);
    clock.advance(16000); success(await pending);
    assert.deepEqual(calls.map((item) => item.at), [0, 16000]);
  });
});

test("已输出 reasoning 后网络中断不重试", async () => {
  let read = 0;
  await mock(() => ({ ok: true, status: 200, body: { getReader: () => ({ read: async () => {
    if (!read++) return { done: false, value: Buffer.from(sseText([chunk({ reasoning: "已输出思考" })], false)) };
    throw new Error("断流");
  }, cancel() {}, releaseLock() {} }) } }), async ({ calls }) => {
    const events = await collect(provider(), request({ maxRetries: 1 })); failed(events, "network");
    assert.equal(events[0].type, "reasoning"); assert.equal(calls.length, 1);
  });
});

test("chatOnce 字符串、usage 和 assistant tool_calls 返回", async () => {
  await mock(() => jsonResponse({ content: "单次回答" }, { usage: { prompt_tokens: 5, completion_tokens: 3 } }), async ({ calls }) => {
    assert.equal(await chatPollinationsOnce(provider(), request()), "单次回答");
    assert.equal(JSON.parse(calls[0].opts.body).stream, false);
  });
  await mock(() => jsonResponse({ content: "计数" }, { usage: { prompt_tokens: 5, completion_tokens: 3 } }), async () => {
    const result = await chatPollinationsOnce(provider(), request({ returnUsage: true }));
    assert.equal(result.content, "计数"); assert.equal(result.usage.prompt_tokens, 5);
  });
  await mock(() => jsonResponse({ content: null, tool_calls: [call(0, "functions.read_file", "{}")], reasoning: "调用工具" }), async () => {
    const result = await chatPollinationsOnce(provider(), request({ tools, returnMessage: true }));
    assert.equal(result.role, "assistant"); assert.equal(result.content, null);
    assert.equal(result.tool_calls[0].function.name, "read_file");
    assert.equal(result.reasoning_content, "调用工具");
  });
});

test("chatOnce 默认 tool-only 不返回假空成功，错误不 throw", async () => {
  await mock(() => jsonResponse({ tool_calls: [call(0, "read_file", "{}")] }), async () => {
    const result = await chatPollinationsOnce(provider(), request({ tools }));
    assert.equal(result.type, "error"); assert.equal(result.errorCode, "tool_only");
  });
  await mock(() => new Response("", { status: 401 }), async () => {
    const result = await chatPollinationsOnce(provider(), request());
    assert.equal(result.type, "error"); assert.equal(result.status, 401);
  });
});

test("list 只 GET legacy /models，解析 name/id 去重，不探测模型", async () => {
  await mock(() => new Response(JSON.stringify([{ name: "openai" }, { id: "paid-model", paid: true }, { name: "openai" }])), async ({ calls }) => {
    const models = await listPollinationsModels(provider({ baseUrl: "https://text.pollinations.ai/openai", maxRetries: 0 }));
    assert.deepEqual(models, ["openai", "paid-model"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://text.pollinations.ai/models");
    assert.equal(calls[0].opts.method, "GET"); assert.equal(calls[0].opts.redirect, "error");
    assert(!("body" in calls[0].opts)); assert(!("Authorization" in calls[0].opts.headers));
  });
});

test("list gen 只 GET /text/models，own key 必需", async () => {
  await mock(() => new Response(JSON.stringify({ data: [{ id: "model-a" }, { name: "model-b" }] })), async ({ calls }) => {
    assert.deepEqual(await listPollinationsModels(provider({ baseUrl: "https://gen.pollinations.ai/v1/chat/completions", apiKey: "own", maxRetries: 0 })), ["model-a", "model-b"]);
    assert.equal(calls[0].url, "https://gen.pollinations.ai/text/models");
    assert.equal(calls[0].opts.headers.Authorization, "Bearer own");
  });
  await mock(() => { throw new Error("不应 fetch"); }, async ({ calls }) => {
    const result = await listPollinationsModels(provider({ baseUrl: "https://gen.pollinations.ai" }));
    assert.equal(result.type, "error"); assert.equal(result.errorCode, "auth"); assert.equal(calls.length, 0);
  });
});

test("list 空列表、错误和 body timeout 不 fallback 假成功", async () => {
  await mock(() => new Response("[]"), async () => assert.equal((await listPollinationsModels(provider())).errorCode, "empty_response"));
  await mock(() => new Response("", { status: 402 }), async ({ calls }) => {
    assert.equal((await listPollinationsModels(provider())).errorCode, "quota"); assert.equal(calls.length, 1);
  });
  await mock(() => new Response(new ReadableStream({ start() {} })), async ({ clock }) => {
    const pending = listPollinationsModels(provider({ timeoutMs: 100 }));
    await flush(); clock.advance(100); assert.equal((await pending).errorCode, "timeout");
  });
});

test("顶层 reasoning 也规范化，只有顶层 reasoning 仍明确失败", async () => {
  await mock(() => sseResponse([{ reasoning: "顶层思考" }, chunk({ content: "回答" }, "stop")]), async () => {
    const events = await collect(); success(events);
    assert.equal(events[0].type, "reasoning"); assert.equal(events[0].text, "顶层思考");
  });
  await mock(() => new Response(JSON.stringify({ reasoning: "只有思考" })), async () => {
    const events = await collect(); failed(events, "empty_response", 200);
    assert.equal(events[0].type, "reasoning");
  });
});

test("未知 reasoningEffort 不允许继承对象原型字段", async () => {
  await mock(() => jsonResponse(), async ({ calls }) => {
    success(await collect(provider(), request({ reasoningEffort: "__proto__" })));
    assert(!("reasoning_effort" in JSON.parse(calls[0].opts.body)));
  });
});

test("200 错误 JSON 的 Retry-After 也限制 own key 重试", async () => {
  await mock((_url, _opts, calls) => calls.length === 1
    ? new Response(JSON.stringify({ error: { status: 429 } }), { headers: { "Retry-After": "20" } })
    : jsonResponse(), async ({ clock, calls }) => {
    const pending = collect(provider({ apiKey: "own" }), request({ maxRetries: 1 }));
    await flush(); assert.equal(calls.length, 1);
    clock.advance(19999); await flush(); assert.equal(calls.length, 1);
    clock.advance(1); success(await pending); assert.equal(calls[1].at, 20000);
  });
});

test("总 timeout 覆盖 fetch 等待，无网络重试", async () => {
  await mock(() => new Promise(() => {}), async ({ clock, calls }) => {
    const pending = collect(provider(), request({ timeoutMs: 100, maxRetries: 1 }));
    await flush(); clock.advance(100); failed(await pending, "timeout"); assert.equal(calls.length, 1);
  });
});

test("不合法的请求参数终止且不发网络请求", async () => {
  await mock(() => { throw new Error("不应 fetch"); }, async ({ calls }) => {
    failed(await collect(provider(), request({ maxTokens: -1 })), "invalid_request");
    failed(await collect(provider(), request({ timeoutMs: 0 })), "invalid_request");
    failed(await collect(provider(), request({ messages: null })), "invalid_request");
    assert.equal(calls.length, 0);
  });
});

(async () => {
  let passed = 0;
  for (const item of cases) {
    try { await item.fn(); passed++; console.log(`通过 ${passed}：${item.name}`); }
    catch (err) { console.error(`失败：${item.name}`); console.error(err); process.exitCode = 1; }
  }
  console.log(`Pollinations 独立测试：${passed}/${cases.length} 通过（全部使用 mock fetch/clock，无真实服务请求或 16s 等待）`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
