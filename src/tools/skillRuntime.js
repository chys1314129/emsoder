const fs = require("fs");
const path = require("path");

/**
 * Skill CLI runtime (resources/skill-runtime):
 *   bin/     shims (firecrawl, mmx, node, python, …)
 *   node/    portable Node.js
 *   python/  optional embeddable Python
 * Prepends these to PATH for PTY + run_terminal.
 */

function candidateRoots() {
  const roots = [];
  try {
    if (process.resourcesPath) {
      roots.push(path.join(process.resourcesPath, "skill-runtime"));
    }
  } catch {
    /* ignore */
  }
  roots.push(path.join(__dirname, "..", "..", "resources", "skill-runtime"));
  try {
    const { app } = require("electron");
    const appPath = app?.getAppPath?.();
    if (appPath) {
      roots.push(path.join(appPath, "resources", "skill-runtime"));
    }
  } catch {
    /* not electron */
  }
  return roots;
}

function resolveSkillRuntimeRoot() {
  for (const r of candidateRoots()) {
    const abs = path.resolve(r);
    if (
      fs.existsSync(path.join(abs, "bin")) ||
      fs.existsSync(path.join(abs, "manifest.json")) ||
      fs.existsSync(path.join(abs, "node", "node.exe"))
    ) {
      return abs;
    }
  }
  return null;
}

