/**
 * EMSoder 集中日志（用于排查问题 / 安全审计）。
 * - 写到 userData/emsoder.log，按 5MB 滚动（保留 2 份备份）。
 * - 写文件前做敏感信息脱敏（API Key / token / password 等），不落明文凭据。
 * - 仅主进程使用；同时保留 console 输出便于开发调试。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_BACKUPS = 2;

function logPath() {
  try {
    const { app } = require("electron");
    const p = app?.getPath?.("userData");
    if (p) return path.join(p, "emsoder.log");
  } catch {
    /* fall through */
  }
  return path.join(os.tmpdir(), "emsoder.log");
}

/**
 * 脱敏：把常见凭据形态替换为 [REDACTED]，避免日志泄露明文密钥。
 */
function redact(input) {
  return String(input ?? "")
    .replace(/\b(sk|sk-[a-z0-9]{0,10}|rk|ak|pk)-[A-Za-z0-9._\-]{8,}\b/gi, "[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]{8,}/gi, "$1[REDACTED]")
    .replace(/(x-api-key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(api[-_]?key\s*[:=]\s*["']?)[^"'\s,;}&]{6,}/gi, "$1[REDACTED]")
    .replace(/(token\s*[:=]\s*["']?)[^"'\s,;}&]{6,}/gi, "$1[REDACTED]")
    .replace(/(secret\s*[:=]\s*["']?)[^"'\s,;}&]{6,}/gi, "$1[REDACTED]")
    .replace(/(passw(or)?d\s*[:=]\s*["']?)[^"'\s,;}&]{4,}/gi, "$1[REDACTED]");
}

function formatArg(a) {
  if (a instanceof Error) return `${a.name || "Error"}: ${a.message || ""}\n${a.stack || ""}`;
  if (typeof a === "object" && a !== null) {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

function write(level, ...args) {
  const line = args.map(formatArg).join(" ");
  const msg = `${new Date().toISOString()} [${level}] ${redact(line)}\n`;
  try {
    const p = logPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, msg, "utf8");
    rotateIfNeeded(p);
  } catch {
    /* 写日志失败不影响主流程 */
  }
  // 保留 console 输出（开发时在终端可见）
  try {
    if (level === "ERROR") console.error(...args);
    else if (level === "WARN") console.warn(...args);
    else console.log(...args);
  } catch {
    /* ignore */
  }
}

function rotateIfNeeded(p) {
  try {
    const st = fs.statSync(p);
    if (st.size <= MAX_LOG_BYTES) return;
    for (let i = MAX_BACKUPS - 1; i >= 0; i--) {
      const src = i === 0 ? p : `${p}.${i}`;
      const dst = `${p}.${i + 1}`;
      try {
        if (fs.existsSync(src)) fs.renameSync(src, dst);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(`${p}.${MAX_BACKUPS + 1}`, { force: true });
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

module.exports = {
  debug: (...a) => write("DEBUG", ...a),
  info: (...a) => write("INFO", ...a),
  warn: (...a) => write("WARN", ...a),
  error: (...a) => write("ERROR", ...a),
  redact,
  logPath,
};
