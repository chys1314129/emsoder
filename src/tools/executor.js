const fs = require("fs/promises");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const { getCommandDenyList } = require("../core/config");
const { resolveSafePath } = require("./paths");
const { searchWorkspace } = require("./search");
const { createDocument } = require("./documents");
const {
  loadSkillCatalog,
  loadSkillContent,
  listSkillFiles,
} = require("./skills");
const { augmentProcessEnv } = require("./skillRuntime");
const { maybeConfirm } = require("./confirm");

const execAsync = promisify(exec);

function isDenied(cfg, command) {
  const lower = command.toLowerCase();
  for (const pat of getCommandDenyList(cfg)) {
    if (pat && lower.includes(pat.toLowerCase())) return pat;
  }
  return null;
}

// maybeConfirm imported from ./confirm (shared with documents.js, no circular dep)

function isSafeTerminalCommand(command) {
  return /^(git |npm |pnpm |yarn |node |python |py |pip |tsc |dir |ls |cat |type |echo |pwd|cd |\.\/|npx |head |tail |wc |which |where |rg |grep |findstr |mkdir |md |touch |code |curl |wget |tvly |firecrawl )/i.test(
    String(command || "").trim()
  );
}

async function executeTool(ctx, name, argsRaw) {
  let args = {};
  try {
    args = argsRaw ? JSON.parse(argsRaw) : {};
  } catch {
    return { ok: false, content: `Invalid JSON arguments: ${argsRaw}` };
  }

  const root = ctx.workspaceRoot;
  try {
    switch (name) {
      case "read_file":
        return await readFile(root, args);
      case "write_file":
        return await writeFile(ctx, root, args);
      case "edit_file":
        return await editFile(ctx, root, args);
      case "apply_diff":
        return await applyDiff(ctx, root, args);
      case "list_dir":
        return await listDir(root, args);
      case "search_text":
        return await searchText(root, args);
      case "run_terminal":
        return await runTerminal(ctx, root, args);
      case "get_open_editors":
        return getOpenEditors(ctx);
      case "get_git_diff":
        return await getGitDiff(root, args);
      case "create_document":
        return await createDocument(ctx, root, args);
      case "list_skills":
        return await toolListSkills(ctx, args);
      case "load_skill":
        return await toolLoadSkill(ctx, args);
      default:
        return { ok: false, content: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, content: err.message || String(err) };
  }
}

async function ensureSkillCatalog(ctx) {
  if (ctx.skillCatalog) return ctx.skillCatalog;
  const catalog = await loadSkillCatalog(ctx.cfg || {}, ctx.workspaceRoot || "");
  ctx.skillCatalog = catalog;
  return catalog;
}

async function toolListSkills(ctx, args) {
  const catalog = await ensureSkillCatalog(ctx);
  if (catalog.enabled === false) {
    return {
      ok: true,
      content:
        "Skills are disabled (settings: skillsEnabled=false). Enable them to use zcode/agents skill packages.",
    };
  }
  let list = catalog.skills || [];
  if (!args.includeDisabled) {
    list = list.filter((s) => !s.disabled);
  }
  const q = String(args.query || "")
    .trim()
    .toLowerCase();
  if (q) {
    list = list.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.id.includes(q) ||
        (s.description || "").toLowerCase().includes(q)
    );
  }
  if (!list.length) {
    return {
      ok: true,
      content: [
        q ? `No skills match query: ${args.query}` : "No skills found.",
        "Checked roots:",
        ...(catalog.roots || []).map((r) => `- ${r}`),
        "Install packages under ~/.zcode/skills/<name>/SKILL.md or ~/.agents/skills/",
      ].join("\n"),
    };
  }
  const lines = list.map((s) => {
    const flag = s.disabled ? " [disabled]" : "";
    const desc = (s.description || "").replace(/\s+/g, " ").slice(0, 180);
    return `- ${s.name}${flag} (${s.source}) — ${desc || "no description"}`;
  });
  return {
    ok: true,
    content: [
      `Skills: ${list.length}${q ? ` · filter=${q}` : ""}`,
      ...lines,
      "",
      "Use load_skill({ name }) to open SKILL.md and follow it.",
    ].join("\n"),
  };
}

async function toolLoadSkill(ctx, args) {
  const name = String(args.name || "").trim();
  if (!name) return { ok: false, content: "name is required" };
  const catalog = await ensureSkillCatalog(ctx);
  if (catalog.enabled === false) {
    return {
      ok: false,
      content: "Skills are disabled in settings (skillsEnabled=false).",
    };
  }
  if (args.listFiles) {
    return listSkillFiles(catalog, name, 50);
  }
  return loadSkillContent(catalog, name, args.file || "");
}

