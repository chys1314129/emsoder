#!/usr/bin/env node
/*
 * End-to-end adapter regression for 女娲 Phase 5 双Agent精炼:
 * Real PiRunnerAdapter receives a parent spawn_subagent tool call, dispatches
 * two concurrent sidecar subagents over the same client, returns their output
 * to the parent, then parent completes the refinement turn.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emsoder-pi-nested-adapter-"));
require.cache[require.resolve("electron")] = {
  id: "electron", filename: "electron", loaded: true,
  exports: { app: { getPath: () => tmpDir, isReady: () => true } },
};

const providers = require("../src/providers");
let parentCalls = 0;
let subagentCalls = 0;
let mockMode = "nested";
let mockChunks = [];
let mockConsumed = 0;
let mockClosed = false;
let mockAbort = null;
providers.streamChat = async function* mockStreamChat(_cfg, req) {
  if (mockMode !== "nested") {
    assert.ok((req.tools || []).every((t) => piTools.some((p) => p.name === t.function.name)), "mock 上下文必须来自 Pi 工具定义");
    try {
      for (const chunk of mockChunks) {
        mockConsumed += 1;
        if (mockMode === "abort-error" && chunk.type === "error") mockAbort.abort();
        if (mockMode === "abort-tool" && chunk.type === "tool_call") mockAbort.abort();
        yield chunk;
      }
      if (mockMode === "throw") throw new Error("流读取失败");
    } finally {
      mockClosed = true;
    }
    return;
  }
  const messages = req.messages || [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = typeof lastUser?.content === "string"
    ? lastUser.content
    : JSON.stringify(lastUser?.content || "");
  const isSubagent = /Agent [AB]：|结构优化评审|激活条件评审/.test(text);
  if (isSubagent) {
    subagentCalls += 1;
    yield { type: "text", text: `子代理评审完成：${text.slice(0, 24)}` };
    return;
  }
  parentCalls += 1;
  const hasSubagentToolResult = messages.some(
    (m) => m.role === "tool" && String(m.name || "") === "spawn_subagent"
  );
  if (!hasSubagentToolResult) {
    yield {
      type: "tool_call",
      toolCall: {
        id: "phase5-spawn", index: 0,
        function: {
          name: "spawn_subagent",
          arguments: JSON.stringify({
            tasks: [
              { task: "Agent A：做结构优化评审" },
              { task: "Agent B：做激活条件评审" },
            ],
            maxRounds: 3,
          }),
        },
      },
    };
    return;
  }
  yield { type: "text", text: "已综合两份双Agent评审并完成精炼。" };
};

const { SessionStore } = require("../src/agent/session");
const { AgentRunner } = require("../src/agent/runner");
const { PiRunnerAdapter, asPiToolDefs } = require("../src/pi/runnerAdapter");
const piTools = asPiToolDefs();

async function testProxyProvider() {
  const adapter = new PiRunnerAdapter(null, null, null);
  const tools = piTools.filter((t) => t.name === "read_file" || t.name === "list_dir");
  assert.strictEqual(tools.length, 2, "使用真实 Pi 工具白名单");
  const call = (id, index, args, name = "read_file") => ({
    type: "tool_call", toolCall: { id, index, function: { name, arguments: args } },
  });
  const invoke = async (mode, chunks, contextTools = tools, withStatus = true, isSub = true) => {
    mockMode = mode;
    mockChunks = chunks;
    mockConsumed = 0;
    mockClosed = false;
    mockAbort = new AbortController();
    const statuses = [];
    const result = await adapter._proxyProvider({
      cfg: { activeModel: "test-model", reasoningEffort: "medium", contextWindow: 128000 },
      abort: mockAbort,
      events: withStatus ? { onStatus: (status) => statuses.push(status) } : {},
    }, {
      ...(isSub ? { subSessionId: "proxy-unit" } : {}),
      model: { id: "test-model", api: "openai-completions", provider: "test" },
      context: { messages: [], tools: contextTools },
    });
    assert.ok(mockClosed, "代理必须关闭供应商迭代器");
    return { ...result, statuses };
  };
  const finalTools = (r) => r.final.content.filter((b) => b.type === "toolCall");
  const toolEvents = (r) => r.events.filter((e) => e.type === "tool_call");
  const assertFailed = (r, reason = "error") => {
    assert.strictEqual(r.final.stopReason, reason);
    assert.ok(typeof r.final.errorMessage === "string" && r.final.errorMessage, "最终消息须保留错误原因");
    assert.deepStrictEqual(finalTools(r), [], "失败时不能返回可执行工具");
    assert.deepStrictEqual(toolEvents(r), [], "失败时不能泄漏工具完成事件");
  };

  try {
    const single = await invoke("snapshots", [
      call("same-id", undefined, '{"path":"'),
      call("same-id", undefined, '{"path":"README.md"}'),
    ]);
    assert.strictEqual(single.final.stopReason, "toolUse");
    assert.strictEqual(finalTools(single).length, 1, "同 id 累计快照只能生成一个调用");
    assert.deepStrictEqual(finalTools(single)[0].arguments, { path: "README.md" });
    assert.strictEqual(toolEvents(single).length, 1, "仅转发最终工具快照");
    assert.deepStrictEqual(toolEvents(single)[0].call.arguments, { path: "README.md" });

    const indexed = await invoke("snapshots", [
      call(undefined, 0, '{"path":"'),
      call(undefined, 1, '{"path":"', "list_dir"),
      call("index-first", 0, '{"path":"a.txt"}'),
      call(undefined, 1, '{"path":"src"}', "list_dir"),
      call("index-first", undefined, '{"path":"b.txt"}'),
    ]);
    assert.strictEqual(finalTools(indexed).length, 2, "两个 index 必须保留两个调用");
    assert.deepStrictEqual(finalTools(indexed).map((c) => c.arguments), [{ path: "b.txt" }, { path: "src" }]);
    assert.strictEqual(new Set(finalTools(indexed).map((c) => c.id)).size, 2, "缺失 id 也须产生唯一调用 id");
    assert.deepStrictEqual(toolEvents(indexed).map((e) => e.call.id), finalTools(indexed).map((c) => c.id));

    for (const args of ['{"path":', "", "[]", "null", "42", '"path"', "true", [], null, undefined]) {
      const invalid = await invoke("invalid", [
        call("valid", 0, '{"path":"safe.txt"}'),
        call("invalid", 1, args),
      ]);
      assertFailed(invalid);
      assert.match(invalid.final.errorMessage, /参数/);
    }
    const invalidLatest = await invoke("invalid", [call("latest", 0, "{}"), call("latest", 0, "null")]);
    assertFailed(invalidLatest);
    const noKey = await invoke("invalid", [call(undefined, undefined, "{}")]);
    assertFailed(noKey);
    assert.match(noKey.final.errorMessage, /index\/id/);
    const objectArgs = await invoke("snapshots", [call("object", 0, { path: "object.txt" })]);
    assert.deepStrictEqual(finalTools(objectArgs)[0].arguments, { path: "object.txt" });
    const emptyObject = await invoke("snapshots", [call("empty", 0, "{}", "list_dir")]);
    assert.deepStrictEqual(finalTools(emptyObject)[0].arguments, {});

    for (const name of ["unknown_tool", "read_file<|channel|>commentary", " read_file", "spawn_subagent"]) {
      const unknown = await invoke("unknown", [call("unknown", 0, "{}", name)]);
      assertFailed(unknown);
      assert.match(unknown.final.errorMessage, /未知工具/);
    }
    const noTools = await invoke("unknown", [call("no-tools", 0, "{}")], []);
    assertFailed(noTools);

    const errorChunks = [
      { type: "text", text: "已接收部分回复" },
      { type: "reasoning", text: "部分思考" },
      call("before-error", 0, '{"path":"safe.txt"}'),
      { type: "error", error: "供应商失败" },
      call("after-error", 1, '{"path":"unsafe.txt"}'),
      { type: "text", text: "不应消费" },
    ];
    const providerError = await invoke("error", errorChunks);
    assertFailed(providerError);
    assert.strictEqual(providerError.final.errorMessage, "供应商失败");
    assert.strictEqual(mockConsumed, 4, "遇到 error 必须立即停止消费");
    assert.deepStrictEqual(providerError.final.content, [
      { type: "thinking", thinking: "部分思考" },
      { type: "text", text: "已接收部分回复" },
    ]);
    const earlyError = await invoke("error", [
      { type: "error", error: { message: "首片失败" } },
      call("after-error", 0, "{}"),
    ]);
    assertFailed(earlyError);
    assert.strictEqual(earlyError.final.errorMessage, "首片失败");
    assert.strictEqual(mockConsumed, 1);
    const fallbackError = await invoke("error", [{ type: "error" }]);
    assertFailed(fallbackError);
    assert.strictEqual(fallbackError.final.errorMessage, "provider error");
    const aborted = await invoke("abort-error", errorChunks);
    assertFailed(aborted, "aborted");
    assert.strictEqual(aborted.final.errorMessage, "供应商失败", "abort 优先但不能丢失供应商错误");
    const abortTool = await invoke("abort-tool", [call("aborted", 0, "{}"), { type: "text", text: "不应消费" }]);
    assertFailed(abortTool, "aborted");
    assert.strictEqual(mockConsumed, 1);
    const thrown = await invoke("throw", [call("before-throw", 0, "{}")]);
    assertFailed(thrown);
    assert.strictEqual(thrown.final.errorMessage, "流读取失败");

    const schemaInvalid = await invoke("invalid", [call("required", 0, "{}")]);
    assertFailed(schemaInvalid);
    assert.match(schemaInvalid.final.errorMessage, /required/);
    const reasoning = await invoke("reasoning", [
      { type: "reasoning", text: "先分析，" },
      { type: "status", status: "供应商正在处理" },
      { type: "reasoning", text: "再得出结论。" },
      { type: "text", text: "最终回答" },
    ]);
    assert.strictEqual(reasoning.final.stopReason, "stop");
    assert.deepStrictEqual(reasoning.final.content, [
      { type: "thinking", thinking: "先分析，再得出结论。" },
      { type: "text", text: "最终回答" },
    ]);
    assert.deepStrictEqual(reasoning.events.filter((e) => e.type === "reasoning").map((e) => e.text), ["先分析，", "再得出结论。"]);
    assert.deepStrictEqual(reasoning.statuses, ["供应商正在处理"]);
    const noStatus = await invoke("status", [{ type: "status", status: "可选回调" }], tools, false, false);
    assert.strictEqual(noStatus.final.stopReason, "stop");
    const invalidStatus = await invoke("status", [{ type: "status", status: null }]);
    assert.deepStrictEqual(invalidStatus.statuses, []);
    console.log("OK _proxyProvider 快照去重、严格参数、白名单、错误/停止、thinking 与 status 单元测试通过");
  } finally {
    mockMode = "nested";
    mockChunks = [];
    mockAbort = null;
  }
}

(async () => {
  await testProxyProvider();
  const store = new SessionStore();
  const session = store.create("agent");
  const legacy = new AgentRunner(store, null, null);
  const adapter = new PiRunnerAdapter(store, legacy, null);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "emsoder-phase5-ws-"));
  const events = {
    texts: [], errors: [], tools: [], done: null,
    onText(t) { this.texts.push(t); },
    onError(e) { this.errors.push(String(e)); },
    onToolStart(name) { this.tools.push(name); },
    onDone(reason) { this.done = reason; },
    onFileChanges() {},
    onStatus() {},
    confirm: async () => true,
  };
  const cfg = {
    providers: [{ id: "test", name: "test", type: "openai", baseUrl: "http://test", apiKey: "x", models: ["test-model"], enabled: true }],
    activeProviderId: "test", activeModel: "test-model",
    contextWindow: 128000, reasoningEffort: "medium", maxTokens: 0,
    agentAutoContinue: -1, lastWorkspace: workspace,
    skillsEnabled: false,
  };

  await adapter.runUserMessage(
    cfg,
    "执行女娲 Phase 5 双Agent精炼",
    events,
    { workspaceRoot: workspace, openTabs: [], activeFile: "", selection: "", runMode: "auto" }
  );

  assert.deepStrictEqual(events.errors, [], "no opaque failure");
  assert.strictEqual(events.done, "done", "parent completes normally");
  assert.ok(events.tools.includes("spawn_subagent"), "parent invoked spawn_subagent");
  assert.strictEqual(subagentCalls, 2, "both Phase 5 subagents ran");
  assert.ok(parentCalls >= 2, "parent resumed after child reports");
  assert.ok(events.texts.join("").includes("已综合两份双Agent评审"), "parent received child results and refined");

  await adapter.close();
  console.log("OK real PiRunnerAdapter nested dual-agent refinement completes");
})().catch((e) => { console.error(e); process.exit(1); });
