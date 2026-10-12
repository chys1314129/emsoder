/**
 * Unit smoke for apply_diff SEARCH/REPLACE parsing + safe terminal heuristics.
 * Usage: node scripts/test-apply-diff.js
 */
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  executeTool,
  parseSearchReplaceDiff,
  isSafeTerminalCommand,
} = require("../src/tools/executor");

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}

async function main() {
  // --- parse markers ---
  const parsed = parseSearchReplaceDiff(`<<<<<<< SEARCH
foo
=======
bar
>>>>>>> REPLACE
<<<<<<< SEARCH
a
=======
b
>>>>>>> REPLACE
`);
  assert(parsed.length === 2, "expected 2 hunks");
  assert(parsed[0].old_string === "foo" && parsed[0].new_string === "bar", "hunk0");
  assert(parsed[1].old_string === "a" && parsed[1].new_string === "b", "hunk1");

  assert(parseSearchReplaceDiff("").length === 0, "empty diff");
  assert(parseSearchReplaceDiff("no markers").length === 0, "no markers");

  // --- safe terminal ---
  assert(isSafeTerminalCommand("git status"), "git safe");
  assert(isSafeTerminalCommand("ls -la"), "ls safe");
  assert(isSafeTerminalCommand("grep foo bar"), "grep safe");
  assert(!isSafeTerminalCommand("rm -rf /"), "rm not safe");
  assert(!isSafeTerminalCommand("del /s /q C:\\Windows"), "del not safe");
  // 能下载/执行任意代码的命令必须走确认，不能当作“安全”自动放行
  assert(!isSafeTerminalCommand("npm test"), "npm must not be auto-safe");
  assert(!isSafeTerminalCommand("node -e 1"), "node must not be auto-safe");
  assert(!isSafeTerminalCommand("python x.py"), "python must not be auto-safe");
  assert(!isSafeTerminalCommand("npx pkg"), "npx must not be auto-safe");
  assert(!isSafeTerminalCommand("pip install x"), "pip must not be auto-safe");
  assert(!isSafeTerminalCommand("curl http://x"), "curl must not be auto-safe");
  assert(!isSafeTerminalCommand("./run.sh"), "dot-slash must not be auto-safe");

  // --- apply_diff via executeTool (temp workspace) ---
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "emsoder-apply-diff-"));
  const rel = "sample.txt";
  const abs = path.join(root, rel);
  await fs.writeFile(
    abs,
    ["line-one", "keep-me", "line-two", "line-three"].join("\n"),
    "utf8"
  );

  const ctx = {
    workspaceRoot: root,
    cfg: { autoApproveSafe: true },
    confirm: async () => false, // would deny if autoApprove not working
    onFsChange: () => {},
  };

  // multi hunk array
  let out = await executeTool(
    ctx,
    "apply_diff",
    JSON.stringify({
      path: rel,
      hunks: [
        { old_string: "line-one", new_string: "LINE-ONE" },
        { old_string: "line-two", new_string: "LINE-TWO" },
      ],
    })
  );
  assert(out.ok, "apply_diff hunks failed: " + out.content);
  let body = await fs.readFile(abs, "utf8");
  assert(body.includes("LINE-ONE") && body.includes("LINE-TWO"), "content after hunks");
  assert(body.includes("keep-me"), "unrelated line preserved");

  // SEARCH/REPLACE markers
  out = await executeTool(
    ctx,
    "apply_diff",
    JSON.stringify({
      path: rel,
      diff: `<<<<<<< SEARCH
LINE-ONE
=======
first
>>>>>>> REPLACE
`,
    })
  );
  assert(out.ok, "apply_diff markers failed: " + out.content);
  body = await fs.readFile(abs, "utf8");
  assert(body.startsWith("first\n"), "marker replace");

  // unique match required; validation failure must not ask for confirmation
  await fs.writeFile(abs, "x\nx\n", "utf8");
  let confirmCalls = 0;
  const countConfirmCtx = {
    workspaceRoot: root,
    cfg: {},
    confirm: async () => {
      confirmCalls += 1;
      return true;
    },
  };
  out = await executeTool(
    countConfirmCtx,
    "apply_diff",
    JSON.stringify({
      path: rel,
      hunks: [{ old_string: "x", new_string: "y" }],
    })
  );
  assert(!out.ok && /matched 2 times/i.test(out.content), "should reject non-unique");
  assert(confirmCalls === 0, "non-unique hunk should not call confirm");

  // missing old_string leaves file unchanged and must not ask for confirmation
  await fs.writeFile(abs, "only\n", "utf8");
  out = await executeTool(
    countConfirmCtx,
    "apply_diff",
    JSON.stringify({
      path: rel,
      hunks: [{ old_string: "missing", new_string: "z" }],
    })
  );
  assert(!out.ok && /not found/i.test(out.content), "should reject missing");
  assert(confirmCalls === 0, "missing hunk should not call confirm");
  body = await fs.readFile(abs, "utf8");
  assert(body === "only\n", "file must stay unchanged on failure");

  // autoApproveSafe must not prompt (confirm returns false)
  await fs.writeFile(abs, "alpha\n", "utf8");
  out = await executeTool(
    ctx,
    "apply_diff",
    JSON.stringify({
      path: rel,
      hunks: [{ old_string: "alpha", new_string: "beta" }],
    })
  );
  assert(out.ok, "autoApproveSafe should skip confirm");
  body = await fs.readFile(abs, "utf8");
  assert(body === "beta\n", "beta written");

  // denied when no auto flags
  let deniedFsChanges = 0;
  const denyCtx = {
    workspaceRoot: root,
    cfg: {},
    confirm: async () => false,
    onFsChange: () => { deniedFsChanges += 1; },
  };
  await fs.writeFile(abs, "gamma\n", "utf8");
  out = await executeTool(
    denyCtx,
    "apply_diff",
    JSON.stringify({
      path: rel,
      hunks: [{ old_string: "gamma", new_string: "delta" }],
    })
  );
  assert(!out.ok && out.needConfirm, "should need confirm when denied");
  assert(deniedFsChanges === 0, "denied apply_diff must not call onFsChange");
  body = await fs.readFile(abs, "utf8");
  assert(body === "gamma\n", "denied write must not change file");

  // cleanup best-effort
  try {
    await fs.rm(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  console.log("OK apply_diff smoke test");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
