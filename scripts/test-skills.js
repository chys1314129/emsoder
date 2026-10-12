/**
 * Smoke test for zcode-compatible skill discovery.
 * Usage: node scripts/test-skills.js
 */
const fs = require("fs");
const path = require("path");
const {
  loadSkillCatalog,
  formatSkillsForPrompt,
  loadSkillContent,
  parseSkillMarkdown,
  skillIdFrom,
  invalidateSkillCache,
} = require("../src/tools/skills");

async function main() {
  invalidateSkillCache();
  const sample = parseSkillMarkdown(`---
name: demo-skill
description: |
  Demo description for unit test.
---

# Demo

Body text.
`);
  if (sample.name !== "demo-skill") throw new Error("parse name failed");
  if (!/Demo description/.test(sample.description)) {
    throw new Error("parse description failed");
  }
  if (skillIdFrom("Find Skills", "x") !== "find-skills") {
    throw new Error("skillIdFrom failed");
  }

  const t0 = Date.now();
  const catalog = await loadSkillCatalog(
    { skillsEnabled: true, skillsIncludePlugins: true },
    ""
  );
  const t1 = Date.now();
  // cache hit should be fast
  const t2 = Date.now();
  const again = await loadSkillCatalog(
    { skillsEnabled: true, skillsIncludePlugins: true },
    ""
  );
  const t3 = Date.now();
  if (again.skills.length !== catalog.skills.length) {
    throw new Error("cache length mismatch");
  }
  console.log(
    "roots:",
    catalog.roots.length,
    "skills:",
    catalog.skills.length,
    "scan ms:",
    t1 - t0,
    "cache ms:",
    t3 - t2
  );
  console.log(
    "sample:",
    catalog.skills
      .slice(0, 6)
      .map((s) => `${s.name}[${s.source}]`)
      .join(", ")
  );

  const prompt = formatSkillsForPrompt(catalog);
  if (!prompt.includes("Installed Skills")) {
    throw new Error("formatSkillsForPrompt missing header");
  }
  console.log("prompt chars:", prompt.length);

  const pick = catalog.skills.find((s) => !s.disabled) || catalog.skills[0];
  if (pick) {
    const loaded = await loadSkillContent(catalog, pick.name);
    if (!loaded.ok) throw new Error("load_skill failed: " + loaded.content);
    console.log("loaded:", pick.name, "bytes", loaded.content.length);
  }

  // core preinstalled find-skills (resources/core-skills)
  const findSkills = catalog.skills.find(
    (s) =>
      String(s.name || "").toLowerCase() === "find-skills" ||
      String(s.id || "").toLowerCase() === "find-skills"
  );
  if (!findSkills) {
    throw new Error(
      "find-skills missing from catalog — expected resources/core-skills/find-skills"
    );
  }
  // If user also has a copy under ~/.zcode, source may be zcode (higher priority).
  // Core root must still be scanned; when only core is present, source === core.
  const coreOnly = await loadSkillCatalog(
    {
      skillsEnabled: true,
      skillsIncludePlugins: false,
      skillsIncludeBundled: false,
      skillsDirs: [],
    },
    path.join(__dirname, "..", "resources", "core-skills", "__no_workspace__")
  );
  // workspace roots for a non-existent workspace path still empty; core always on
  invalidateSkillCache();
  const coreCatalog = await loadSkillCatalog(
    {
      skillsEnabled: true,
      skillsIncludePlugins: false,
      skillsIncludeBundled: false,
      skillsDirs: [],
    },
    ""
  );
  const coreFind = coreCatalog.skills.find(
    (s) =>
      String(s.name || "").toLowerCase() === "find-skills" ||
      String(s.id || "").toLowerCase() === "find-skills"
  );
  if (!coreFind) {
    throw new Error("find-skills not found when plugins/bundled disabled");
  }
  // Prefer that at least one root is core-skills when user copy absent;
  // always ensure content loads.
  const coreLoaded = await loadSkillContent(coreCatalog, "find-skills");
  if (!coreLoaded.ok) {
    throw new Error("load find-skills failed: " + coreLoaded.content);
  }
  if (!/Find Skills/i.test(coreLoaded.content) && !/npx skills/i.test(coreLoaded.content)) {
    throw new Error("find-skills body unexpected");
  }
  console.log(
    "find-skills ok: source=",
    coreFind.source,
    "bytes",
    coreLoaded.content.length
  );

  // Core MiniMax packages ship independently of the user's ~/.zcode skill copy.
  const coreDir = path.join(__dirname, "..", "resources", "core-skills");
  for (const id of [
    "ppt-master",
    "minimax-docx",
    "minimax-pdf",
    "minimax-xlsx",
    "minimax-multimodal-toolkit",
    "minimax-music-gen",
    "minimax-music-playlist",
  ]) {
    const skillFile = path.join(coreDir, id, "SKILL.md");
    if (!fs.existsSync(skillFile)) {
      throw new Error(`core preinstalled skill missing: ${id}`);
    }
    const parsed = parseSkillMarkdown(fs.readFileSync(skillFile, "utf8"));
    if (!parsed.name) throw new Error(`core skill invalid frontmatter: ${id}`);
  }
  console.log("core document/media skills ok");

  // allowDisabled: UI skills:read can open disabled skills; Agent load_skill must still block
  const disabledPick = catalog.skills.find((s) => s.disabled);
  if (disabledPick) {
    const blocked = await loadSkillContent(catalog, disabledPick.name || disabledPick.id);
    if (blocked.ok) {
      throw new Error("load_skill should fail for disabled skill without allowDisabled");
    }
    const allowed = await loadSkillContent(
      catalog,
      disabledPick.name || disabledPick.id,
      "",
      { allowDisabled: true }
    );
    if (!allowed.ok) {
      throw new Error("load_skill allowDisabled failed: " + (allowed.content || allowed.error));
    }
    console.log(
      "allowDisabled ok:",
      disabledPick.name,
      "bytes",
      (allowed.content || "").length
    );
  } else {
    console.log("allowDisabled skip: no disabled skill in catalog");
  }

  invalidateSkillCache();
  const off = await loadSkillCatalog({ skillsEnabled: false }, "");
  if (off.skills.length !== 0) throw new Error("disabled catalog should be empty");
  console.log("OK skills smoke test");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
