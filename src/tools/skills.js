const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const os = require("os");

/**
 * zcode / agents compatible skills: <root>/<name>/SKILL.md (+ optional frontmatter).
 * Catalog is metadata-only (fast); full body loaded on demand via load_skill.
 */

const MAX_SKILL_BODY = 80_000;
const MAX_SKILL_FILE = 60_000;
const MAX_META_BYTES = 4_000;
const MAX_CATALOG_DESC = 180;
const MAX_CATALOG_SKILLS = 120;
const MAX_PROMPT_CHARS = 20_000;
const CACHE_TTL_MS = 30_000;

/** @type {{ key: string, at: number, value: any } | null} */
let catalogCache = null;

function homeDir() {
  return os.homedir() || process.env.USERPROFILE || process.env.HOME || "";
}

function defaultSkillRoots() {
  const home = homeDir();
  return home
    ? [
        path.join(home, ".zcode", "skills"),
        path.join(home, ".agents", "skills"),
      ]
    : [];
}

/**
 * Always-on core skills shipped in the repo (not gitignored).
 * - packaged: process.resourcesPath/core-skills
 * - dev: <app>/resources/core-skills
 * Includes find-skills so every install can discover more skills.
 */
function coreSkillRoots() {
  const roots = [];
  try {
    if (typeof process !== "undefined" && process.resourcesPath) {
      roots.push(path.join(process.resourcesPath, "core-skills"));
    }
  } catch {
    /* ignore */
  }
  roots.push(path.join(__dirname, "..", "..", "resources", "core-skills"));
  try {
    const { app } = require("electron");
    if (app?.getAppPath) {
      const appPath = app.getAppPath();
      if (appPath) roots.push(path.join(appPath, "resources", "core-skills"));
    }
  } catch {
    /* not in electron */
  }
  return roots;
}

/**
 * Skills synced at pack time into resources/bundled-skills (often gitignored).
 * - packaged: process.resourcesPath/bundled-skills (extraResources)
 * - dev / asar fallback: <app>/resources/bundled-skills
 */
function bundledSkillRoots() {
  const roots = [];
  try {
    if (typeof process !== "undefined" && process.resourcesPath) {
      roots.push(path.join(process.resourcesPath, "bundled-skills"));
    }
  } catch {
    /* ignore */
  }
  // src/tools -> ../../resources/bundled-skills
  roots.push(path.join(__dirname, "..", "..", "resources", "bundled-skills"));
  try {
    // electron app path (when available via require)
    const { app } = require("electron");
    if (app?.isReady?.() || app) {
      const appPath = app.getAppPath?.();
      if (appPath) {
        roots.push(path.join(appPath, "resources", "bundled-skills"));
      }
    }
  } catch {
    /* not in electron main, or electron unavailable */
  }
  return roots;
}

function pluginCacheRoots() {
  const home = homeDir();
  return home ? [path.join(home, ".zcode", "cli", "plugins", "cache")] : [];
}

function workspaceSkillRoots(workspaceRoot) {
  if (!workspaceRoot) return [];
  const root = path.resolve(workspaceRoot);
  return [".emsoder/skills", ".agents/skills", ".zcode/skills", "skills"].map(
    (rel) => path.join(root, rel)
  );
}

function sourceLabelForRoot(rootPath) {
  const n = rootPath.replace(/\\/g, "/").toLowerCase();
  if (n.includes("/core-skills")) return "core";
  if (n.includes("/bundled-skills")) return "bundled";
  if (n.includes("/.zcode/cli/plugins/cache")) return "plugin";
  if (n.includes("/.zcode/skills")) return "zcode";
  if (n.includes("/.agents/skills")) return "agents";
  return "workspace";
}

