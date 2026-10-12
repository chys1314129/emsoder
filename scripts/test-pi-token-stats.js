#!/usr/bin/env node
/* Pi provider usage regression: when a gateway omits streaming usage, the
 * adapter must commit its local token estimate so the bottom bar is non-zero.
 */
const assert = require("assert");
const { contextStats } = require("../src/core/contextStats");
const providers = require("../src/providers");

const originalStreamChat = providers.streamChat;
providers.streamChat = async function* mockStreamChat() {
  yield { type: "text", text: "这是一段没有 usage chunk 的 Pi 模型回答。" };
};

const { PiRunnerAdapter } = require("../src/pi/runnerAdapter");

(async () => {
  const seen = [];
  const cfg = {
    providers: [{ id: "test", name: "test", type: "openai", baseUrl: "http://test", apiKey: "x", models: ["test-model"], enabled: true }],
    activeProviderId: "test", activeModel: "test-model",
    contextWindow: 256000, reasoningEffort: "medium", maxTokens: 0,
  };
  const run = {
    cfg,
    sessionId: "token-stats-session",
    abort: new AbortController(),
    events: { onContextStats: (s) => seen.push(s) },
  };
  const adapter = new PiRunnerAdapter({}, {}, null);
  await adapter._proxyProvider(run, {
    model: { id: "test-model", provider: "test", api: "openai-completions" },
    reasoning: "medium",
    context: {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "请完成一个没有 usage 返回的测试任务。" }],
      tools: [],
    },
    maxTokens: 0,
  });

  assert.ok(seen.length >= 2, `expected begin + estimate stats, got ${seen.length}`);
  const last = seen[seen.length - 1];
  assert.ok(last.usedTokens > 0, `expected estimated usedTokens, got ${last.usedTokens}`);
  assert.strictEqual(last.contextWindow, 256000, "custom context window preserved");
  assert.strictEqual(last.lastSource, "estimate", "missing provider usage uses estimate source");
  assert.ok(last.estimated === false, "estimate is committed as a sample");

  providers.streamChat = originalStreamChat;
  console.log("OK Pi token usage fallback commits local estimate");
})().catch((error) => {
  providers.streamChat = originalStreamChat;
  console.error(error);
  process.exit(1);
});
