const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { getCommandDenyList } = require("../core/config");
const logger = require("../core/logger");
const { resolveSafePath } = require("./paths");
const { searchWorkspace } = require("./search");
const { readDocument } = require("./documentReader");
const { toolSearchImages, downloadImage } = require("./imageSearch");
const { webFetch, webSearch } = require("./web");
const { AGENT_TOOLS } = require("./definitions");
const { streamChat } = require("../providers");
const {
  loadSkillCatalog,
  loadSkillContent,
  listSkillFiles,
} = require("./skills");
const {
  augmentProcessEnv,
  executionEnv,
  imageGenerationEnv,
  resolveSkillRuntimeRoot,
} = require("./skillRuntime");
const {
  maybeConfirm,
  normalizePermissionMode,
  terminalAutoPolicy,
} = require("./confirm");

/**
 * Extra roots that read/list/terminal may touch beyond the workspace:
 * installed skill dirs + the bundled skill runtime. This lets skills like
 * ppt-master (which live on C: while the workspace is on D:) read their own
 * scripts and run them, without opening arbitrary filesystem access.
 */
function skillAllowedRoots(ctx) {
  const roots = [];
  const cat = ctx?.skillCatalog;
  if (Array.isArray(cat?.roots)) roots.push(...cat.roots);
  // also each individual skill dir (covers plugin caches not in roots)
  if (Array.isArray(cat?.skills)) {
    for (const s of cat.skills) if (s?.dir) roots.push(s.dir);
  }
  try {
    const rt = resolveSkillRuntimeRoot();
    if (rt) roots.push(rt);
  } catch {
    /* ignore */
  }
  return roots.filter(Boolean);
}

/**
 * 在进程组中执行命令并等待完成，超时后整树终止。
 * exec 超时只杀 shell 本身，Windows 下 cmd.exe 派生的孙进程
 * （npm run dev / node server / python）会残留后台运行——这里用
 * detached 进程组 + taskkill /t（Windows）/ kill(-pid)（POSIX）整树清理。
 * @param {AbortSignal} [opts.signal] 外部中止信号（agent stop 时整树终止）
 * @returns {Promise<{code:number, stdout:string, stderr:string, timedOut:boolean, aborted:boolean}>}
 */
function execTree(command, { cwd, timeout, maxBuffer, shell, env, signal } = {}) {
  const shellBin =
    shell || (process.platform === "win32" ? "cmd.exe" : "/bin/bash");
  const shellArgs =
    process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
  const child = spawn(shellBin, shellArgs, {
    cwd,
    env,
    windowsHide: true,
    detached: process.platform !== "win32", // POSIX 用进程组；Windows 用 taskkill /t
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(1, Number(timeout) || 60_000));

    // 外部中止（agent stop）：整树终止并标记 aborted
    const onAbort = () => {
      if (settled) return;
      aborted = true;
      killTree(child);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const cap = Math.max(64 * 1024, Number(maxBuffer) || 2 * 1024 * 1024);
    const append = (buf, target) => {
      const next = target + buf;
      return next.length > cap ? next.slice(-cap) : next;
    };
    child.stdout.on("data", (d) => {
      stdout = append(String(d), stdout);
    });
    child.stderr.on("data", (d) => {
      stderr = append(String(d), stderr);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ code: -1, stdout, stderr, timedOut, aborted, error: err.message });
    });
    child.on("close", (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted, signal: sig });
    });
  });
}

/** 终止整个进程树（Windows: taskkill /t /f；POSIX: 进程组负 pid） */
function killTree(child) {
  try {
    if (!child || child.pid == null) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], {
        windowsHide: true,
        stdio: "ignore",
      }).on("error", () => {
        /* taskkill 失败静默，子进程退出时由 close 兜底 */
      });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  } catch {
    /* ignore */
  }
}