function skillIdFrom(name, dirName) {
  const raw = (name || dirName || "skill").trim();
  return (
    raw
      .toLowerCase()
      .replace(/[\\/]+/g, "/")
      .replace(/[^a-z0-9._+\-@/:\u4e00-\u9fff]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "skill"
  );
}

/** name + description from YAML frontmatter (best-effort). */
function parseSkillMarkdown(text) {
  const raw = String(text || "");
  let name = "";
  let description = "";
  let body = raw;
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end !== -1) {
      const fm = raw.slice(3, end);
      body = raw.slice(end + 4).replace(/^\r?\n/, "");
      const nameM = fm.match(/^name:\s*["']?(.+?)["']?\s*$/m);
      if (nameM) name = nameM[1].trim();
      const quoted = fm.match(/^description:\s*["'](.+?)["']\s*$/m);
      if (quoted) {
        description = quoted[1].trim();
      } else {
        const block = fm.match(
          /^description:\s*[|>]?\s*\n((?:[ \t]+.+\n?)+)/m
        );
        if (block) {
          description = block[1]
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .join(" ");
        } else {
          const plain = fm.match(/^description:\s*(.+)\s*$/m);
          if (plain && !/^[|>]/.test(plain[1])) {
            description = plain[1].replace(/^["']|["']$/g, "").trim();
          }
        }
      }
    }
  }
  if (!description) {
    const h = body.match(/^#\s+(.+)$/m);
    if (h) description = h[1].trim();
  }
  return { name, description, body };
}

async function readTextLimited(filePath, maxBytes) {
  try {
    const st = await fs.stat(filePath);
    // Allow large packages; only refuse absurd sizes ( > 8 MiB )
    if (!st.isFile() || st.size > 8 * 1024 * 1024) return null;
    const fh = await fs.open(filePath, "r");
    try {
      const len = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      // null byte only in the prefix we actually use
      if (buf.includes(0)) return null;
      let text = buf.toString("utf8");
      if (st.size > maxBytes) {
        text += `\n…(截断，原长约 ${st.size})`;
      }
      return text;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/**
 * Shallow: each child dir's SKILL.md (+ optional root SKILL.md).
 * Recursive: walk for any SKILL.md (plugin cache).
 */
/** fs.access-based existence check (async, no event-loop block) */
async function existsAsync(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function collectSkillMdFiles(root, recursive) {
  const out = [];
  const rootAbs = path.resolve(root);
  if (!(await existsAsync(rootAbs))) return out;

  if (!recursive) {
    try {
      const entries = await fs.readdir(rootAbs, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const skillMd = path.join(rootAbs, e.name, "SKILL.md");
        if (await existsAsync(skillMd)) out.push(skillMd);
      }
      const self = path.join(rootAbs, "SKILL.md");
      if (await existsAsync(self)) out.push(self);
    } catch {
      /* ignore */
    }
    return out;
  }

  async function walk(dir, depth) {
    if (out.length >= MAX_CATALOG_SKILLS * 2 || depth > 10) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const abs = path.join(dir, e.name);
      if (e.isFile() && e.name === "SKILL.md") {
        out.push(abs);
      } else if (e.isDirectory()) {
        await walk(abs, depth + 1);
      }
    }
  }
  await walk(rootAbs, 0);
  return out;
}

async function resolveRoots(cfg, workspaceRoot) {
  const ordered = [];
  const seen = new Set();
  const push = async (r) => {
    if (!r) return;
    const abs = path.resolve(r);
    const k = abs.toLowerCase();
    if (seen.has(k)) return;
    // skip missing dirs early (async, no event-loop block)
    if (!(await existsAsync(abs))) return;
    seen.add(k);
    ordered.push(abs);
  };
  // priority: user install > custom dirs > workspace > core (always) > synced bundled > plugins
  for (const r of defaultSkillRoots()) await push(r);
  for (const r of Array.isArray(cfg.skillsDirs) ? cfg.skillsDirs : []) await push(r);
  for (const r of workspaceSkillRoots(workspaceRoot)) await push(r);
  // core skills always on (find-skills); not gated by skillsIncludeBundled
  for (const r of coreSkillRoots()) await push(r);
  if (cfg.skillsIncludeBundled !== false) {
    for (const r of bundledSkillRoots()) await push(r);
  }
  if (cfg.skillsIncludePlugins !== false) {
    for (const r of pluginCacheRoots()) await push(r);
  }
  return ordered;
}

function cacheKey(cfg, workspaceRoot) {
  return JSON.stringify({
    e: cfg.skillsEnabled !== false,
    p: cfg.skillsIncludePlugins !== false,
    b: cfg.skillsIncludeBundled !== false,
    d: cfg.skillsDirs || [],
    x: cfg.skillsDisabled || [],
    w: workspaceRoot || "",
  });
}

/**
 * @returns {Promise<{ skills: Array, roots: string[], enabled: boolean }>}
 */
async function loadSkillCatalog(cfg = {}, workspaceRoot = "") {
  const key = cacheKey(cfg, workspaceRoot);
  if (
    catalogCache &&
    catalogCache.key === key &&
    Date.now() - catalogCache.at < CACHE_TTL_MS
  ) {
    return catalogCache.value;
  }

  const roots = await resolveRoots(cfg, workspaceRoot);
  if (cfg.skillsEnabled === false) {
    const value = { skills: [], roots, enabled: false };
    catalogCache = { key, at: Date.now(), value };
    return value;
  }

  const disabled = new Set(
    (Array.isArray(cfg.skillsDisabled) ? cfg.skillsDisabled : []).map((s) =>
      String(s).toLowerCase()
    )
  );
  const byId = new Map();

  for (const root of roots) {
    if (byId.size >= MAX_CATALOG_SKILLS) break;
    const isPlugin = sourceLabelForRoot(root) === "plugin";
    const files = await collectSkillMdFiles(root, isPlugin);
    for (const skillMd of files) {
      if (byId.size >= MAX_CATALOG_SKILLS) break;
      // metadata only — full body on load_skill
      const text = await readTextLimited(skillMd, MAX_META_BYTES);
      if (!text) continue;
      const parsed = parseSkillMarkdown(text);
      const dir = path.dirname(skillMd);
      const dirName = path.basename(dir);
      const name = parsed.name || dirName;
      const id = skillIdFrom(name, dirName);
      if (byId.has(id)) continue;
      byId.set(id, {
        id,
        name,
        description: (parsed.description || "").slice(0, 400),
        dir,
        skillMd,
        source: sourceLabelForRoot(root),
        root,
        disabled: disabled.has(id) || disabled.has(name.toLowerCase()),
      });
    }
  }

  const skills = [...byId.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "en")
  );
  const value = { skills, roots, enabled: true };
  catalogCache = { key, at: Date.now(), value };
  return value;
}

function invalidateSkillCache() {
  catalogCache = null;
}

function formatSkillsForPrompt(catalog) {
  if (!catalog || catalog.enabled === false) return "";
  const active = (catalog.skills || []).filter((s) => !s.disabled);
  if (!active.length) {
    return [
      "Installed Skills: (none found)",
      "Dirs: " + (catalog.roots || []).join("; "),
    ].join("\n");
  }
  const lines = [
    "Installed Skills (SKILL.md). Match task → load_skill(name) then follow it.",
    "list_skills filters; load_skill({name,file}) reads package files. Do not invent names.",
    "",
  ];
  let used = lines.join("\n").length;
  let count = 0;
  for (const s of active) {
    const desc = (s.description || "").replace(/\s+/g, " ").slice(0, MAX_CATALOG_DESC);
    const line = `- ${s.name} [${s.source}]: ${desc || "(no description)"}`;
    if (used + line.length + 1 > MAX_PROMPT_CHARS) {
      lines.push(`…(+${active.length - count} more; use list_skills)`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
    count++;
  }
  lines.push(`Shown ${count}/${active.length}`);
  return lines.join("\n");
}

function findSkill(catalog, nameOrId) {
  if (!catalog?.skills?.length || !nameOrId) return null;
  const q = String(nameOrId).trim().toLowerCase();
  if (!q) return null;
  return (
    catalog.skills.find((s) => s.id === q || s.name.toLowerCase() === q) ||
    catalog.skills.find(
      (s) => s.name.toLowerCase().includes(q) || s.id.includes(q)
    ) ||
    null
  );
}

function isPathInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function loadSkillContent(catalog, nameOrId, relFile = "", opts = {}) {
  const skill = findSkill(catalog, nameOrId);
  if (!skill) {
    return {
      ok: false,
      content: `Skill not found: ${nameOrId}. Call list_skills.`,
    };
  }
  // Agent load_skill still blocks disabled; UI skills:read can pass allowDisabled
  if (skill.disabled && !opts.allowDisabled) {
    return { ok: false, content: `Skill disabled: ${skill.name}` };
  }
  const fileRel = String(relFile || "").trim().replace(/^[/\\]+/, "");
  let target = skill.skillMd;
  if (fileRel) {
    const abs = path.resolve(skill.dir, fileRel);
    if (!isPathInside(skill.dir, abs)) {
      return { ok: false, content: `Path escapes skill dir: ${fileRel}` };
    }
    target = abs;
  }
  const text = await readTextLimited(
    target,
    fileRel ? MAX_SKILL_FILE : MAX_SKILL_BODY
  );
  if (text == null) {
    return {
      ok: false,
      content: `Cannot read: ${fileRel || "SKILL.md"}`,
    };
  }
  const header = [
    `Skill: ${skill.name}`,
    `Id: ${skill.id}`,
    `Source: ${skill.source}`,
    `Dir: ${skill.dir}`,
    `File: ${fileRel || "SKILL.md"}`,
    "",
  ].join("\n");
  return { ok: true, content: header + text, skill };
}

async function listSkillFiles(catalog, nameOrId, maxEntries = 40) {
  const skill = findSkill(catalog, nameOrId);
  if (!skill) return { ok: false, content: `Skill not found: ${nameOrId}` };
  if (skill.disabled) return { ok: false, content: `Skill disabled: ${skill.name}` };

  const lines = [];
  async function walk(dir, depth, prefix) {
    if (lines.length >= maxEntries || depth > 4) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (lines.length >= maxEntries) break;
      if (e.name === "node_modules" || e.name === ".git") continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        lines.push(`${rel}/`);
        await walk(path.join(dir, e.name), depth + 1, rel);
      } else {
        lines.push(rel);
      }
    }
  }
  await walk(skill.dir, 0, "");
  return {
    ok: true,
    content: [`Skill files: ${skill.name}`, `Dir: ${skill.dir}`, "", ...lines]
      .concat(lines.length >= maxEntries ? ["…(truncated)"] : [])
      .join("\n"),
  };
}

module.exports = {
  loadSkillCatalog,
  invalidateSkillCache,
  formatSkillsForPrompt,
  findSkill,
  loadSkillContent,
  listSkillFiles,
  parseSkillMarkdown,
  defaultSkillRoots,
  coreSkillRoots,
  bundledSkillRoots,
  workspaceSkillRoots,
  skillIdFrom,
};