function readManifest(root) {
  try {
    const p = path.join(root, "manifest.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Build env for child processes / PTY.
 * Does not inject API keys.
 */
const IMAGE_SECRET_ENV_KEYS = [
  "MODELSCOPE_API_KEY", "ZHIPU_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
  "SILICONFLOW_API_KEY", "VOLCENGINE_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY",
  "MINIMAX_API_KEY", "IMAGE_API_KEY",
];
const EXECUTION_ENV_RESERVED = new Set([
  "PATH", "TERM", "COLORTERM", "TERM_PROGRAM", "NODE_OPTIONS", "NODE_PATH", "NODE_ENV",
  "ELECTRON_RUN_AS_NODE", "SYSTEMROOT", "COMSPEC", ...IMAGE_SECRET_ENV_KEYS,
]);
const EXECUTION_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXECUTION_ENV_MAX_ENTRIES = 100;
const EXECUTION_ENV_MAX_KEY = 128;
const EXECUTION_ENV_MAX_VALUE = 8192;

/** Validate config-supplied terminal/skill environment without touching process.env. */
function executionEnv(cfg = {}) {
  const source = cfg?.executionEnv;
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    if (Object.keys(out).length >= EXECUTION_ENV_MAX_ENTRIES) break;
    const key = String(rawKey || "").trim();
    if (!EXECUTION_ENV_NAME.test(key) || key.length > EXECUTION_ENV_MAX_KEY) continue;
    if (EXECUTION_ENV_RESERVED.has(key.toUpperCase())) continue;
    if (typeof rawValue !== "string" || rawValue.length > EXECUTION_ENV_MAX_VALUE) continue;
    out[key] = rawValue;
  }
  return out;
}

function augmentProcessEnv(baseEnv = process.env, extraEnv = null) {
  const env = { ...baseEnv };
  // Never leak image-generation credentials to ordinary commands. The caller
  // must explicitly pass the scoped imageGenerationEnv as extraEnv.
  for (const key of IMAGE_SECRET_ENV_KEYS) delete env[key];
  Object.assign(env, extraEnv || {});
  const root = resolveSkillRuntimeRoot();
  if (!root) return env;

  const sep = process.platform === "win32" ? ";" : ":";
  const parts = [];

  const bin = path.join(root, "bin");
  const nodeDir = path.join(root, "node");
  const pyDir = path.join(root, "python");
  const pyScripts = path.join(pyDir, "Scripts");

  if (fs.existsSync(bin)) parts.push(bin);
  if (fs.existsSync(nodeDir)) parts.push(nodeDir);
  if (fs.existsSync(pyScripts)) parts.push(pyScripts);
  if (fs.existsSync(pyDir)) parts.push(pyDir);

  const prev = env.Path || env.PATH || "";
  // Avoid duplicating if already injected
  const prefix = parts.filter((p) => !prev.toLowerCase().includes(p.toLowerCase()));
  if (prefix.length) {
    const next = prefix.join(sep) + sep + prev;
    env.PATH = next;
    if (process.platform === "win32") env.Path = next;
  }

  env.EMSODER_SKILL_RUNTIME = root;

  // Help bundled/CPython on Windows: force UTF-8 stdio so skill scripts that
  // print CJK (many ppt/pdf skills) don't crash on the default GBK console.
  if (!env.PYTHONUTF8) env.PYTHONUTF8 = "1";
  if (!env.PYTHONIOENCODING) env.PYTHONIOENCODING = "utf-8";

  const bundledNode = path.join(nodeDir, process.platform === "win32" ? "node.exe" : "node");
  if (fs.existsSync(bundledNode)) {
    env.EMSODER_NODE = bundledNode;
  }

  const bundledPy = path.join(pyDir, process.platform === "win32" ? "python.exe" : "python");
  if (fs.existsSync(bundledPy)) {
    env.EMSODER_PYTHON = bundledPy;
  }

  return env;
}

const IMAGE_GEN_BACKENDS = new Set([
  "modelscope", "zhipu", "openai", "openrouter", "siliconflow",
  "volcengine", "qwen", "minimax",
]);

/**
 * Build a minimal process-only environment for ppt-master image generation.
 * Callers must restrict it to the ppt-master skill directory; it never mutates
 * process.env and never returns the API key to a renderer.
 */
function imageGenerationEnv(cfg = {}) {
  const backend = String(cfg.imageGenBackend || "modelscope").trim().toLowerCase();
  if (!IMAGE_GEN_BACKENDS.has(backend)) return {};
  const model = String(cfg.imageGenModel || "").trim();
  const baseUrl = String(cfg.imageGenBaseUrl || "").trim();
  const env = { IMAGE_BACKEND: backend };
  const keyNames = {
    modelscope: "MODELSCOPE_API_KEY",
    zhipu: "ZHIPU_API_KEY",
    openai: "OPENAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    siliconflow: "SILICONFLOW_API_KEY",
    volcengine: "VOLCENGINE_API_KEY",
    qwen: "DASHSCOPE_API_KEY",
    minimax: "MINIMAX_API_KEY",
  };
  const modelNames = {
    modelscope: "MODELSCOPE_MODEL",
    zhipu: "ZHIPU_MODEL",
    openai: "OPENAI_MODEL",
    openrouter: "OPENROUTER_MODEL",
    siliconflow: "SILICONFLOW_MODEL",
    volcengine: "VOLCENGINE_MODEL",
    qwen: "QWEN_MODEL",
    minimax: "MINIMAX_MODEL",
  };
  // Prefer the GUI's local config. If it is empty, selectively inherit the
  // matching user-level env var for backward compatibility; no other secret
  // vars are inherited into the child process.
  const configuredKey = String(cfg.imageGenApiKey || "").trim();
  const inheritedKey = String(process.env[keyNames[backend]] || "").trim();
  const key = configuredKey || inheritedKey;
  if (key) env[keyNames[backend]] = key;
  if (model) env[modelNames[backend]] = model;
  if (baseUrl && backend === "openai") env.OPENAI_BASE_URL = baseUrl;
  return env;
}

function listBundledTools() {
  const root = resolveSkillRuntimeRoot();
  if (!root) {
    return {
      ok: true,
      root: null,
      tools: [],
      node: false,
      python: false,
      manifest: null,
    };
  }
  const bin = path.join(root, "bin");
  const tools = [];
  if (fs.existsSync(bin)) {
    for (const name of fs.readdirSync(bin)) {
      if (name.endsWith(".ps1")) continue;
      if (name.endsWith(".cmd")) {
        tools.push(name.slice(0, -4));
      } else if (!path.extname(name) || name.endsWith(".exe")) {
        tools.push(name.replace(/\.exe$/i, ""));
      }
    }
  }
  const node = fs.existsSync(
    path.join(root, "node", process.platform === "win32" ? "node.exe" : "node")
  );
  const python = fs.existsSync(
    path.join(root, "python", process.platform === "win32" ? "python.exe" : "python")
  );
  return {
    ok: true,
    root,
    tools: [...new Set(tools)].sort(),
    node,
    python,
    manifest: readManifest(root),
  };
}

module.exports = {
  resolveSkillRuntimeRoot,
  augmentProcessEnv,
  executionEnv,
  imageGenerationEnv,
  listBundledTools,
  candidateRoots,
};
