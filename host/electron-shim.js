"use strict";
/**
 * Redirects `require("electron")` to the Tauri-backed platform shim.
 *
 * `src/**` calls `require("electron")` in 15 files (config, logger, secretStore,
 * questStore, skills, skillRuntime, agentBridge, ipc/*, main). Editing all of
 * them would fork the codebase and guarantee drift between the Electron and
 * Tauri builds. Intercepting the module loader instead means those files run
 * byte-identical in both builds.
 *
 * Implemented with `Module._resolveFilename` + a pre-seeded `Module._cache`
 * entry, so it works whether or not the real `electron` package is present
 * (the packaged Tauri app does not ship one).
 */
const Module = require("module");
const platform = require("./platform.js");

const SHIM_ID = "emsoder:electron-shim";

let installed = false;

function install() {
  if (installed) return platform;
  installed = true;

  const shimModule = new Module(SHIM_ID, null);
  shimModule.filename = SHIM_ID;
  shimModule.loaded = true;
  shimModule.exports = platform;
  Module._cache[SHIM_ID] = shimModule;

  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function resolveFilename(request, parent, ...rest) {
    if (request === "electron") return SHIM_ID;
    return originalResolve.call(this, request, parent, ...rest);
  };

  return platform;
}

module.exports = { install, SHIM_ID };