function isDenied(cfg, command) {
  const lower = command.toLowerCase();
  for (const pat of getCommandDenyList(cfg)) {
    if (pat && lower.includes(pat.toLowerCase())) return pat;
  }
  return null;
}

// maybeConfirm imported from ./confirm (shared permission gate)

function isSafeTerminalCommand(command) {
  const cmd = String(command || "").trim();
  // 含管道/连接符/重定向/子 shell 的命令绝不自动放行：
  // `curl x | bash`、`git status && evil`、`echo x > file` 都以安全前缀开头但可执行任意代码
  if (/[|&;`$()<>]/.test(cmd)) return false;
  // 白名单只保留「纯只读 / 无代码执行能力」的命令。
  // 刻意排除 node / python / py / pip / npm / pnpm / yarn / npx / curl / wget /
  // code / firecrawl / tvly 以及 `./xxx`：这些都能直接下载并执行任意代码，
  // 若被归为「安全」会在「高危才询问」档位下被静默自动执行。
  return /^(git |tsc |dir |ls |cat |type |echo |pwd|cd |head |tail |wc |which |where |rg |grep |findstr |mkdir |md |touch )/i.test(
    cmd
  );
}

// 旧后端子代理只读工具：不写文件、不跑终端、不再派子代理（防递归）
const SUBAGENT_READONLY_BLACKLIST = new Set([
  "write_file", "edit_file", "apply_diff", "run_terminal", "download_image", "spawn_subagent",
]);
const SUBAGENT_TOOLS = AGENT_TOOLS.filter(
  (t) => !SUBAGENT_READONLY_BLACKLIST.has(t.function.name)
);

/** 旧 EMSoder 后端：spawn_subagent 的只读研究子代理（并行，每个任务独立上下文）。 */
async function legacySpawnSubagents(ctx, args) {
  const tasks = Array.isArray(args.tasks)
    ? args.tasks.slice(0, 6)
    : [{ task: String(args.task || "").trim() }];
  if (!tasks.length || !tasks.every((t) => t && String(t.task || "").trim())) {
    return { ok: false, content: "spawn_subagent 需要 task（或 tasks 数组，最多 6 个并行任务）" };
  }
  const maxRounds = Math.min(24, Math.max(1, Number(args.maxRounds) || 8));
  const sharedPrompt = String(args.systemPrompt || "");
  const runOne = async (t) => {
    const taskText = String(t.task || "");
    const messages = [
      {
        role: "system",
        content: [
          "你是主 Agent 派出的只读研究子代理。独立完成分配的子任务，可读文件/目录、搜索、联网、读技能，但不能修改文件或运行终端。",
          "完成任务后输出简洁结论。",
          t.systemPrompt || sharedPrompt || "",
        ].filter(Boolean).join("\n"),
      },
      { role: "user", content: taskText },
    ];
    let finalText = "";
    for (let round = 0; round < maxRounds; round++) {
      if (ctx.signal?.aborted) return { ok: false, content: "已停止" };
      let text = "";
      const calls = [];
      for await (const chunk of streamChat(ctx.cfg, {
        messages, tools: SUBAGENT_TOOLS, signal: ctx.signal,
      })) {
        if (chunk.type === "text") text += chunk.text || "";
        else if (chunk.type === "tool_call" && chunk.toolCall) calls.push(chunk.toolCall);
        else if (chunk.type === "error") {
          return { ok: false, content: String(chunk.error || "子代理请求失败") };
        }
      }
      messages.push({
        role: "assistant",
        content: text,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      if (!calls.length) { finalText = text; break; }
      for (const c of calls) {
        const name = c.function?.name || "";
        const raw = c.function?.arguments || "{}";
        let r;
        try { r = await executeTool(ctx, name, raw); }
        catch (e) { r = { ok: false, content: String(e?.message || e) }; }
        messages.push({
          role: "tool",
          content: String(r?.content || "").slice(0, 8000),
          name,
          tool_call_id: c.id,
        });
      }
      finalText = text;
    }
    return { ok: true, content: finalText || "(子代理未产出文本)" };
  };
  const results = await Promise.all(tasks.map(runOne));
  return {
    ok: results.every((r) => r.ok),
    content: [
      `子代理结果（${results.length} 个）：`,
      ...results.map((r, i) => `${i + 1}. ${r.ok ? "完成" : "失败"}: ${String(r.content).slice(0, 3000)}`),
    ].join("\n"),
  };
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
        return await readFile(root, args, ctx);
      case "write_file":
        return await writeFile(ctx, root, args);
      case "edit_file":
        return await editFile(ctx, root, args);
      case "apply_diff":
        return await applyDiff(ctx, root, args);
      case "list_dir":
        return await listDir(root, args, ctx);
      case "search_text":
        return await searchText(root, args);
      case "run_terminal":
        return await runTerminal(ctx, root, args);
      case "get_open_editors":
        return getOpenEditors(ctx);
      case "get_git_diff":
        return await getGitDiff(root, args);
      case "read_document":
        return await readDocument(ctx, root, args);
      case "search_images":
        return await toolSearchImages(ctx, args);
      case "download_image":
        return await downloadImage(ctx, root, args);
      case "web_search":
        return await webSearch(args.query, args);
      case "web_fetch":
        return await webFetch(args.url, args);
      case "spawn_subagent":
        // 旧 EMSoder 后端：只读子代理循环（不写文件、不跑终端），Pi 后端在 adapter 层实现完整子代理
        return await legacySpawnSubagents(ctx, args);
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

/** 读前检查文件大小上限，防止大文件整读进内存导致主进程 OOM */
const MAX_TOOL_READ_BYTES = 10 * 1024 * 1024; // 10MB

async function statOrNull(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

function tooLargeError(stat, label) {
  return {
    ok: false,
    content: `${label} too large (${stat.size} bytes > 10MB). Use startLine/endLine or grep range reading instead.`,
  };
}

async function readFile(root, args, ctx) {
  const res = resolveSafePath(root, args.path, { allowedRoots: skillAllowedRoots(ctx) });
  if (!res.ok) return { ok: false, content: res.error };
  // 读前检查大小：防止大文件（日志、二进制伪装）整读进内存导致主进程 OOM
  const stat = await statOrNull(res.absolute);
  if (!stat) return { ok: false, content: `File not found: ${res.absolute}` };
  if (stat.size > MAX_TOOL_READ_BYTES) return tooLargeError(stat, "File");
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
  if (normalizePermissionMode(ctx.cfg) === "plan") {
    return {
      ok: false,
      content:
        "当前为「计划模式」：不能直接写文件。请先给出修改计划，等用户切到「自动编辑/高危才询问/完全授权」或确认后再改。",
      needConfirm: true,
    };
  }
  if (!(await maybeConfirm(ctx, `写入文件？\n${res.absolute}`))) {
    return { ok: false, content: "User denied write_file", needConfirm: true };
  }
  await fs.mkdir(path.dirname(res.absolute), { recursive: true });
  await fs.writeFile(res.absolute, args.content ?? "", "utf8");
  logger.info("write_file", { path: res.absolute });
  ctx.onFsChange?.(res.absolute, "write");
  return {
    ok: true,
    content: `Wrote ${res.absolute} (${String(args.content || "").length} chars)`,
  };
}

async function editFile(ctx, root, args) {
  const res = resolveSafePath(root, args.path);
  if (!res.ok) return { ok: false, content: res.error };
  const stat = await statOrNull(res.absolute);
  if (!stat) return { ok: false, content: `File not found: ${res.absolute}` };
  if (stat.size > MAX_TOOL_READ_BYTES) return tooLargeError(stat, "File");
  const content = await fs.readFile(res.absolute, "utf8");
  const oldStr = args.old_string ?? "";
  const newStr = args.new_string ?? "";
  if (!oldStr) return { ok: false, content: "old_string is empty" };
  const count = content.split(oldStr).length - 1;
  if (count === 0) return { ok: false, content: "old_string not found" };
  if (count > 1) {
    return { ok: false, content: `old_string matched ${count} times; make it unique` };
  }
  if (normalizePermissionMode(ctx.cfg) === "plan") {
    return {
      ok: false,
      content:
        "当前为「计划模式」：不能直接编辑文件。请先给出修改计划，等用户切换权限模式后再改。",
      needConfirm: true,
    };
  }
  if (!(await maybeConfirm(ctx, `编辑文件？\n${res.absolute}`))) {
    return { ok: false, content: "User denied edit_file", needConfirm: true };
  }
  await fs.writeFile(res.absolute, content.replace(oldStr, newStr), "utf8");
  logger.info("edit_file", { path: res.absolute });
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

  const stat = await statOrNull(res.absolute);
  if (!stat) return { ok: false, content: `File not found: ${res.absolute}` };
  if (stat.size > MAX_TOOL_READ_BYTES) return tooLargeError(stat, "File");
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

  if (normalizePermissionMode(ctx.cfg) === "plan") {
    return {
      ok: false,
      content:
        "当前为「计划模式」：不能直接 apply_diff。请先给出修改计划，等用户切换权限模式后再改。",
      needConfirm: true,
    };
  }
  // Confirm before doing any work (consistent with write_file / edit_file)
  if (!(await maybeConfirm(ctx, `应用 diff（${hunks.length} 处）？\n${res.absolute}`))) {
    return { ok: false, content: "User denied apply_diff", needConfirm: true };
  }

  // Pass 2: apply all replacements only after confirmation.
  // 每个 hunk 应用前在“当前内容”上重新校验唯一性：
  // 前一个 hunk 的替换可能引入/移除后续 hunk 的 old_string，导致 replace 错位或静默漏改。
  for (let i = 0; i < hunks.length; i++) {
    const oldStr = String(hunks[i]?.old_string ?? "");
    const newStr = String(hunks[i]?.new_string ?? "");
    const count = content.split(oldStr).length - 1;
    if (count === 0) {
      return {
        ok: false,
        content: `hunk ${i + 1}: old_string not found at apply time (file unchanged). Re-read the file and retry.`,
      };
    }
    if (count > 1) {
      return {
        ok: false,
        content: `hunk ${i + 1}: old_string matched ${count} times at apply time; make it unique`,
      };
    }
    content = content.replace(oldStr, newStr);
  }

  await fs.writeFile(res.absolute, content, "utf8");
  logger.info("apply_diff", { path: res.absolute, hunks: hunks.length });
  ctx.onFsChange?.(res.absolute, "edit");
  return {
    ok: true,
    content: `Applied ${hunks.length} hunk(s) to ${res.absolute}`,
  };
}

async function listDir(root, args, ctx) {
  const res = resolveSafePath(root, args.path || ".", { allowedRoots: skillAllowedRoots(ctx) });
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

function pathInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isPptMasterCwd(ctx, cwd) {
  return Array.isArray(ctx?.skillCatalog?.skills) && ctx.skillCatalog.skills.some(
    (skill) => skill?.id === "ppt-master" && skill?.dir && pathInside(skill.dir, cwd)
  );
}

async function runTerminal(ctx, root, args) {
  const command = String(args.command || "").trim();
  if (!command) return { ok: false, content: "command is empty" };
  if (!root) return { ok: false, content: "未打开工作区，拒绝执行命令" };

  const denied = isDenied(ctx.cfg, command);
  if (denied) {
    logger.warn("run_terminal 被拒绝名单拦截", { command, cwd: root, matched: denied });
    return {
      ok: false,
      content: `Blocked by deny list (matched "${denied}"): ${command}`,
    };
  }

  const perm = normalizePermissionMode(ctx.cfg);
  if (perm === "plan") {
    return {
      ok: false,
      content:
        "当前为「计划模式」：不能直接运行终端命令。请在计划中写明将要执行的命令，等用户切换权限后再跑。",
      needConfirm: true,
    };
  }
  const looksSafe = isSafeTerminalCommand(command);
  const policy = terminalAutoPolicy(ctx.cfg, looksSafe);
  if (!policy.auto) {
    if (
      typeof ctx.confirm === "function" &&
      !(await ctx.confirm(`⚠ 运行命令？\n${command}\n工作目录: ${root}`))
    ) {
      logger.warn("run_terminal 被用户拒绝", { command, cwd: root, reason: policy.reason });
      return { ok: false, content: "User denied run_terminal", needConfirm: true };
    }
  }

  let cwd = root;
  if (args.cwd) {
    // Allow cwd inside installed skill dirs / runtime too (skills like ppt-master
    // live on another drive and need to run their own scripts).
    const cwdRes = resolveSafePath(root, args.cwd, { allowedRoots: skillAllowedRoots(ctx) });
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

  // 长任务（ppt-master 出图、pip install、构建）需要远超 60s；
  // 模型可通过 timeoutMs 上调，上限 10 分钟，下限 1s。
  const timeoutMs = Math.max(
    1_000,
    Math.min(600_000, Number(args.timeoutMs) || 60_000)
  );
  // Image credentials are scoped only to ppt-master's spawned command. They
  // never touch process.env, ordinary terminal commands, PTY sessions, events,
  // model context, or logs.
  const imageEnv = isPptMasterCwd(ctx, cwd) ? imageGenerationEnv(ctx.cfg) : null;
  const childEnv = { ...executionEnv(ctx.cfg), ...(imageEnv || {}) };
  logger.info("run_terminal 执行", { command, cwd, permissionMode: perm, policy: policy.reason });
  try {
    const r = await execTree(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
      env: augmentProcessEnv(process.env, childEnv),
      signal: ctx.signal || null,
    });
    const out = [
      r.stdout ? `stdout:\n${r.stdout}` : "",
      r.stderr ? `stderr:\n${r.stderr}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      if (r.stdout) ctx.ptyBridge?.mirrorOutput?.(r.stdout);
      if (r.stderr) ctx.ptyBridge?.mirrorOutput?.(r.stderr);
    } catch {
      /* ignore */
    }
    if (r.aborted) {
      logger.info("run_terminal 中止", { command });
      return {
        ok: false,
        content: `Command aborted by stop: ${command}`,
      };
    }
    if (r.timedOut) {
      logger.warn("run_terminal 超时", { command, timeoutMs });
      return {
        ok: false,
        content: `Command timed out after ${Math.round(timeoutMs / 1000)}s (process tree killed): ${command}\n${out}`.trim(),
      };
    }
    if (r.code !== 0) {
      logger.warn("run_terminal 失败", { command, exitCode: r.code });
      return {
        ok: false,
        content: `Command failed (exit ${r.code}): ${command}\n${out}`.trim(),
      };
    }
    logger.info("run_terminal 完成", { command, exitCode: r.code });
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
    const status = await execTree("git status --short", {
      cwd: root,
      timeout: 15_000,
    });
    if (status.timedOut) {
      return { ok: false, content: "git status timed out (process tree killed)" };
    }
    const diffCmd = args.staged === true ? "git diff --cached" : "git diff HEAD";
    const diff = await execTree(diffCmd, {
      cwd: root,
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (diff.timedOut) {
      return { ok: false, content: "git diff timed out (process tree killed)" };
    }
    if (status.code !== 0 || diff.code !== 0) {
      return {
        ok: false,
        content: `git failed: ${status.stderr || diff.stderr || "exit " + (status.code ?? diff.code)}`,
      };
    }
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
  execTree,
  killTree,
};
