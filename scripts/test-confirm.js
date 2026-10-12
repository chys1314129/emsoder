#!/usr/bin/env node
/**
 * Permission mode tests: five modes, legacy migration, terminal policy.
 */
const assert = require("assert");
const {
  MODES,
  normalizePermissionMode,
  permissionMeta,
  terminalAutoPolicy,
} = require("../src/tools/confirm");

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log(`✓ ${label}`);
}

// --- normalizePermissionMode: valid modes ---
for (const m of MODES) {
  ok(`normalize "${m}"`, normalizePermissionMode({ permissionMode: m }) === m);
}

// --- normalizePermissionMode: invalid -> default ---
ok(
  "normalize garbage -> confirm",
  normalizePermissionMode({ permissionMode: "xyz" }) === "confirm"
);
ok(
  "normalize empty -> confirm",
  normalizePermissionMode({}) === "confirm"
);

// --- normalizePermissionMode: legacy migration ---
ok(
  "legacy autoRunTools -> unrestricted",
  normalizePermissionMode({ autoRunTools: true }) === "unrestricted"
);
ok(
  "legacy autoApproveSafe -> auto_edit",
  normalizePermissionMode({ autoApproveSafe: true }) === "auto_edit"
);
ok(
  "legacy autoApproveSafe=false -> confirm",
  normalizePermissionMode({ autoApproveSafe: false }) === "confirm"
);
ok(
  "permissionMode wins over legacy",
  normalizePermissionMode({ permissionMode: "plan", autoRunTools: true }) ===
    "plan"
);

// --- permissionMeta ---
ok("meta confirm label", permissionMeta("confirm").label === "变更前确认");
ok("meta auto_edit label", permissionMeta("auto_edit").label === "自动编辑");
ok("meta plan label", permissionMeta("plan").label === "计划模式");
ok("meta full label", permissionMeta("full").label === "高危才询问");
ok("meta unrestricted label", permissionMeta("unrestricted").label === "完全授权");
ok("meta invalid -> confirm", permissionMeta("nope").label === "变更前确认");

// --- terminalAutoPolicy ---
// confirm mode: always ask
ok(
  "terminal confirm+safe -> ask",
  terminalAutoPolicy({ permissionMode: "confirm" }, true).auto === false
);
ok(
  "terminal confirm+danger -> ask",
  terminalAutoPolicy({ permissionMode: "confirm" }, false).auto === false
);

// auto_edit: terminal still asks (file is auto, terminal is not)
ok(
  "terminal auto_edit+safe -> ask",
  terminalAutoPolicy({ permissionMode: "auto_edit" }, true).auto === false
);

// plan: always block
ok(
  "terminal plan -> blocked",
  terminalAutoPolicy({ permissionMode: "plan" }, true).auto === false
);

// full: safe auto, danger ask
ok(
  "terminal full+safe -> auto",
  terminalAutoPolicy({ permissionMode: "full" }, true).auto === true
);
ok(
  "terminal full+danger -> ask",
  terminalAutoPolicy({ permissionMode: "full" }, false).auto === false
);

// unrestricted: never ask
ok(
  "terminal unrestricted+safe -> auto",
  terminalAutoPolicy({ permissionMode: "unrestricted" }, true).auto === true
);
ok(
  "terminal unrestricted+danger -> auto",
  terminalAutoPolicy({ permissionMode: "unrestricted" }, false).auto === true
);

// legacy terminalRunMode=autoAll still works
ok(
  "terminal autoAll -> auto (safe)",
  terminalAutoPolicy({ terminalRunMode: "autoAll" }, true).auto === true
);
ok(
  "terminal autoAll -> auto (danger)",
  terminalAutoPolicy({ terminalRunMode: "autoAll" }, false).auto === true
);

// terminalRunMode=autoSafe + safe command
ok(
  "terminal autoSafe+safe -> auto",
  terminalAutoPolicy({ terminalRunMode: "autoSafe" }, true).auto === true
);
ok(
  "terminal autoSafe+danger -> ask",
  terminalAutoPolicy({ terminalRunMode: "autoSafe" }, false).auto === false
);

// --- MODES array ---
ok("MODES has 5 entries", MODES.length === 5);
ok(
  "MODES order",
  MODES.join(",") === "confirm,auto_edit,plan,full,unrestricted"
);

console.log(`\nOK permission mode tests (${passed} assertions)`);
