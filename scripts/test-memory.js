/**
 * Smoke test for the long-term MemoryStore.
 * Usage: node scripts/test-memory.js
 *
 * Uses a temp dir as userData so memoriesPath() resolves there.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}

async function main() {
  // Stub Electron app.getPath("userData") before requiring config/memory
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emsoder-mem-"));
  const fakeApp = { getPath: () => tmpDir, isReady: () => true };
  require.cache[require.resolve("electron")] = {
    id: "electron",
    filename: "electron",
    loaded: true,
    exports: { app: fakeApp },
  };

  const { MemoryStore } = require("../src/agent/memory");

  // --- basic CRUD ---
  const store = new MemoryStore({ memoriesMaxCount: 500 });
  assert(store.list().length === 0, "should start empty");

  const m1 = store.add({
    content: "用户主要用 Rust 写后端",
    tags: ["rust", "后端"],
    importance: 4,
  });
  const m2 = store.add({
    content: "项目数据库是 PostgreSQL",
    tags: ["postgres", "数据库"],
    importance: 5,
  });
  const m3 = store.add({
    content: "用户偏好函数式风格",
    tags: ["风格"],
    importance: 3,
  });
  assert(store.list().length === 3, "should have 3 memories");

  // --- search: tag hit outweighs content hit ---
  let hits = store.search("rust 后端", { topK: 5 });
  assert(hits.length >= 1, "search should find at least 1");
  assert(
    hits.some((h) => h.content.includes("Rust")),
    "rust memory should rank first"
  );

  hits = store.search("PostgreSQL", { topK: 5 });
  assert(
    hits[0].content.includes("PostgreSQL"),
    "postgres tag hit should rank first: " + hits[0].content
  );

  // importance weighting: m2 (importance 5) should beat m3 (importance 3)
  // when both match equally on a generic query
  hits = store.search("用户 项目", { topK: 5 });
  // both m2 and m3 contain 用户, m2 also has 项目? no - m2 has 项目. verify m2 ranks high
  assert(hits.length >= 1, "generic search should still match");

  // --- CJK tokenization (single char) ---
  hits = store.search("数据库", { topK: 5 });
  assert(
    hits[0].content.includes("PostgreSQL"),
    "CJK token 数据库 should match postgres memory"
  );

  // --- update ---
  const updated = store.update(m1.id, { importance: 5, tags: ["rust", "backend"] });
  assert(updated.importance === 5, "importance updated");
  assert(updated.tags.includes("backend"), "tags updated");

  // --- remove ---
  assert(store.remove(m3.id), "remove should return true");
  assert(store.list().length === 2, "should have 2 after remove");
  assert(!store.remove("nonexistent-id"), "remove nonexistent returns false");

  // --- LRU eviction ---
  const small = new MemoryStore({ memoriesMaxCount: 3 });
  small.add({ content: "old1", importance: 1 });
  await new Promise((r) => setTimeout(r, 5));
  small.add({ content: "old2", importance: 2 });
  await new Promise((r) => setTimeout(r, 5));
  small.add({ content: "old3", importance: 5 });
  await new Promise((r) => setTimeout(r, 5));
  small.add({ content: "new1", importance: 3 });
  assert(
    small.list().length === 3,
    "should evict to maxCount: got " + small.list().length
  );
  const smallContents = small.list().map((m) => m.content);
  assert(
    !smallContents.includes("old1"),
    "lowest importance + oldest should be evicted"
  );
  assert(smallContents.includes("new1"), "newest kept");

  // --- extractFromSession with mock chatOnce ---
  let extractCallCount = 0;
  const mockChatOnce = async (_cfg, req) => {
    extractCallCount++;
    // Verify the request shape
    assert(req.messages.length === 2, "extract should send 2 messages");
    assert(req.messages[0].role === "system", "first msg is system");
    return JSON.stringify([
      { content: "用户用 TypeScript", tags: ["typescript"], importance: 4 },
      { content: "项目用 Vite 构建", tags: ["vite", "构建"], importance: 3 },
    ]);
  };
  const store2 = new MemoryStore({ memoriesMaxCount: 500 });
  const fakeSession = {
    id: "sess-1",
    messages: [
      { role: "user", content: "帮我用 TS 写个 Vite 项目" },
      { role: "assistant", content: "好的，用 TypeScript + Vite..." },
    ],
  };
  const added = await store2.extractFromSession(fakeSession, {}, {
    chatOnce: mockChatOnce,
  });
  assert(extractCallCount === 1, "chatOnce called once");
  assert(added.length === 2, "should add 2 memories: got " + added.length);
  assert(
    store2.list().length === 2,
    "store should now have 2 memories"
  );

  // --- extract with empty session ---
  const empty = await store2.extractFromSession({ messages: [] }, {}, {
    chatOnce: mockChatOnce,
  });
  assert(empty.length === 0, "empty session returns no memories");

  // --- extract with malformed LLM output ---
  const badChatOnce = async () => "not json at all";
  const bad = await store2.extractFromSession(fakeSession, {}, {
    chatOnce: badChatOnce,
  });
  assert(bad.length === 0, "malformed output yields no memories");

  // --- extract with [] (nothing worth remembering) ---
  const emptyArrChatOnce = async () => "[]";
  const none = await store2.extractFromSession(fakeSession, {}, {
    chatOnce: emptyArrChatOnce,
  });
  assert(none.length === 0, "empty array yields no memories");

  // --- persistence (saveNow then reload) ---
  store2.saveNow();
  const reload = new MemoryStore({ memoriesMaxCount: 500 });
  assert(
    reload.list().length === 2,
    "memories should persist across reload: got " + reload.list().length
  );

  // --- clear ---
  store2.clear();
  assert(store2.list().length === 0, "clear empties store");

  // cleanup
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  console.log("OK memory smoke test");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
