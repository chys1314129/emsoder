const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const versions = require("./runtime-versions.json");

function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function verifyArchive(file, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected) || sha256(file) !== expected) throw new Error(`SHA256 mismatch: ${path.basename(file)}`);
}
function contained(base, target) {
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Refusing to replace a directory outside the release output");
}
function replaceGenerated(dir) {
  contained(path.join(root, "resources"), dir);
  if (fs.existsSync(dir)) throw new Error(`${path.relative(root, dir)} already exists. Use a clean CI checkout, not your populated local runtime.`);
  fs.mkdirSync(dir, { recursive: true });
}
function forwarder(name, rel, bin) {
  const command = `@echo off\r\nsetlocal\r\n"%~dp0..\\${rel.replace(/\//g, "\\")}" %*\r\nexit /b %errorlevel%\r\n`;
  fs.writeFileSync(path.join(bin, `${name}.cmd`), command);
}
function nodeForwarder(name, entry, bin) {
  fs.writeFileSync(path.join(bin, `${name}.cmd`), `@echo off\r\nsetlocal\r\n"%~dp0..\\node\\node.exe" "%~dp0..\\${entry.replace(/\//g, "\\")}" %*\r\nexit /b %errorlevel%\r\n`);
}
function copyFiles(source, target) {
  fs.cpSync(source, target, { recursive: true, dereference: false, filter: (p) => !["__pycache__", ".git", ".cache"].includes(path.basename(p)) });
}
function versionInfo(tag = "") {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json")));
  const tauri = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json")));
  const cargo = fs.readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8").split(/\n\[/)[0];
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error("Invalid application version");
  if ([lock.version, lock.packages?.[""]?.version, tauri.version, cargoVersion].some((v) => v !== pkg.version)) throw new Error("package.json/package-lock.json/tauri.conf.json/Cargo.toml version mismatch");
  const useTag = tag || `v${pkg.version}`;
  if (useTag !== `v${pkg.version}`) throw new Error(`Tag must be v${pkg.version}; update all version files first`);
  return { version: pkg.version, tag: useTag };
}
function prerequisites() {
  const files = ["scripts/test-release-config.js", "scripts/release/runtime-package-lock.json", "scripts/release/requirements-windows.lock.txt", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json", "src-tauri/src/lib.rs", "src-tauri/src/main.rs", "host/host.js", "host/platform.js", "src/pi/sidecar.mjs", "renderer/index.html", "scripts/build-host.js", "scripts/build-pi-sidecar.js", "scripts/vendor-assets.js", "scripts/preflight-share.js", "package-lock.json"];
  for (const rel of files) if (!fs.existsSync(path.join(root, rel))) throw new Error(`Missing committed release prerequisite: ${rel}`);
  for (const name of versions.coreSkills) if (!fs.existsSync(path.join(root, "resources/core-skills", name, "SKILL.md"))) throw new Error(`Missing core skill: ${name}; do not sync from a runner's personal home`);
}
function main(args) {
  if (args.includes("--check")) { prerequisites(); const at = args.indexOf("--tag"); console.log(JSON.stringify(versionInfo(at >= 0 ? args[at + 1] : ""))); return; }
  if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true") throw new Error("Runtime preparation is CI-only on Windows; refusing to overwrite a user's runtime");
  prerequisites(); versionInfo();
  const cache = process.env.EMSODER_DOWNLOAD_DIR;
  const wheels = process.env.EMSODER_WHEEL_DIR;
  if (!cache || !wheels) throw new Error("EMSODER_DOWNLOAD_DIR and EMSODER_WHEEL_DIR are required");
  verifyArchive(path.join(cache, "node.zip"), versions.node.sha256);
  verifyArchive(path.join(cache, "python.zip"), versions.python.sha256);
  const runtime = path.join(root, "resources/skill-runtime");
  replaceGenerated(runtime);
  copyFiles(path.join(cache, `node-v${versions.node.version}-win-x64`), path.join(runtime, "node"));
  copyFiles(path.join(cache, "python"), path.join(runtime, "python"));
  const py = path.join(runtime, "python/python.exe");
  const pth = path.join(runtime, "python", `python${versions.python.version.split(".").slice(0, 2).join("")}._pth`);
  fs.writeFileSync(pth, `python${versions.python.version.split(".").slice(0, 2).join("")}.zip\n.\nLib/site-packages\nimport site\n`);
  const python = process.env.EMSODER_BUILD_PYTHON;
  if (!python) throw new Error("Build Python path is required, do not invoke global pip");
  const pythonEnv = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PIP_CONFIG_FILE: "NUL" };
  execFileSync(python, ["-m", "pip", "--isolated", "install", "--no-index", "--find-links", wheels, "--only-binary=:all:", "--no-compile", "--require-hashes", "--target", path.join(runtime, "python/Lib/site-packages"), "-r", path.join(__dirname, "requirements-windows.lock.txt")], { stdio: "inherit", env: pythonEnv });
  // Embedded Python's _pth isolation omits a script's sibling modules. Only add
  // the explicitly executed script's directory, not arbitrary PYTHONPATH/CWD.
  fs.writeFileSync(path.join(runtime, "python/Lib/site-packages/sitecustomize.py"), "import os, sys\nif sys.argv and sys.argv[0] and os.path.isfile(sys.argv[0]):\n    sys.path.insert(0, os.path.dirname(os.path.abspath(sys.argv[0])))\n");
  const bin = path.join(runtime, "bin");
  fs.mkdirSync(bin);
  forwarder("node", "node/node.exe", bin);
  forwarder("python", "python/python.exe", bin);
  forwarder("python3", "python/python.exe", bin);
  // Tavily console launchers built outside the embedded Python contain an absolute path.
  fs.writeFileSync(path.join(runtime, "tvly-entry.py"), "from importlib.metadata import distribution\nentry = next(e for e in distribution('tavily-cli').entry_points if e.group == 'console_scripts' and e.name == 'tvly')\nentry.load()()\n");
  fs.writeFileSync(path.join(bin, "tvly.cmd"), "@echo off\r\n\"%~dp0..\\python\\python.exe\" \"%~dp0..\\tvly-entry.py\" %*\r\nexit /b %errorlevel%\r\n");
  fs.copyFileSync(path.join(__dirname, "runtime-package.json"), path.join(runtime, "package.json"));
  fs.copyFileSync(path.join(__dirname, "runtime-package-lock.json"), path.join(runtime, "package-lock.json"));
  const npm = path.join(runtime, "node/node_modules/npm/bin/npm-cli.js");
  execFileSync(path.join(runtime, "node/node.exe"), [npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: runtime, stdio: "inherit" });
  nodeForwarder("firecrawl", "node_modules/firecrawl-cli/dist/index.js", bin);
  nodeForwarder("mmx", "node_modules/mmx-cli/dist/mmx.mjs", bin);
  fs.writeFileSync(path.join(bin, "emsoder-skill-doctor.cmd"), "@echo off\r\ncall \"%~dp0node.cmd\" -v\r\ncall \"%~dp0python.cmd\" -V\r\nexit /b %errorlevel%\r\n");
  execFileSync(py, ["-c", `import importlib,sys;assert sys.version.split()[0]=='${versions.python.version}';[importlib.import_module(m) for m in ${JSON.stringify(versions.pythonImports)}];print('Embedded Python imports OK')`], { stdio: "inherit", env: pythonEnv });
  execFileSync(py, [path.join(root, "resources/core-skills/ppt-master/scripts/image_gen.py"), "--help"], { stdio: "inherit", env: pythonEnv });
  for (const entry of ["firecrawl-cli/dist/index.js", "mmx-cli/dist/mmx.mjs"]) if (!fs.existsSync(path.join(runtime, "node_modules", entry))) throw new Error(`Missing runtime CLI: ${entry}`);
  fs.writeFileSync(path.join(runtime, "manifest.json"), JSON.stringify({ version: 3, source: "clean-ci-downloads", runtime: { node: { bundled: true, version: versions.node.version }, python: { bundled: true, version: versions.python.version, pptMasterCoreVerified: true } }, tools: [{ name: "firecrawl", kind: "npm", version: versions.npmTools["firecrawl-cli"] }, { name: "mmx", kind: "npm", version: versions.npmTools["mmx-cli"] }, { name: "tvly", kind: "python-tool", version: "0.1.8" }], notes: ["No user configuration, environment tokens or personal skill caches included", "PDF browser-based rendering may require optional Playwright/Chromium installation"] }, null, 2));
  // Only ship core skills tracked with this source revision; never a home/cache mirror.
  const bundled = path.join(root, "resources/bundled-skills");
  if (fs.existsSync(bundled)) throw new Error("CI requires bundled-skills excluded from checkout; refusing to delete local assets");
  fs.mkdirSync(bundled);
  fs.writeFileSync(path.join(bundled, "manifest.json"), JSON.stringify({ version: 2, count: 0, coreCount: versions.coreSkills.length, sources: [], note: "Only repository core skills ship in this build. Personal mirrored skills are excluded." }, null, 2));
  console.log("Clean release runtime prepared");
}
module.exports = { sha256, verifyArchive, contained, versionInfo, prerequisites };
if (require.main === module) { try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
