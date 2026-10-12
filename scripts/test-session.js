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
  assert(s1.runStatus === "idle", "new session idle");
  store.beginFileChangeTurn();
  assert(store.getActive().runStatus === "running", "begin turn -> running");
  store.recordFileChange({ path: "/tmp/a.js", relative: "a.js", kind: "edit", before: "a", after: "b" });
  store.settleRun("done");
  assert(store.getActive().runStatus === "review", "pending files -> review");
  store.clearFileChanges();
  assert(store.getActive().runStatus === "idle", "accept changes -> idle");
  store.beginFileChangeTurn();
  store.settleRun("stopped");
  assert(store.getActive().runStatus === "stopped", "stop with no files -> stopped");
  store.beginFileChangeTurn();
  store.recordFileChange({ path: "/tmp/b.js", relative: "b.js", kind: "edit" });
  store.settleRun("stopped");
  assert(store.getActive().runStatus === "review", "stop with files still review");

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
  assert(cleared.runStatus === "idle", "clear resets runStatus");

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

  // --- compact keeps file changes by default ---
  const s4 = store.create("agent");
  store.append({ role: "user", content: "做登录" });
  store.append({ role: "assistant", content: "先看文件" });
  store.append({ role: "user", content: "继续" });
  store.append({ role: "assistant", content: "改完了" });
  store.recordFileChange({
    path: "/tmp/login.js",
    relative: "login.js",
    kind: "edit",
    before: "a",
    after: "b",
  });
  const compacted = store.compactActive("早先目标是做登录", [
    store.getActivePath().slice(-2)[0],
    store.getActivePath().slice(-1)[0],
  ]);
  assert(compacted.afterCount >= 2, "compact keeps tail");
  assert(
    (store.getActive().fileChanges || []).some((f) => f.relative === "login.js"),
    "compact keeps pending file changes"
  );
  store.compactActive("清改动", [store.getActivePath().slice(-1)[0]], {
    keepFileChanges: false,
  });
  assert(
    (store.getActive().fileChanges || []).length === 0,
    "compact can drop file changes"
  );

  const {
    selectKeepAndOlder,
    shouldAutoCompress,
    compressActiveSession,
  } = require("../src/agent/compress");
  const pathMsgs = [];
  for (let i = 0; i < 12; i++) {
    pathMsgs.push({
      id: "u" + i,
      role: i % 2 === 0 ? "user" : "assistant",
      content: i === 0 ? "最初目标：做登录页" : "消息" + i,
    });
  }
  const picked = selectKeepAndOlder(pathMsgs, 4);
  assert(picked.ok, "enough messages to compress");
  assert(picked.keep[0].content.includes("最初目标"), "pins first user goal");
  assert(picked.older.length > 0, "has older messages");
  const withTools = [
    { role: "user", content: "最初目标：重构" },
    { role: "assistant", content: "先读文件" },
    { role: "tool", content: "old tool", toolName: "read_file" },
    { role: "user", content: "继续" },
    { role: "assistant", content: "调用工具: write_file" },
    { role: "tool", content: "wrote", toolName: "write_file" },
    { role: "assistant", content: "改完了" },
  ];
  const keepTools = selectKeepAndOlder(withTools, 2);
  assert(
    keepTools.keep.some((m) => m.role === "tool" && m.toolName === "write_file"),
    "tail keeps recent tool results"
  );
  assert(
    !keepTools.keep.some((m) => m.content === "old tool"),
    "old tools can be dropped"
  );
  assert(
    shouldAutoCompress({}, { fillPercent: 81 }) === true,
    "80%+ triggers auto compact"
  );
  assert(
    shouldAutoCompress({}, { fillPercent: 50 }) === false,
    "low fill does not trigger"
  );

  const s5 = store.create("agent");
  for (let i = 0; i < 12; i++) {
    store.append({
      role: i % 2 === 0 ? "user" : "assistant",
      content: i === 0 ? "最初目标：写 README" : "轮次" + i,
    });
  }
  const auto = await compressActiveSession({
    sessions: store,
    cfg: {},
    keepRecent: 4,
    chat: async () => "摘要：用户要写 README",
  });
  assert(auto.ok, "compressActiveSession ok");
  assert(
    String(store.getActivePath()[0].content).includes("上下文已压缩"),
    "writes compact summary"
  );
  assert(
    store.getActivePath().some((m) => String(m.content).includes("最初目标")),
    "keeps first user goal"
  );

  // --- context branch exclusion / restore / permanent delete ---
  const s6 = store.create("agent", "D:/context-test");
  const u1 = store.append({ role: "user", content: "第一问" }, s6.id);
  const a1 = store.append({ role: "assistant", content: "第一答" }, s6.id);
  const u2 = store.append({ role: "user", content: "第二问" }, s6.id);
  const a2 = store.append({ role: "assistant", content: "第二答" }, s6.id);
  const excluded = store.excludeMessageBranch(u2.id, s6.id);
  assert(excluded.activeLeafId === a1.id, "exclude active subtree falls back to parent");
  assert(!store.getContextPath(s6).some((m) => m.id === u2.id || m.id === a2.id), "excluded branch absent from context");
  assert(store.getExcludedBranches(s6).some((b) => b.id === u2.id), "excluded root is recoverable");
  store.restoreMessageBranch(u2.id, s6.id);
  assert(!store.getById(s6.id).messages.find((m) => m.id === u2.id).excludedFromContext, "restore clears exclusion");
  store.switchBranch(u2.id, "leaf");
  assert(store.getActive().activeLeafId === a2.id, "restored branch is selectable");
  const deleted = store.deleteMessageBranch(u2.id, s6.id);
  assert(!store.getById(s6.id).messages.some((m) => m.id === u2.id || m.id === a2.id), "permanent delete removes subtree");
  assert(deleted.activeLeafId === a1.id, "delete active subtree falls back to parent");
  const edited = store.editAssistantMessage(a1.id, "修改后的第一答", s6.id);
  assert(edited.message.content === "修改后的第一答", "plain assistant edit creates replacement");
  assert(edited.message.parentId === u1.id, "assistant replacement is safe sibling");

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
