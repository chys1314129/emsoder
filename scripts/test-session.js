/**
 * Unit smoke for the chat SessionStore (title / clear / rename / counts).
 * Usage: node scripts/test-session.js
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}

async function main() {
  // Stub Electron app.getPath("userData") before requiring config/session
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emsoder-sess-"));
  const fakeApp = { getPath: () => tmpDir, isReady: () => true };
  require.cache[require.resolve("electron")] = {
    id: "electron",
    filename: "electron",
    loaded: true,
    exports: { app: fakeApp },
  };

  const { SessionStore, makeSessionTitle } = require("../src/agent/session");

  // --- makeSessionTitle ---
  assert(makeSessionTitle("  你好   世界  ") === "你好 世界", "collapse+trim");
  assert(makeSessionTitle(""), "新对话", "empty -> 新对话");
  assert(makeSessionTitle("   ") === "新对话", "whitespace -> 新对话");
  assert(makeSessionTitle("x".repeat(30)) === "x".repeat(22) + "…", "truncate 22 + …");
  assert(makeSessionTitle("短标题") === "短标题", "short kept");

  const store = new SessionStore();

  // --- create + append title generation ---
  const s1 = store.create("agent");
  assert(s1.title === "新对话", "new session default title");
  store.append({ role: "user", content: "  帮我写一个  登录页面  " });
  assert(store.getActive().title === "帮我写一个 登录页面", "title from first user msg");
  store.append({ role: "user", content: "第二次提问" });
  assert(store.getActive().title === "帮我写一个 登录页面", "title not overwritten after first");

  // --- visibleMessageCount ---
  const s2 = store.create("ask");
  store.append({ role: "user", content: "你好" });
  store.append({ role: "assistant", content: "在的" });
  store.append({ role: "tool", content: "tool out", toolName: "write_file" });
  store.append({ role: "assistant", content: "调用工具: write_file" });
  store.append({ role: "reasoning", content: "思考中" });
  assert(store.visibleMessageCount(s2) === 2, "count excludes tool/reasoning/placeholder");

  // --- clearActive resets ---
  store.setActive(s2.id);
  store.getActive().fileChanges = [{ path: "/tmp/a", rejected: false }];
  store.clearActive();
  const cleared = store.getActive();
  assert(cleared.title === "新对话", "clear resets title");
  assert(cleared.messages.length === 0, "clear empties messages");
  assert(cleared.activeLeafId === null, "clear resets leaf");
  assert(cleared.fileChanges.length === 0, "clear empties fileChanges");

  // --- rename ---
  const r1 = store.rename(s2.id, "  项目重构  ");
  assert(r1 && r1.title === "项目重构", "rename trims");
  const r2 = store.rename(s2.id, "   ");
  assert(r2 && r2.title === "新对话", "rename blank -> 新对话");
  assert(store.rename("nope", "x") === null, "rename missing id -> null");

  // --- list sorting (updatedAt desc) ---
  const s3 = store.create("agent");
  await new Promise((r) => setTimeout(r, 5));
  store.append({ role: "user", content: "最新会话" });
  const list = store.list();
  assert(list[0].id === s3.id, "list sorted by updatedAt desc");
  assert(store.list().length >= 3, "list contains sessions");

  // cleanup
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  console.log("OK session store smoke test");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