async function readFile(root, args) {
  const res = resolveSafePath(root, args.path);
  if (!res.ok) return { ok: false, content: res.error };
  const content = await fs.readFile(res.absolute, "utf8");
  if (content.includes("\u0000")) {
    return { ok: false, content: "Binary file, cannot read as text" };
  }
  const lines = content.split(/\r?\n/);
  let start = 1;
  let end = lines.length;
  if (typeof args.startLine === "number") start = Math.max(1, args.startLine);
  if (typeof args.endLine === "number") end = Math.min(lines.length, args.endLine);
  // hard cap to avoid dumping huge files into context
  if (end - start > 800) end = start + 800;
  const slice = lines.slice(start - 1, end);
  const numbered = slice
    .map((line, i) => `${String(start + i).padStart(5, " ")}|${line}`)
    .join("\n");
  return {
    ok: true,
    content: `File: ${res.absolute}\nLines ${start}-${end} of ${lines.length}\n\n${numbered}`,
  };
}

async function writeFile(ctx, root, args) {
  const res = resolveSafePath(root, args.path);
  if (!res.ok) return { ok: false, content: res.error };
  // 写文件：autoRunTools / autoApproveSafe 均可自动放行
  if (!(await maybeConfirm(ctx, `写入文件？\n${res.absolute}`, true))) {
    return { ok: false, content: "User denied write_file", needConfirm: true };
  }
  await fs.mkdir(path.dirname(res.absolute), { recursive: true });
  await fs.writeFile(res.absolute, args.content ?? "", "utf8");
  ctx.onFsChange?.(res.absolute, "write");
  return {
    ok: true,
    content: `Wrote ${res.absolute} (${String(args.content || "").length} chars)`,
  };
}

async function editFile(ctx, root, args) {
  const res = resolveSafePath(root, args.path);
  if (!res.ok) return { ok: false, content: res.error };
  const content = await fs.readFile(res.absolute, "utf8");
  const oldStr = args.old_string ?? "";
  const newStr = args.new_string ?? "";
  if (!oldStr) return { ok: false, content: "old_string is empty" };
  const count = content.split(oldStr).length - 1;
  if (count === 0) return { ok: false, content: "old_string not found" };
  if (count > 1) {
    return { ok: false, content: `old_string matched ${count} times; make it unique` };
  }
  // 编辑文件：autoRunTools / autoApproveSafe 均可自动放行
  if (!(await maybeConfirm(ctx, `编辑文件？\n${res.absolute}`, true))) {
    return { ok: false, content: "User denied edit_file", needConfirm: true };
  }
  await fs.writeFile(res.absolute, content.replace(oldStr, newStr), "utf8");
  ctx.onFsChange?.(res.absolute, "edit");
  return { ok: true, content: `Edited ${res.absolute}` };
}

/** Parse <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks into hunks. */
function parseSearchReplaceDiff(diffText) {
  const text = String(diffText || "");
  const hunks = [];
  const re =
    /<<<<<<<\s*SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>>\s*REPLACE/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    hunks.push({ old_string: m[1], new_string: m[2] });
  }
  return hunks;
}

async function applyDiff(ctx, root, args) {
  const res = resolveSafePath(root, args.path);
  if (!res.ok) return { ok: false, content: res.error };

  let hunks = Array.isArray(args.hunks) ? args.hunks : [];
  if (!hunks.length && args.diff) {
    hunks = parseSearchReplaceDiff(args.diff);
  }
  if (!hunks.length) {
    return {
      ok: false,
      content:
        "apply_diff needs hunks[{old_string,new_string}] or diff with <<<<<<< SEARCH / ======= / >>>>>>> REPLACE",
    };
  }
  if (hunks.length > 40) {
    return { ok: false, content: "Too many hunks (max 40 per apply_diff)" };
  }

  let content = await fs.readFile(res.absolute, "utf8");
  if (content.includes("\u0000")) {
    return { ok: false, content: "Binary file, cannot apply_diff" };
  }

  // Pass 1: validate all hunks before asking for confirmation or mutating anything
  for (let i = 0; i < hunks.length; i++) {
    const oldStr = String(hunks[i]?.old_string ?? "");
    if (!oldStr) {
      return { ok: false, content: `hunk ${i + 1}: old_string is empty` };
    }
    const count = content.split(oldStr).length - 1;
    if (count === 0) {
      return {
        ok: false,
        content: `hunk ${i + 1}: old_string not found (file unchanged). Make context unique or re-read the file.`,
      };
    }
    if (count > 1) {
      return {
        ok: false,
        content: `hunk ${i + 1}: old_string matched ${count} times; make it unique`,
      };
    }
  }

  // Confirm before doing any work (consistent with write_file / edit_file)
  if (!(await maybeConfirm(ctx, `应用 diff（${hunks.length} 处）？\n${res.absolute}`, true))) {
    return { ok: false, content: "User denied apply_diff", needConfirm: true };
  }

  // Pass 2: apply all replacements only after confirmation
  for (const h of hunks) {
    content = content.replace(String(h.old_string), String(h.new_string ?? ""));
  }

  await fs.writeFile(res.absolute, content, "utf8");
  ctx.onFsChange?.(res.absolute, "edit");
  return {
    ok: true,
    content: `Applied ${hunks.length} hunk(s) to ${res.absolute}`,
  };
}

