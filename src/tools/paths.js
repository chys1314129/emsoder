const path = require("path");
const fsSync = require("fs");

/**
 * 解析真实路径（跟随符号链接/junction）。目标路径不存在时向上找最近的已存在
 * 祖先并补回后缀，避免 write_file 写新文件时 realpathSync 抛错。
 */
function realpathOrBestEffort(p) {
  const target = path.resolve(p);
  let cur = target;
  const suffix = [];
  for (;;) {
    try {
      const real = fsSync.realpathSync.native(cur);
      return suffix.length ? path.join(real, ...suffix) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return target;
      suffix.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Resolve a user/tool path under workspace when possible.
 * Returns { ok, absolute, relative, error }.
 * options.allowOutside: skip the workspace bound entirely.
 * options.allowedRoots: extra absolute roots that are also permitted
 *   (e.g. installed skill directories + the bundled skill runtime).
 */
function resolveSafePath(workspaceRoot, inputPath, options = {}) {
  const allowOutside = options.allowOutside === true;
  const allowedRoots = Array.isArray(options.allowedRoots)
    ? options.allowedRoots.filter(Boolean).map((r) => path.resolve(r))
    : [];
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

  const within = (base) => {
    if (!base) return false;
    const rel = path.relative(base, absolute);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };

  if (root && !allowOutside) {
    const inWorkspace = within(root);
    const inAllowed = allowedRoots.some(within);
    if (!inWorkspace && !inAllowed) {
      return {
        ok: false,
        error:
          `路径越界，禁止访问工作区外: ${inputPath}` +
          (allowedRoots.length
            ? "（仅工作区与已安装技能目录可访问）"
            : ""),
        absolute,
      };
    }
    // 符号链接 / junction 逃逸防护：词法校验通过后再按真实路径校验一次。
    // 防止工作区内的 symlink 指向区外，绕过 path.relative 的词法判断。
    const realRoot = realpathOrBestEffort(root);
    const realAbs = realpathOrBestEffort(absolute);
    const withinReal = (base) => {
      const rel = path.relative(base, realAbs);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    };
    const realInside =
      withinReal(realRoot) ||
      allowedRoots.some((r) => withinReal(realpathOrBestEffort(r)));
    if (!realInside) {
      return {
        ok: false,
        error: `路径经符号链接逃逸出允许范围: ${inputPath}`,
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
  realpathOrBestEffort,
  isHeavyDirName,
  HIDDEN_DIR_NAMES,
};
