/**
 * Unit smoke for Chat Agent file change review / reject / accept.
 * Usage: node scripts/test-file-changes.js
 */
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { AgentRunner } = require("../src/agent/runner");
const { executeTool } = require("../src/tools/executor");

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}

function createSessions() {
  const session = {
    id: "s-test",
    title: "test",
    mode: "agent",
    messages: [],
    activeLeafId: null,
    fileChanges: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return {
    session,
    getActive: () => session,
    getById: (id) => (id === session.id ? session : undefined),
    beginFileChangeTurn: () => {
      session.fileChanges = [];
      return session;
    },
    recordFileChange(change) {
      const abs = change.path;
      let row = session.fileChanges.find((f) => f.path === abs);
      if (!row) {
        row = {
          path: abs,
          relative: change.relative || abs,
          kind: change.kind || "edit",
          before: change.before ?? null,
          after: change.after ?? null,
          rejected: false,
        };
        session.fileChanges.push(row);
      } else {
        if (change.before != null && row.before == null) row.before = change.before;
        if (change.after != null) row.after = change.after;
        row.kind = change.kind || row.kind;
        row.rejected = false;
      }
      return row;
    },
    removeFileChange(filePath) {
      const before = session.fileChanges.length;
      session.fileChanges = session.fileChanges.filter((f) => f.path !== filePath);
      return session.fileChanges.length !== before;
    },
    rejectChange(filePath) {
      const row = session.fileChanges.find((f) => f.path === filePath);
      if (!row) return null;
      row.rejected = true;
      return row;
    },
    clearFileChanges() {
      session.fileChanges = [];
      return session.fileChanges;
    },
    getFileChanges: () => session.fileChanges,
    publicFileChanges: () => session.fileChanges.map((f) => ({
      path: f.path,
      relative: f.relative || f.path,
      kind: f.kind || "edit",
      rejected: !!f.rejected,
    })),
  };
}

async function runMutatingTool(runner, sessions, root, name, args, ctxExtra = {}) {
  const argsJson = JSON.stringify(args);
  const snap = await runner._snapshotBeforeWrite(root, argsJson, sessions.session.id);
  const result = await executeTool(
    {
      workspaceRoot: root,
      cfg: { autoApproveSafe: true, ...(ctxExtra.cfg || {}) },
      confirm: ctxExtra.confirm || (async () => true),
      onFsChange: ctxExtra.onFsChange,
    },
    name,
    argsJson
  );
  if (result.ok) {
    await runner._captureAfterWrite(root, name, argsJson, sessions.session.id);
  } else if (snap?.path) {
    runner._discardUnchangedFailedSnapshot(snap.path, sessions.session.id);
  }
  return result;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "emsoder-file-changes-"));
  try {
    const sessions = createSessions();
    const runner = new AgentRunner(sessions);
    sessions.beginFileChangeTurn();

    // create then reject deletes file
    let out = await runMutatingTool(runner, sessions, root, "write_file", {
      path: "created.txt",
      content: "new file\n",
    });
    assert(out.ok, "write_file create should succeed");
    let createdAbs = path.join(root, "created.txt");
    assert(sessions.session.fileChanges.length === 1, "create should record one row");
    assert(sessions.session.fileChanges[0].before == null, "create before should be null");
    assert(sessions.publicFileChanges()[0].before === undefined, "public payload must not expose before");
    assert(sessions.publicFileChanges()[0].after === undefined, "public payload must not expose after");
    out = await runner.applyReject(createdAbs, sessions.session.id);
    assert(out.ok, "reject create should succeed");
    try {
      await fs.readFile(createdAbs, "utf8");
      assert(false, "created file should be deleted");
    } catch {
      /* expected */
    }
    assert(sessions.session.fileChanges[0].rejected, "create row should be rejected");

    // overwrite then reject restores exact original
    sessions.beginFileChangeTurn();
    const editAbs = path.join(root, "edit.txt");
    await fs.writeFile(editAbs, "old\n", "utf8");
    out = await runMutatingTool(runner, sessions, root, "write_file", {
      path: "edit.txt",
      content: "new\n",
    });
    assert(out.ok, "write overwrite should succeed");
    assert(sessions.session.fileChanges[0].before === "old\n", "overwrite before captured");
    assert(sessions.session.fileChanges[0].after === "new\n", "overwrite after captured");
    out = await runner.applyReject(editAbs, sessions.session.id);
    assert(out.ok, "reject overwrite should succeed");
    assert((await fs.readFile(editAbs, "utf8")) === "old\n", "overwrite reject restores old");

    // multiple edits keep first before and latest after
    sessions.beginFileChangeTurn();
    await fs.writeFile(editAbs, "A\n", "utf8");
    out = await runMutatingTool(runner, sessions, root, "edit_file", {
      path: "edit.txt",
      old_string: "A",
      new_string: "B",
    });
    assert(out.ok, "first edit should succeed");
    out = await runMutatingTool(runner, sessions, root, "edit_file", {
      path: "edit.txt",
      old_string: "B",
      new_string: "C",
    });
    assert(out.ok, "second edit should succeed");
    assert(sessions.session.fileChanges.length === 1, "same file should coalesce one row");
    assert(sessions.session.fileChanges[0].before === "A\n", "keeps first before");
    assert(sessions.session.fileChanges[0].after === "C\n", "keeps latest after");

    // failed apply_diff does not leave visible fileChanges
    sessions.beginFileChangeTurn();
    await fs.writeFile(editAbs, "only\n", "utf8");
    out = await runMutatingTool(runner, sessions, root, "apply_diff", {
      path: "edit.txt",
      hunks: [{ old_string: "missing", new_string: "x" }],
    });
    assert(!out.ok, "missing apply_diff should fail");
    assert(sessions.session.fileChanges.length === 0, "failed apply_diff should not stay in fileChanges");

    // denied write does not leave visible fileChanges or fs change
    sessions.beginFileChangeTurn();
    let fsChanges = 0;
    out = await runMutatingTool(runner, sessions, root, "write_file", {
      path: "denied.txt",
      content: "x",
    }, {
      cfg: { autoApproveSafe: false, autoRunTools: false },
      confirm: async () => false,
      onFsChange: () => { fsChanges += 1; },
    });
    assert(!out.ok && out.needConfirm, "denied write should need confirm");
    assert(fsChanges === 0, "denied write should not call onFsChange");
    assert(sessions.session.fileChanges.length === 0, "denied write should not stay in fileChanges");

    // stale protection does not overwrite user's later change
    sessions.beginFileChangeTurn();
    await fs.writeFile(editAbs, "base\n", "utf8");
    out = await runMutatingTool(runner, sessions, root, "write_file", {
      path: "edit.txt",
      content: "agent\n",
    });
    assert(out.ok, "agent write should succeed");
    await fs.writeFile(editAbs, "manual\n", "utf8");
    out = await runner.applyReject(editAbs, sessions.session.id);
    assert(out.ok === false && out.code === "STALE_FILE", "stale reject should fail safely");
    assert((await fs.readFile(editAbs, "utf8")) === "manual\n", "stale reject must not overwrite manual content");

    // reject all + accept-all semantics
    sessions.beginFileChangeTurn();
    await fs.writeFile(path.join(root, "a.txt"), "a0", "utf8");
    await fs.writeFile(path.join(root, "b.txt"), "b0", "utf8");
    await runMutatingTool(runner, sessions, root, "write_file", { path: "a.txt", content: "a1" });
    await runMutatingTool(runner, sessions, root, "write_file", { path: "b.txt", content: "b1" });
    out = await runner.applyRejectAll(sessions.session.id);
    assert(out.ok, "reject all should return ok");
    assert((await fs.readFile(path.join(root, "a.txt"), "utf8")) === "a0", "a restored");
    assert((await fs.readFile(path.join(root, "b.txt"), "utf8")) === "b0", "b restored");

    sessions.beginFileChangeTurn();
    await runMutatingTool(runner, sessions, root, "write_file", { path: "a.txt", content: "accepted" });
    sessions.clearFileChanges(sessions.session.id);
    assert(sessions.session.fileChanges.length === 0, "accept clears list");
    assert((await fs.readFile(path.join(root, "a.txt"), "utf8")) === "accepted", "accept does not modify disk");
  } finally {
    try {
      await fs.rm(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log("OK file changes smoke test");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
