const fs = require("fs/promises");
const path = require("path");
const {
  getPriorityRulesText,
  PRIORITY_RULES,
} = require("../core/priorityRules");

/**
 * Load priority (lower index = higher priority).
 * FOP priority rules are always index 0 and always injected first.
 */
const RULE_CANDIDATES = [
  // 0 = built-in FOP (not a file; handled in loadProjectRules)
  "AGENTS.md",
  "agents.md",
  ".emsoder/rules.md",
  ".emsoder/AGENTS.md",
  ".qoder/rules.md",
  ".qoder/AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
];

async function readIfExists(filePath, maxBytes = 80_000) {
  try {
    const st = await fs.stat(filePath);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = await fs.readFile(filePath);
    if (buf.includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Load project rules from workspace for agent system prompt.
 * Always prepends FOP priority rules at the highest priority.
 */
async function loadProjectRules(workspaceRoot) {
  const texts = [];
  const files = ["__priority__/FOP"];

  // Priority 0: built-in FOP rules (always)
  texts.push(getPriorityRulesText());

  if (!workspaceRoot) {
    return { texts, files, priorityRules: PRIORITY_RULES };
  }

  for (const rel of RULE_CANDIDATES) {
    const abs = path.join(workspaceRoot, rel);
    const content = await readIfExists(abs);
    if (content && content.trim()) {
      texts.push(`# Rules from ${rel}\n${content.trim()}`);
      files.push(rel);
    }
  }

  // directory of rule markdowns
  for (const dirRel of [".emsoder/rules", ".qoder/rules"]) {
    const dir = path.join(workspaceRoot, dirRel);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (!/\.(md|txt)$/i.test(e.name)) continue;
        const abs = path.join(dir, e.name);
        const content = await readIfExists(abs);
        if (content && content.trim()) {
          const rel = path.join(dirRel, e.name);
          texts.push(`# Rules from ${rel}\n${content.trim()}`);
          files.push(rel);
        }
      }
    } catch {
      /* no dir */
    }
  }

  return { texts, files, priorityRules: PRIORITY_RULES };
}

function formatRulesForPrompt(rules) {
  if (!rules?.texts?.length) {
    // still emit priority rules alone
    return [
      "Project rules (must follow when applicable):",
      "---",
      getPriorityRulesText(),
      "---",
    ].join("\n");
  }
  return [
    "Project rules (must follow when applicable):",
    "Priority: FOP rules first, then workspace rule files in load order.",
    "---",
    rules.texts.join("\n\n---\n\n").slice(0, 40_000),
    "---",
  ].join("\n");
}

module.exports = {
  loadProjectRules,
  formatRulesForPrompt,
  RULE_CANDIDATES,
  PRIORITY_RULES,
  getPriorityRulesText,
};
