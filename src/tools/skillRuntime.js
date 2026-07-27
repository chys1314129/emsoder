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
function augmentProcessEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
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
  listBundledTools,
  candidateRoots,
};
