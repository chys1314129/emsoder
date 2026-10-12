const { execFile } = require("child_process");
const { promisify } = require("util");
const path = require("path");

const execFileAsync = promisify(execFile);

async function git(root, args, options = {}) {
  if (!root) throw new Error("未打开工作区");
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: root,
      timeout: options.timeout || 30_000,
      maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, stdout: stdout || "", stderr: stderr || "" };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      error: err.message || String(err),
      code: err.code,
    };
  }
}

async function isGitRepo(root) {
  const r = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.stdout.trim() === "true";
}

/**
 * Parse `git status --porcelain=v1 -uall`
 */
function parseStatus(porcelain) {
  const lines = String(porcelain || "")
    .split(/\r?\n/)
    .filter(Boolean);
  const files = [];
  for (const line of lines) {
    // XY PATH or XY ORIG -> PATH for renames
    const xy = line.slice(0, 2);
    let rest = line.slice(3);
    let pathOld = null;
    let filePath = rest;
    if (rest.includes(" -> ")) {
      const parts = rest.split(" -> ");
      pathOld = parts[0];
      filePath = parts[1];
    }
    // untracked: "?? path"
    files.push({
      x: xy[0] || " ",
      y: xy[1] || " ",
      path: filePath,
      pathOld,
      staged: xy[0] !== " " && xy[0] !== "?",
      unstaged: xy[1] !== " " || xy[0] === "?",
      untracked: xy === "??",
      status: xy.trim() || "??",
    });
  }
  return files;
}

async function getStatus(root) {
  if (!(await isGitRepo(root))) {
    return { ok: false, isRepo: false, files: [], branch: "", error: "不是 Git 仓库" };
  }
  const branchR = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const statusR = await git(root, ["status", "--porcelain=v1", "-uall"]);
  if (!statusR.ok) {
    return {
      ok: false,
      isRepo: true,
      files: [],
      branch: branchR.stdout.trim(),
      error: statusR.error || statusR.stderr,
    };
  }
  return {
    ok: true,
    isRepo: true,
    branch: (branchR.stdout || "").trim() || "HEAD",
    files: parseStatus(statusR.stdout),
  };
}

async function getDiff(root, { path: filePath, staged } = {}) {
  const args = ["diff", "--no-color"];
  if (staged) args.push("--cached");
  if (filePath) args.push("--", filePath);
  const r = await git(root, args, { maxBuffer: 6 * 1024 * 1024 });
  if (!r.ok && !r.stdout) {
    return { ok: false, diff: "", error: r.error || r.stderr };
  }
  return { ok: true, diff: r.stdout || "(no diff)" };
}

async function stage(root, filePath) {
  const r = await git(root, ["add", "--", filePath || "."]);
  return r.ok
    ? { ok: true }
    : { ok: false, error: r.error || r.stderr };
}

async function unstage(root, filePath) {
  const r = await git(root, ["restore", "--staged", "--", filePath || "."]);
  if (!r.ok) {
    // older git
    const r2 = await git(root, ["reset", "HEAD", "--", filePath || "."]);
    return r2.ok ? { ok: true } : { ok: false, error: r2.error || r2.stderr };
  }
  return { ok: true };
}

async function discard(root, filePath) {
  if (!filePath) return { ok: false, error: "需要文件路径" };
  const r = await git(root, ["restore", "--", filePath]);
  if (!r.ok) {
    const r2 = await git(root, ["checkout", "--", filePath]);
    return r2.ok ? { ok: true } : { ok: false, error: r2.error || r2.stderr };
  }
  return { ok: true };
}

async function commit(root, message) {
  const msg = String(message || "").trim();
  if (!msg) return { ok: false, error: "提交信息为空" };
  const r = await git(root, ["commit", "-m", msg]);
  if (!r.ok) return { ok: false, error: r.error || r.stderr || r.stdout };
  return { ok: true, output: r.stdout };
}

async function getLog(root, limit = 20) {
  // 限制为数字，防止渲染层传入任意字符串注入 git 参数
  const n = Math.max(1, Math.min(1000, Number(limit) || 20));
  const r = await git(root, [
    "log",
    `-n${n}`,
    "--pretty=format:%h|%an|%ar|%s",
  ]);
  if (!r.ok) return { ok: false, commits: [], error: r.error || r.stderr };
  const commits = String(r.stdout || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, author, when, ...rest] = line.split("|");
      return { hash, author, when, subject: rest.join("|") };
    });
  return { ok: true, commits };
}

module.exports = {
  git,
  isGitRepo,
  getStatus,
  getDiff,
  stage,
  unstage,
  discard,
  commit,
  getLog,
  parseStatus,
};
