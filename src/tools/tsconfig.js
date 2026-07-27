const fs = require("fs/promises");
const path = require("path");

/**
 * Strip // and /* *\/ comments from JSONC (tsconfig).
 * Not a full JSONC parser but good enough for common tsconfigs.
 */
function stripJsonComments(text) {
  let out = "";
  let i = 0;
  let inStr = false;
  let quote = "";
  let escaped = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inStr = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // trailing commas before } or ]
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function parseJsonc(text) {
  return JSON.parse(stripJsonComments(text));
}

async function findTsconfig(workspaceRoot) {
  if (!workspaceRoot) return null;
  const candidates = [
    "tsconfig.json",
    "tsconfig.app.json",
    "tsconfig.base.json",
    "jsconfig.json",
  ];
  for (const rel of candidates) {
    const abs = path.join(workspaceRoot, rel);
    try {
      const st = await fs.stat(abs);
      if (st.isFile()) return abs;
    } catch {
      /* continue */
    }
  }
  return null;
}

async function readTsconfigChain(filePath, seen = new Set()) {
  if (!filePath || seen.has(filePath)) return {};
  seen.add(filePath);
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return {};
  }
  let json;
  try {
    json = parseJsonc(raw);
  } catch (err) {
    return { __parseError: err.message, __path: filePath };
  }
  let base = {};
  if (json.extends) {
    const ext = String(json.extends);
    // only support relative extends for safety
    if (ext.startsWith(".")) {
      const basePath = path.resolve(path.dirname(filePath), ext.endsWith(".json") ? ext : ext + ".json");
      base = await readTsconfigChain(basePath, seen);
    }
  }
  return {
    ...base,
    ...json,
    compilerOptions: {
      ...(base.compilerOptions || {}),
      ...(json.compilerOptions || {}),
    },
  };
}

/**
 * Map tsconfig compilerOptions -> Monaco TS compiler option fields (stringly for IPC).
 * Frontend maps enums to monaco.languages.typescript.* values.
 */
function toMonacoCompilerOptions(compilerOptions = {}) {
  const c = compilerOptions || {};
  return {
    target: String(c.target || "ES2022"),
    module: String(c.module || "ESNext"),
    moduleResolution: String(c.moduleResolution || "node"),
    jsx: String(c.jsx || "react-jsx"),
    allowJs: c.allowJs !== false,
    checkJs: !!c.checkJs,
    strict: !!c.strict,
    noImplicitAny: c.noImplicitAny ?? !!c.strict,
    strictNullChecks: c.strictNullChecks ?? !!c.strict,
    esModuleInterop: c.esModuleInterop !== false,
    allowSyntheticDefaultImports: c.allowSyntheticDefaultImports !== false,
    resolveJsonModule: c.resolveJsonModule !== false,
    experimentalDecorators: !!c.experimentalDecorators,
    emitDecoratorMetadata: !!c.emitDecoratorMetadata,
    useDefineForClassFields: c.useDefineForClassFields !== false,
    baseUrl: c.baseUrl ? String(c.baseUrl) : undefined,
    paths: c.paths && typeof c.paths === "object" ? c.paths : undefined,
    lib: Array.isArray(c.lib) ? c.lib.map(String) : ["es2022", "dom"],
    skipLibCheck: c.skipLibCheck !== false,
    noEmit: true,
    isolatedModules: c.isolatedModules !== false,
  };
}

async function loadWorkspaceTsconfig(workspaceRoot) {
  const file = await findTsconfig(workspaceRoot);
  if (!file) {
    return {
      ok: true,
      found: false,
      path: null,
      compilerOptions: toMonacoCompilerOptions({}),
    };
  }
  const merged = await readTsconfigChain(file);
  if (merged.__parseError) {
    return {
      ok: false,
      found: true,
      path: file,
      error: merged.__parseError,
      compilerOptions: toMonacoCompilerOptions({}),
    };
  }
  return {
    ok: true,
    found: true,
    path: file,
    relative: path.relative(workspaceRoot, file),
    compilerOptions: toMonacoCompilerOptions(merged.compilerOptions || {}),
    include: merged.include || null,
    exclude: merged.exclude || null,
  };
}

module.exports = {
  stripJsonComments,
  parseJsonc,
  findTsconfig,
  loadWorkspaceTsconfig,
  toMonacoCompilerOptions,
};
