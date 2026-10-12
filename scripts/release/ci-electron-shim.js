"use strict";
/**
 * CI-only module-loader hook for the headless regression tests.
 *
 * Why this exists: the release workflow installs dependencies with
 * `--ignore-scripts` and never downloads the Electron binary, because the
 * shipped product is the Tauri build. Several regression tests pull in `src/**`,
 * which calls `require("electron")` for `app.getPath` and `safeStorage`; without
 * this hook they would crash on a missing Electron binary even though they do
 * not exercise any Electron-only behaviour.
 *
 * Two deliberate limits, both because `NODE_OPTIONS` is inherited by child
 * processes:
 *
 * 1. The shim is installed **only when the entry script is a test** under
 *    `scripts/test-*.js`. The Pi sidecar (`src/pi/sidecar.mjs`) and the packaged
 *    host (`host/host.js`) must not load it: the sidecar owns stdin for its own
 *    JSON-RPC, and the host installs this same shim itself.
 * 2. stdin is released only for those test processes. The platform shim opens
 *    the RPC tunnel, whose readline interface on stdin would otherwise keep a
 *    finished test process alive forever.
 *
 * Using the production shim (rather than a bespoke stub) keeps the tests on the
 * same code path the Tauri build runs, and `safeStorage` degrades to
 * "unavailable" exactly as it does on a machine without the DPAPI helper.
 *
 * Loaded via `NODE_OPTIONS=--require=./scripts/release/ci-electron-shim.js`.
 */
const path = require("node:path");

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isTestEntry = /[\\/]scripts[\\/]test-[^\\/]+\.js$/.test(entry);

if (isTestEntry) {
  require("../../host/electron-shim.js").install();
  try {
    process.stdin.pause();
    process.stdin.unref?.();
  } catch {
    /* stdin may be closed or absent in CI; nothing to release */
  }
}
