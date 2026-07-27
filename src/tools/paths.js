const path = require("path");

/**
 * Resolve a user/tool path under workspace when possible.
 * Returns { ok, absolute, relative, error }.
 */
function resolveSafePath(workspaceRoot, inputPath, options = {}) {
  const allowOutside = options.allowOutside === true;
  const root = workspaceRoot ? path.resolve(workspaceRoot) : null;
  let absolute;

  if (!inputPath || inputPath === "." || inputPath === "./") {
    if (!root) {
      return { ok: false, error: "未打开工作区，无法解析相对路径" };
    }
    absolute = root;
  } else if (path.isAbsolute(inputPath)) {
    absolute = path.resolve(inputPath);
  } else {
    if (!root) {
      return { ok: false, error: "未打开工作区，无法解析相对路径" };
    }
    absolute = path.resolve(root, inputPath);
  }

  // normalize Windows long paths etc.
  absolute = path.normalize(absolute);

  if (root && !allowOutside) {
    const rel = path.relative(root, absolute);
    const outside =
      rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(`..${path.sep}`);
    // also catch ..\ on windows edge cases
    if (outside || rel === "..") {
      return {
        ok: false,
        error: `路径越界，禁止访问工作区外: ${inputPath}`,
        absolute,
      };
    }
  }

  return {
    ok: true,
    absolute,
    relative: root ? path.relative(root, absolute) : absolute,
  };
}

const HIDDEN_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "out",
  "build",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  ".cache",
  "coverage",
]);

function isHeavyDirName(name) {
  return HIDDEN_DIR_NAMES.has(name);
}

module.exports = {
  resolveSafePath,
  isHeavyDirName,
  HIDDEN_DIR_NAMES,
};
