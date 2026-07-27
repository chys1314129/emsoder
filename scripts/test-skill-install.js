/**
 * Unit tests for skillInstall parse / safety (no network).
 * Usage: node scripts/test-skill-install.js
 */
const {
  parseSkillsRepo,
  parseSkillName,
  PRESETS,
  isInstallRunning,
} = require("../src/tools/skillInstall");

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}

function main() {
  assert(Array.isArray(PRESETS) && PRESETS.length >= 1, "PRESETS empty");
  for (const p of PRESETS) {
    assert(p.repo && parseSkillsRepo(p.repo).ok, "preset repo invalid: " + p.repo);
    if (p.skill) assert(parseSkillName(p.skill).ok, "preset skill invalid");
  }

  assert(parseSkillsRepo("").ok === false);
  assert(parseSkillsRepo("not-a-repo").ok === false);
  assert(parseSkillsRepo("a/b;rm").ok === false);
  assert(parseSkillsRepo("owner/repo").ok === true);
  assert(parseSkillsRepo("https://github.com/owner/repo.git").display === "owner/repo");
  assert(parseSkillsRepo("owner/repo#main").ref === "main");
  assert(parseSkillsRepo("owner/repo#bad ref").ok === false);

  assert(parseSkillName("").ok === true && parseSkillName("").name === "");
  assert(parseSkillName("grill-me").ok === true);
  assert(parseSkillName("bad name").ok === false);
  assert(parseSkillName("--help").ok === false);

  assert(isInstallRunning() === false, "should not be running in test");

  console.log("test-skill-install: ok");
}

main();