async function listDir(root, args) {
  const res = resolveSafePath(root, args.path || ".");
  if (!res.ok) return { ok: false, content: res.error };
  const max = typeof args.maxEntries === "number" ? args.maxEntries : 200;
  const entries = await fs.readdir(res.absolute, { withFileTypes: true });
  const lines = entries.slice(0, max).map((e) => {
    return `${e.isDirectory() ? "dir " : "file"} ${e.name}`;
  });
  if (entries.length > max) lines.push(`... and ${entries.length - max} more`);
  return { ok: true, content: `Directory: ${res.absolute}\n${lines.join("\n")}` };
}

async function searchText(root, args) {
  const out = await searchWorkspace(root, args);
  if (!out.ok) return { ok: false, content: out.error };
  if (!out.results.length) {
    return {
      ok: true,
      content: `No matches for "${out.query}" under ${out.root}`,
    };
  }
  const text = out.results
    .map((r) => `${r.relative}:${r.line}: ${r.text}`)
    .join("\n");
  return {
    ok: true,
    content: `Found ${out.results.length} match(es) for "${out.query}":\n${text}`,
  };
}

async function runTerminal(ctx, root, args) {
  const command = String(args.command || "").trim();
  if (!command) return { ok: false, content: "command is empty" };
  if (!root) return { ok: false, content: "未打开工作区，拒绝执行命令" };

  const denied = isDenied(ctx.cfg, command);
  if (denied) {
    return {
      ok: false,
      content: `Blocked by deny list (matched "${denied}"): ${command}`,
    };
  }

  const mode = ctx.cfg.terminalRunMode || "askEveryTime";
  const looksSafe = isSafeTerminalCommand(command);
  // autoAll / autoRunTools: all; autoSafe / autoApproveSafe: safe only
  const autoAll = !!(ctx.cfg?.autoRunTools || mode === "autoAll");
  const autoSafe =
    !autoAll && !!(mode === "autoSafe" || ctx.cfg?.autoApproveSafe);
  const shouldAsk = !autoAll && !(autoSafe && looksSafe);

  if (shouldAsk) {
    // 不安全命令不走 maybeConfirm（autoApproveSafe 不适用），直接问用户
    // 只有 autoRunTools / mode=autoAll 能跳过
    if (
      typeof ctx.confirm === "function" &&
      !(await ctx.confirm(`⚠ 运行命令？\n${command}\n工作目录: ${root}`))
    ) {
      return { ok: false, content: "User denied run_terminal", needConfirm: true };
    }
  }

  let cwd = root;
  if (args.cwd) {
    const cwdRes = resolveSafePath(root, args.cwd);
    if (!cwdRes.ok) return { ok: false, content: cwdRes.error };
    cwd = cwdRes.absolute;
  }

  // Mirror into interactive PTY if bridge present
  try {
    ctx.ptyBridge?.mirrorCommand?.(command, cwd);
  } catch {
    /* ignore */
  }

  // Prefer executing by typing into PTY when requested (no capture)
  if (args.inPty === true && ctx.ptyBridge?.runInPty) {
    const r = ctx.ptyBridge.runInPty(command);
    if (r.ok) {
      return {
        ok: true,
        content:
          "Command sent to interactive PTY terminal (output not captured). Check bottom Terminal panel.",
      };
    }
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
      env: augmentProcessEnv(process.env),
    });
    const out = [
      stdout ? `stdout:\n${stdout}` : "",
      stderr ? `stderr:\n${stderr}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      if (stdout) ctx.ptyBridge?.mirrorOutput?.(stdout);
      if (stderr) ctx.ptyBridge?.mirrorOutput?.(stderr);
    } catch {
      /* ignore */
    }
    return { ok: true, content: out || "(no output)" };
  } catch (err) {
    const content = `Command failed: ${err.message || err}\n${err.stdout || ""}\n${err.stderr || ""}`;
    try {
      ctx.ptyBridge?.mirrorOutput?.(content);
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      content,
    };
  }
}

function getOpenEditors(ctx) {
  const tabs = ctx.openTabs || [];
  const active = ctx.activeFile || "";
  const selection = ctx.activeSelection || "";
  return {
    ok: true,
    content: [
      "Open tabs:",
      ...(tabs.length ? tabs.map((t) => `- ${t}`) : ["- (none)"]),
      "",
      active ? `Active: ${active}` : "Active: (none)",
      selection ? `Selection:\n${String(selection).slice(0, 4000)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

async function getGitDiff(root, args) {
  if (!root) return { ok: false, content: "No workspace" };
  try {
    const status = await execAsync("git status --short", {
      cwd: root,
      timeout: 15_000,
      windowsHide: true,
    });
    const diffCmd = args.staged === true ? "git diff --cached" : "git diff HEAD";
    const diff = await execAsync(diffCmd, {
      cwd: root,
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      ok: true,
      content: [
        "git status --short:",
        status.stdout || "(clean)",
        "",
        `${diffCmd}:`,
        (diff.stdout || "").slice(0, 30_000) || "(no diff)",
      ].join("\n"),
    };
  } catch (err) {
    return { ok: false, content: `git failed: ${err.message || err}` };
  }
}

module.exports = {
  executeTool,
  maybeConfirm,
  // test-only helpers (pure parse / not wired as IPC)
  parseSearchReplaceDiff,
  isSafeTerminalCommand,
};
