/**
 * Wrap `npx skills add` for the skills sidebar install wizard.
 * Safety: only allow owner/repo (+ optional #ref), no shell metacharacters.
 */
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const logger = require("../core/logger");

/** @type {import('child_process').ChildProcess | null} */
let activeChild = null;

const PRESETS = [
  {
    id: "firecrawl-cli",
    label: "Firecrawl CLI 技能",
    repo: "firecrawl/cli",
    hint: "抓取 / 搜索网页相关",
  },
  {
    id: "firecrawl-skills",
    label: "Firecrawl 构建技能",
    repo: "firecrawl/skills",
    hint: "用 Firecrawl 做产品",
  },
  {
    id: "matt-grill-me",
    label: "grill-me（Matt）",
    repo: "mattpocock/skills",
    skill: "grill-me",
    hint: "需求澄清访谈",
  },
];

/**
 * @param {string} raw
 * @returns {{ ok: true, owner: string, name: string, ref?: string, display: string } | { ok: false, error: string }}
 */
function parseSkillsRepo(raw) {
  let s = String(raw || "").trim();
  if (!s) return { ok: false, error: "请填写 owner/repo" };
  // strip common prefixes
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  s = s.replace(/^git@github\.com:/i, "");
  s = s.replace(/\.git$/i, "");
  s = s.replace(/^github\.com\//i, "");
  s = s.replace(/\/+$/, "");

  let ref;
  const hash = s.indexOf("#");
  if (hash >= 0) {
    ref = s.slice(hash + 1).trim();
    s = s.slice(0, hash).trim();
    if (ref && !/^[A-Za-z0-9._/-]+$/.test(ref)) {
      return { ok: false, error: "分支/标签含非法字符" };
    }
  }

  // owner/repo only
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) {
    return {
      ok: false,
      error: "格式应为 owner/repo（可附 #branch）",
    };
  }
  const [owner, name] = s.split("/");
  return {
    ok: true,
    owner,
    name,
    ref: ref || undefined,
    display: ref ? `${owner}/${name}#${ref}` : `${owner}/${name}`,
  };
}

/**
 * @param {string} raw
 * @returns {{ ok: true, name: string } | { ok: false, error: string } | { ok: true, name: "" }}
 */
function parseSkillName(raw) {
  const s = String(raw || "").trim();
  if (!s) return { ok: true, name: "" };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(s)) {
    return { ok: false, error: "技能名仅允许字母数字 . _ -" };
  }
  return { ok: true, name: s };
}

function isInstallRunning() {
  return !!(activeChild && !activeChild.killed);
}

/**
 * @param {{
 *   repo: string,
 *   skill?: string,
 *   global?: boolean,
 *   onLog?: (line: string) => void,
 * }} opts
 * @returns {Promise<{ ok: boolean, code: number|null, error?: string, stdout: string, stderr: string, cmd: string }>}
 */
function runSkillsAdd(opts) {
  const parsed = parseSkillsRepo(opts.repo);
  if (!parsed.ok) {
    return Promise.resolve({
      ok: false,
      code: null,
      error: parsed.error,
      stdout: "",
      stderr: "",
      cmd: "",
    });
  }
  const skillP = parseSkillName(opts.skill || "");
  if (!skillP.ok) {
    return Promise.resolve({
      ok: false,
      code: null,
      error: skillP.error,
      stdout: "",
      stderr: "",
      cmd: "",
    });
  }
  if (isInstallRunning()) {
    return Promise.resolve({
      ok: false,
      code: null,
      error: "已有安装任务在进行，请稍候",
      stdout: "",
      stderr: "",
      cmd: "",
    });
  }

  const repoArg = parsed.display;
  // First "-y" is `npx --yes` (skip npx install prompt).
  // "skills add" flags follow; no second -y needed since env CI=1 / npm_config_yes=true handles it.
  const args = ["-y", "skills", "add", repoArg];
  if (opts.global !== false) args.push("-g");
  if (skillP.name) {
    args.push("--skill", skillP.name);
  }

  const cmdPreview = `npx ${args.join(" ")}`;
  const onLog = typeof opts.onLog === "function" ? opts.onLog : () => {};
  logger.info("skill install 开始", { repo: repoArg, skill: skillP.name || "", global: opts.global !== false });

  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    // shell:false — args are already validated; on Windows use npx.cmd via shell only if needed
    const bin = isWin ? "npx.cmd" : "npx";
    let child;
    try {
      child = spawn(bin, args, {
        cwd: os.homedir(),
        env: {
          ...process.env,
          // avoid interactive prompts
          CI: "1",
          npm_config_yes: "true",
        },
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      resolve({
        ok: false,
        code: null,
        error: e.message || String(e),
        stdout: "",
        stderr: "",
        cmd: cmdPreview,
      });
      return;
    }

    activeChild = child;
    let stdout = "";
    let stderr = "";
    const push = (chunk, isErr) => {
      const text = chunk.toString("utf8");
      if (isErr) stderr += text;
      else stdout += text;
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (line.trim()) onLog(line);
      }
    };
    child.stdout?.on("data", (d) => push(d, false));
    child.stderr?.on("data", (d) => push(d, true));

    child.on("error", (err) => {
      if (activeChild === child) activeChild = null;
      const msg = err.message || String(err);
      onLog(`[error] ${msg}`);
      resolve({
        ok: false,
        code: null,
        error: /ENOENT/i.test(msg)
          ? "未找到 npx，请先安装 Node.js 并确保 PATH 可用"
          : msg,
        stdout,
        stderr,
        cmd: cmdPreview,
      });
    });

    child.on("close", (code) => {
      if (activeChild === child) activeChild = null;
      const ok = code === 0;
      if (!ok) {
        onLog(`[exit ${code}]`);
      }
      try {
        require("./skills").invalidateSkillCache();
      } catch {
        /* ignore */
      }
      logger[ok ? "info" : "warn"](`skill install ${ok ? "成功" : "失败"}`, { repo: repoArg, exitCode: code });
      resolve({
        ok,
        code,
        error: ok ? undefined : `安装失败（退出码 ${code}）`,
        stdout: stdout.slice(-8000),
        stderr: stderr.slice(-8000),
        cmd: cmdPreview,
      });
    });
  });
}

function cancelSkillsInstall() {
  if (!activeChild) return { ok: false, error: "没有进行中的安装" };
  try {
    activeChild.kill();
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  return { ok: true };
}

module.exports = {
  PRESETS,
  parseSkillsRepo,
  parseSkillName,
  isInstallRunning,
  runSkillsAdd,
  cancelSkillsInstall,
  // for tests / docs
  agentsSkillsDir: () => path.join(os.homedir(), ".agents", "skills"),
  zcodeSkillsDir: () => path.join(os.homedir(), ".zcode", "skills"),
};