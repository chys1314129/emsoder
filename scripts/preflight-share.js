#!/usr/bin/env node
/**
 * Friend-share preflight. No credentials are required; credentials are only
 * checked for accidental files/leaks, never printed.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const PROJECT = path.resolve(__dirname, "..");
const errors = [];
const warnings = [];
const pass = [];

function ok(msg) { pass.push(msg); console.log("PASS ", msg); }
function warn(msg) { warnings.push(msg); console.log("WARN ", msg); }
function fail(msg) { errors.push(msg); console.log("FAIL ", msg); }
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function file(p) { return exists(p) && fs.statSync(p).isFile(); }
function dir(p) { return exists(p) && fs.statSync(p).isDirectory(); }

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { fail(`invalid JSON: ${path.relative(PROJECT, p)} (${e.message})`); return null; }
}

function checkCoreSkills() {
  const root = path.join(PROJECT, "resources", "core-skills");
  if (!dir(root)) return fail("resources/core-skills missing");
  const required = [
    "find-skills", "ppt-master", "minimax-docx", "minimax-pdf", "minimax-xlsx",
    "minimax-multimodal-toolkit", "minimax-music-gen", "minimax-music-playlist",
  ];
  for (const id of required) {
    const skill = path.join(root, id);
    if (!file(path.join(skill, "SKILL.md"))) fail(`core skill missing SKILL.md: ${id}`);
    else ok(`core skill: ${id}`);
  }
  for (const rel of ["scripts", "templates", "workflows"]) {
    if (!dir(path.join(root, "ppt-master", rel))) fail(`ppt-master/${rel} missing`);
    else ok(`ppt-master/${rel}`);
  }
  const piRoot = path.join(PROJECT, "resources", "agent-runtime");
  if (!file(path.join(piRoot, "sidecar.mjs")) || !file(path.join(piRoot, "protocol.js"))) {
    fail("Pi sidecar runtime missing (run npm run build:pi-sidecar)");
  } else {
    ok("Pi sidecar runtime present");
  }
  if (!file(path.join(PROJECT, "resources", "agent-runtime", "LICENSE.pi.txt"))) {
    warn("Pi runtime license file missing");
  } else {
    ok("Pi runtime license present");
  }
}

function checkRuntime() {
  const root = path.join(PROJECT, "resources", "skill-runtime");
  const py = path.join(root, "python", "python.exe");
  const node = path.join(root, "node", "node.exe");
  if (!file(py)) fail("bundled Python missing"); else ok("bundled Python present");
  if (!file(node)) fail("bundled Node missing"); else ok("bundled Node present");
  for (const name of ["_socket.pyd", "_ssl.pyd", "_ctypes.pyd", "select.pyd"]) {
    if (!file(path.join(root, "python", name))) fail(`Python extension missing: ${name}`);
    else ok(`Python extension: ${name}`);
  }
  for (const name of ["python.cmd", "node.cmd", "emsoder-skill-doctor.cmd"]) {
    if (!file(path.join(root, "bin", name))) fail(`runtime shim missing: ${name}`);
    else ok(`runtime shim: ${name}`);
  }
  return { root, py };
}

function checkPython(runtime) {
  if (!file(runtime.py)) return;
  const code = [
    "import importlib, json, sys",
    "mods = ['_socket','_ssl','_ctypes','select','pptx','xlsxwriter','PIL','numpy','requests','fitz','mammoth','openpyxl','markdownify','bs4','flask','svglib','reportlab']",
    "missing = []",
    "for m in mods:",
    "    try: importlib.import_module(m)",
    "    except Exception as e: missing.append(m + ': ' + str(e))",
    "print(json.dumps({'python': sys.version.split()[0], 'missing': missing}))",
    "raise SystemExit(1 if missing else 0)",
  ].join("\n");
  const temp = path.join(require("os").tmpdir(), `emsoder-preflight-${process.pid}.py`);
  fs.writeFileSync(temp, code, "utf8");
  try {
    const out = execFileSync(runtime.py, [temp], { encoding: "utf8", timeout: 90_000 });
    const result = JSON.parse(out.trim().split(/\r?\n/).pop());
    ok(`Python imports verified (${result.python})`);
  } catch (e) {
    const output = String(e.stdout || e.stderr || e.message || "").slice(-1000);
    fail(`Python core imports failed: ${output}`);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* ignore */ }
  }
}

function checkPackage() {
  const pkg = readJson(path.join(PROJECT, "package.json"));
  const lock = readJson(path.join(PROJECT, "package-lock.json"));
  if (!pkg || !lock) return;
  if (String(pkg.version) !== String(lock.version)) fail(`package version mismatch: ${pkg.version} vs lock ${lock.version}`);
  else ok(`package version ${pkg.version}`);
  if (pkg.dependencies?.docx || pkg.dependencies?.pdfkit || pkg.dependencies?.pptxgenjs) {
    fail("removed create_document dependencies still present");
  } else ok("create_document generator dependencies absent");
}

function walk(root, cb) {
  if (!dir(root)) return;
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, ent.name);
    if (ent.isDirectory()) walk(p, cb); else cb(p);
  }
}

function checkSecrets() {
  const forbiddenNames = new Set([".env", ".env.local", ".env.production", "emsoder-config.json", "emsoder-sessions.json"]);
  const roots = [path.join(PROJECT, "resources"), path.join(PROJECT, "dist")];
  for (const root of roots) {
    walk(root, (p) => {
      if (forbiddenNames.has(path.basename(p).toLowerCase())) fail(`sensitive file in share tree: ${path.relative(PROJECT, p)}`);
      // certifi's public CA bundle is required by requests, not a user secret.
      const isPublicCaBundle = /[\\/]certifi[\\/]cacert\.pem$/i.test(p);
      if (!isPublicCaBundle && /\.pem$|\.key$|\.p12$|\.pfx$/i.test(p)) {
        fail(`credential file in share tree: ${path.relative(PROJECT, p)}`);
      }
    });
  }
  if (!errors.some((x) => /sensitive|credential/.test(x))) ok("no obvious credential files in share trees");
  warn("API keys are not required; friend must configure their own model/image credentials");
}

function main() {
  console.log(`EMSoder share preflight: ${PROJECT}`);
  checkPackage();
  checkCoreSkills();
  const runtime = checkRuntime();
  checkPython(runtime);
  checkSecrets();
  console.log(`\nResult: ${errors.length ? "FAIL" : "PASS"} · ${pass.length} pass · ${warnings.length} warn · ${errors.length} fail`);
  if (errors.length) process.exitCode = 1;
}
main();
