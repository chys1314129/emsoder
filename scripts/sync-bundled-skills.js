/**
 * Copy installed zcode / agents skills into resources/bundled-skills
 * so they ship with the portable build for friends.
 *
 * Always also ensures core skills (resources/core-skills, e.g. find-skills)
 * are present — those live in-repo and are not gitignored.
 *
 * Usage: node scripts/sync-bundled-skills.js
 * Env:
 *   EMSODER_SKILL_SOURCES=path1;path2   extra roots
 *   EMSODER_SKIP_SKILL_SYNC=1          no-op exit 0
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");

const SKIP = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "__pycache__",
  ".venv",
  "venv",
  ".env",
  ".DS_Store",
  "Thumbs.db",
]);

const SKIP_FILE_RE =
  /(\.env($|\.)|\.pem$|\.key$|credentials\.json$|secrets?\.json$|id_rsa)/i;

function home() {
  return os.homedir() || process.env.USERPROFILE || process.env.HOME || "";
}

function defaultSources() {
  const h = home();
  const list = [];
  if (h) {
    list.push(path.join(h, ".zcode", "skills"));
    list.push(path.join(h, ".agents", "skills"));
  }
  const extra = process.env.EMSODER_SKILL_SOURCES || "";
  for (const p of extra.split(/[;|]/)) {
    const t = p.trim();
    if (t) list.push(path.resolve(t));
  }
  return list;
}

function isSkillPackage(dir) {
  return fs.existsSync(path.join(dir, "SKILL.md"));
}

async function copyFiltered(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    if (SKIP_FILE_RE.test(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) {
      await copyFiltered(from, to);
    } else if (e.isFile()) {
      await fsp.copyFile(from, to);
    }
  }
}

async function main() {
  if (process.env.EMSODER_SKIP_SKILL_SYNC === "1") {
    console.log("skip skill sync (EMSODER_SKIP_SKILL_SYNC=1)");
    return;
  }

  const projectRoot = path.resolve(__dirname, "..");
  const outRoot = path.join(projectRoot, "resources", "bundled-skills");
  const coreRoot = path.join(projectRoot, "resources", "core-skills");

  // fresh copy of synced (user) skills only — do not wipe core-skills
  await fsp.rm(outRoot, { recursive: true, force: true });
  await fsp.mkdir(outRoot, { recursive: true });

  const sources = defaultSources().filter((p) => fs.existsSync(p));
  /** @type {Map<string, { name: string, from: string }>} */
  const packages = new Map();

  for (const root of sources) {
    let entries;
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const dir = path.join(root, e.name);
      if (!isSkillPackage(dir)) continue;
      // first source wins (.zcode before .agents)
      const key = e.name.toLowerCase();
      if (packages.has(key)) continue;
      packages.set(key, { name: e.name, from: dir });
    }
  }

  // Prefer in-repo core packages over user copy for the same name in bundled mirror
  if (fs.existsSync(coreRoot)) {
    let coreEntries = [];
    try {
      coreEntries = await fsp.readdir(coreRoot, { withFileTypes: true });
    } catch {
      coreEntries = [];
    }
    for (const e of coreEntries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const dir = path.join(coreRoot, e.name);
      if (!isSkillPackage(dir)) continue;
      packages.set(e.name.toLowerCase(), { name: e.name, from: dir });
    }
  }

  let copied = 0;
  for (const { name, from } of packages.values()) {
    const dest = path.join(outRoot, name);
    await copyFiltered(from, dest);
    copied++;
    process.stdout.write(`  + ${name}\n`);
  }

  // Verify core skills exist for packaging / friends
  let coreCount = 0;
  if (fs.existsSync(coreRoot)) {
    try {
      for (const e of await fsp.readdir(coreRoot, { withFileTypes: true })) {
        if (e.isDirectory() && isSkillPackage(path.join(coreRoot, e.name))) {
          coreCount++;
        }
      }
    } catch {
      /* ignore */
    }
  }

  const manifest = {
    version: 1,
    syncedAt: new Date().toISOString(),
    count: copied,
    coreCount,
    coreRoot,
    sources,
    note:
      "Synced from local zcode/agents + in-repo core-skills (find-skills). No .env / node_modules. core-skills is always shipped; this folder is pack-time extra.",
  };
  await fsp.writeFile(
    path.join(outRoot, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );

  console.log("");
  console.log(`bundled skills: ${copied} → ${outRoot}`);
  console.log(`core skills: ${coreCount} → ${coreRoot}`);
  console.log(`sources: ${sources.join(" | ") || "(none found)"}`);
  if (!coreCount) {
    console.warn("warning: resources/core-skills empty — find-skills missing?");
  }
  if (!copied) {
    console.warn(
      "warning: no skills found under ~/.zcode/skills or ~/.agents/skills (core still ships)"
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
