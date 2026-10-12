#!/usr/bin/env node
/**
 * Aggregate test runner: runs all test:* scripts in sequence.
 * Stops on first failure (exit code 1).
 */
const { execSync } = require("child_process");
const path = require("path");

const tests = [
  "test:confirm",
  "test:session",
  "test:apply-diff",
  "test:file-changes",
  "test:documents",
  "test:image-gen-config",
  "test:pi-sidecar",
  "test:pi-skills",
  "test:pi-compact",
  "test:pi-soak",
  "test:pi-transaction",
  "test:pi-nested-adapter",
  "test:pi-token-stats",
  "test:workspace-task-pool",
  "test:parallel-session-pinning",
  "test:context-history",
  "test:session-context-mutation",
  "test:execution-env",
  "test:credential-catalog",
  "test:config-secret-projection",
  "test:prompt-modal",
  "test:web-tools",
  "test:release-config",
  "test:providers",
  "test:pollinations",
  "test:keyless-integration",
  "test:keyless-ui",
  "test:memory",
  "test:mcp",
  "test:skills",
  // Tauri port: bridge surface parity, the Node host booting headlessly, and
  // DPAPI byte-compatibility with Electron's safeStorage.
  "test:bridge-parity",
  "test:host-boot",
  "test:dpapi-compat",
  // test:pty and test:debug need a display / Electron; skip in CI
];

let failed = 0;
for (const t of tests) {
  process.stdout.write(`\n${"=".repeat(60)}\n  ${t}\n${"=".repeat(60)}\n`);
  try {
    execSync(`npm run ${t}`, {
      cwd: path.join(__dirname, ".."),
      stdio: "inherit",
      env: process.env,
    });
  } catch {
    console.error(`\n✗ FAILED: ${t}`);
    failed += 1;
  }
}

console.log(
  `\n${"=".repeat(60)}\n` +
    (failed === 0
      ? `✓ ALL TESTS PASSED (${tests.length} suites)`
      : `✗ ${failed}/${tests.length} TEST SUITES FAILED`) +
    `\n${"=".repeat(60)}`
);
process.exit(failed === 0 ? 0 : 1);
