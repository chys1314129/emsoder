/**
 * Bundle skill CLI runtimes + portable Node (+ optional Python) into
 * resources/skill-runtime for portable/NSIS share.
 *
 * - Never copies API keys
 * - Node: copy minimal dist (node.exe + LICENSE) so friends don't need system Node
 * - Python: optional embeddable (EMSODER_BUNDLE_PYTHON=1 or found under joyclaw path)
 *
 * Usage: node scripts/sync-skill-runtime.js
 * Env: EMSODER_SKIP_RUNTIME_SYNC=1 | EMSODER_BUNDLE_PYTHON=0|1 | EMSODER_NODE_SRC=path
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const https = require("https");
const { execSync } = require("child_process");

const PROJECT = path.resolve(__dirname, "..");
const OUT = path.join(PROJECT, "resources", "skill-runtime");

const NPM_TOOLS = [
  { pkg: "firecrawl-cli", bin: "firecrawl", entry: "dist/index.js" },
  { pkg: "mmx-cli", bin: "mmx", entry: "dist/mmx.mjs" },
];

const NODE_VERSION = process.env.EMSODER_NODE_VERSION || "20.18.1";

function home() {
  return os.homedir() || process.env.USERPROFILE || process.env.HOME || "";
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function findFirst(paths) {
  for (const p of paths) {
    if (p && exists(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

function whichOnPath(name) {
  const pathEnv = process.env.Path || process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const n of [`${name}.exe`, name, `${name}.cmd`]) {
      const p = path.join(dir, n);
      if (exists(p) && fs.statSync(p).isFile()) return p;
    }
  }
  return null;
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDirFiltered(src, dest, skipNames = new Set()) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipNames.has(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyDirFiltered(from, to, skipNames);
    else if (e.isFile()) fs.copyFileSync(from, to);
  }
}

function npmInstall(packages) {
  const pkgJson = {
    name: "emsoder-skill-runtime",
    private: true,
    version: "1.0.0",
    description: "Vendored skill CLIs for EMSoder",
  };
  fs.writeFileSync(path.join(OUT, "package.json"), JSON.stringify(pkgJson, null, 2));
  const specs = packages.map((p) => p.pkg);
  console.log("npm install --omit=dev", specs.join(" "));
  execSync(
    `npm install --omit=dev --no-fund --no-audit --no-package-lock ${specs.join(" ")}`,
    {
      cwd: OUT,
      stdio: "inherit",
      env: {
        ...process.env,
        npm_config_fund: "false",
        ELECTRON_MIRROR:
          process.env.ELECTRON_MIRROR ||
          "https://npmmirror.com/mirrors/electron/",
      },
      shell: true,
    }
  );
}

/**
 * Prefer local Node install (copy node.exe only ~70MB).
 * Fallback: download official win-x64 binary zip from npmmirror / nodejs.org.
 */
function bundleNode() {
  const nodeDir = path.join(OUT, "node");
  fs.mkdirSync(nodeDir, { recursive: true });

  const envSrc = process.env.EMSODER_NODE_SRC;
  const candidates = [
    envSrc && path.join(envSrc, "node.exe"),
    envSrc,
    process.execPath && /node\.exe$/i.test(process.execPath)
      ? process.execPath
      : null,
    whichOnPath("node"),
    "C:\\Program Files\\nodejs\\node.exe",
    path.join(home(), "AppData", "Local", "Programs", "node", "node.exe"),
  ].filter(Boolean);

  let src = findFirst(candidates);
  // if src is a directory
  if (envSrc && exists(path.join(envSrc, "node.exe"))) {
    src = path.join(envSrc, "node.exe");
  }

  if (src) {
    copyFile(src, path.join(nodeDir, "node.exe"));
    // optional npm for friends who want to install more tools
    const npmDir = path.dirname(src);
    for (const extra of ["npm.cmd", "npx.cmd", "npm", "npx"]) {
      const p = path.join(npmDir, extra);
      if (exists(p)) copyFile(p, path.join(nodeDir, extra));
    }
    // npm needs node_modules/npm — only if nearby and not huge install path
    const npmMod = path.join(npmDir, "node_modules", "npm");
    if (exists(npmMod)) {
      try {
        copyDirFiltered(
          npmMod,
          path.join(nodeDir, "node_modules", "npm"),
          new Set([".cache", "test", "docs"])
        );
        console.log("  + node (local) + npm modules");
      } catch (e) {
        console.warn("  · npm modules copy skipped:", e.message || e);
        console.log("  + node (local) node.exe only");
      }
    } else {
      console.log("  + node (local)", src);
    }
    return { kind: "local", path: path.join(nodeDir, "node.exe"), src };
  }

  // download official binary
  const ver = NODE_VERSION.replace(/^v/, "");
  const zipName = `node-v${ver}-win-x64.zip`;
  const mirrors = [
    `https://npmmirror.com/mirrors/node/v${ver}/${zipName}`,
    `https://nodejs.org/dist/v${ver}/${zipName}`,
  ];
  const cacheDir = path.join(os.tmpdir(), "emsoder-node-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const zipPath = path.join(cacheDir, zipName);

  if (!exists(zipPath) || fs.statSync(zipPath).size < 1_000_000) {
    let ok = false;
    for (const url of mirrors) {
      try {
        console.log("download", url);
        downloadFile(url, zipPath);
        ok = true;
        break;
      } catch (e) {
        console.warn("download failed", url, e.message || e);
      }
    }
    if (!ok) {
      console.warn("  ! could not bundle Node — friends need system Node");
      return null;
    }
  }

  // extract with PowerShell Expand-Archive
  const extractTo = path.join(cacheDir, `node-v${ver}-win-x64`);
  if (exists(extractTo)) {
    fs.rmSync(extractTo, { recursive: true, force: true });
  }
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath.replace(
      /'/g,
      "''"
    )}' -DestinationPath '${cacheDir.replace(/'/g, "''")}' -Force"`,
    { stdio: "inherit" }
  );
  const extracted = path.join(cacheDir, `node-v${ver}-win-x64`);
  if (!exists(path.join(extracted, "node.exe"))) {
    console.warn("  ! extract missing node.exe");
    return null;
  }
  // copy whole portable node folder (node + npm)
  copyDirFiltered(extracted, nodeDir, new Set(["CHANGELOG.md"]));
  console.log("  + node (download)", ver);
  return { kind: "download", path: path.join(nodeDir, "node.exe"), version: ver };
}

function downloadFile(url, dest) {
  const tmp = dest + ".part";
  if (exists(tmp)) fs.unlinkSync(tmp);
  execSync(
    `powershell -NoProfile -Command "Invoke-WebRequest -Uri '${url.replace(
      /'/g,
      "''"
    )}' -OutFile '${tmp.replace(/'/g, "''")}' -UseBasicParsing"`,
    { stdio: "inherit", timeout: 600_000 }
  );
  fs.renameSync(tmp, dest);
}

/**
 * Optional embeddable / portable Python for tvly etc.
 */
function bundlePython() {
  const flag = process.env.EMSODER_BUNDLE_PYTHON;
  if (flag === "0" || flag === "false") {
    console.log("  · python skip (EMSODER_BUNDLE_PYTHON=0)");
    return null;
  }
  const candidates = [
    process.env.EMSODER_PYTHON_SRC,
    "D:\\joyclaw\\resources\\python-win",
    path.join(home(), "joyclaw", "resources", "python-win"),
  ].filter(Boolean);

  let srcRoot = null;
  for (const c of candidates) {
    if (exists(path.join(c, "python.exe"))) {
      srcRoot = c;
      break;
    }
  }
  if (!srcRoot) {
    // only auto-skip if not forced
    if (flag === "1" || flag === "true") {
      console.warn("  ! EMSODER_BUNDLE_PYTHON=1 but no python-win found");
    } else {
      console.log("  · python not found (set EMSODER_PYTHON_SRC or joyclaw path)");
    }
    return null;
  }

  const pyDir = path.join(OUT, "python");
  console.log("  + python from", srcRoot);
  copyDirFiltered(srcRoot, pyDir, new Set(["__pycache__", ".git"]));

  // ensure path-style embeddable can use site-packages
  const pth = path.join(pyDir, "python312._pth");
  if (exists(pth)) {
    let t = fs.readFileSync(pth, "utf8");
    if (!t.includes("import site")) {
      t = t.replace(/#\s*import site/, "import site");
      if (!/import site/.test(t)) t += "\nimport site\n";
      fs.writeFileSync(pth, t, "utf8");
    }
  }

  // best-effort: install tavily-cli into this python
  const py = path.join(pyDir, "python.exe");
  try {
    console.log("  · pip install tavily-cli into bundled python…");
    execSync(`"${py}" -m pip install --upgrade pip -q`, {
      stdio: "inherit",
      timeout: 180_000,
    });
    execSync(`"${py}" -m pip install tavily-cli -q`, {
      stdio: "inherit",
      timeout: 300_000,
    });
    // shim tvly -> python -m or Scripts/tvly.exe
    const scripts = path.join(pyDir, "Scripts");
    const tvlyExe = path.join(scripts, "tvly.exe");
    if (exists(tvlyExe)) {
      writeExeForwarder(path.join(OUT, "bin"), "tvly", tvlyExe);
      console.log("  + tvly via bundled python");
    }
  } catch (e) {
    console.warn("  · tavily-cli install failed:", e.message || e);
  }

  return { path: py, from: srcRoot };
}

function writeExeForwarder(binDir, name, targetExe) {
  const rel = path.relative(path.join(OUT), targetExe);
  const cmd = `@echo off\r
setlocal\r
set "RT=%~dp0.."\r
"${targetExe.startsWith(OUT) ? `%~dp0..\\${rel.replace(/\//g, "\\")}` : targetExe}" %*\r
exit /b %errorlevel%\r
`;
  // use relative from bin
  const relFromBin = path.relative(binDir, targetExe).replace(/\//g, "\\");
  const cmd2 = `@echo off\r
"%~dp0${relFromBin}" %*\r
`;
  fs.writeFileSync(path.join(binDir, `${name}.cmd`), cmd2, "utf8");
}

/**
 * Shims: prefer bundled node, then system node, then Electron-as-node.
 * Paths work for:
 *   win-unpacked/resources/skill-runtime  →  ../../EMSoder.exe
 *   portable extract same layout
 *   dev: resources/skill-runtime
 */
function writeCmdShim(binDir, binName, nodeEntryRel) {
  const entryWin = nodeEntryRel.replace(/\//g, "\\");
  const cmd = `@echo off\r
setlocal EnableExtensions\r
set "RT=%~dp0.."\r
set "ENTRY=%RT%\\${entryWin}"\r
if not exist "%ENTRY%" (\r
  echo [EMSoder] missing %ENTRY%\r
  exit /b 1\r
)\r
REM 1) bundled portable Node\r
if exist "%RT%\\node\\node.exe" (\r
  "%RT%\\node\\node.exe" "%ENTRY%" %*\r
  exit /b %errorlevel%\r
)\r
REM 2) system Node\r
where node >nul 2>&1\r
if %errorlevel%==0 (\r
  node "%ENTRY%" %*\r
  exit /b %errorlevel%\r
)\r
REM 3) Electron as Node (portable / installed app next to resources)\r
if exist "%RT%\\..\\EMSoder.exe" (\r
  set "ELECTRON_RUN_AS_NODE=1"\r
  "%RT%\\..\\EMSoder.exe" "%ENTRY%" %*\r
  exit /b %errorlevel%\r
)\r
if exist "%RT%\\..\\..\\EMSoder.exe" (\r
  set "ELECTRON_RUN_AS_NODE=1"\r
  "%RT%\\..\\..\\EMSoder.exe" "%ENTRY%" %*\r
  exit /b %errorlevel%\r
)\r
echo [EMSoder] No Node runtime. Re-run pack with sync-skill-runtime (bundles node).\r
exit /b 1\r
`;
  fs.writeFileSync(path.join(binDir, `${binName}.cmd`), cmd, "utf8");

  const sh = `#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$DIR/${nodeEntryRel.replace(/\\/g, "/")}"
if [ -x "$DIR/node/node" ] || [ -x "$DIR/node/node.exe" ]; then
  exec "$DIR/node/node" "$ENTRY" "$@" 2>/dev/null || exec "$DIR/node/node.exe" "$ENTRY" "$@"
fi
if command -v node >/dev/null 2>&1; then
  exec node "$ENTRY" "$@"
fi
echo "[EMSoder] node not found" >&2
exit 1
`;
  fs.writeFileSync(path.join(binDir, binName), sh, "utf8");
}

function writeNodeShim(binDir) {
  // so `node` / `npm` on PATH hit bundled first
  const nodeCmd = `@echo off\r
setlocal\r
set "RT=%~dp0.."\r
if exist "%RT%\\node\\node.exe" (\r
  "%RT%\\node\\node.exe" %*\r
  exit /b %errorlevel%\r
)\r
where.exe node >nul 2>&1\r
if %errorlevel%==0 (\r
  for /f "delims=" %%i in ('where.exe node') do (\r
    "%%i" %*\r
    exit /b %errorlevel%\r
  )\r
)\r
if exist "%RT%\\..\\EMSoder.exe" (\r
  set "ELECTRON_RUN_AS_NODE=1"\r
  "%RT%\\..\\EMSoder.exe" %*\r
  exit /b %errorlevel%\r
)\r
echo [EMSoder] node not found\r
exit /b 1\r
`;
  fs.writeFileSync(path.join(binDir, "node.cmd"), nodeCmd, "utf8");

  const npmCmd = `@echo off\r
setlocal\r
set "RT=%~dp0.."\r
if exist "%RT%\\node\\npm.cmd" (\r
  call "%RT%\\node\\npm.cmd" %*\r
  exit /b %errorlevel%\r
)\r
where npm >nul 2>&1\r
if %errorlevel%==0 (\r
  npm %*\r
  exit /b %errorlevel%\r
)\r
echo [EMSoder] npm not found in skill-runtime\\node\r
exit /b 1\r
`;
  fs.writeFileSync(path.join(binDir, "npm.cmd"), npmCmd, "utf8");

  const pyCmd = `@echo off\r
setlocal\r
set "RT=%~dp0.."\r
if exist "%RT%\\python\\python.exe" (\r
  "%RT%\\python\\python.exe" %*\r
  exit /b %errorlevel%\r
)\r
where python >nul 2>&1\r
if %errorlevel%==0 (\r
  python %*\r
  exit /b %errorlevel%\r
)\r
echo [EMSoder] python not bundled. Set EMSODER_BUNDLE_PYTHON=1 when packing.\r
exit /b 1\r
`;
  fs.writeFileSync(path.join(binDir, "python.cmd"), pyCmd, "utf8");
}

function writeDoctor(binDir) {
  const doctor = `@echo off\r
setlocal\r
set "RT=%~dp0.."\r
echo === EMSoder skill-runtime doctor ===\r
echo ROOT=%RT%\r
echo.\r
echo [bundled node]\r
if exist "%RT%\\node\\node.exe" ("%RT%\\node\\node.exe" -v) else (echo missing)\r
echo [bundled python]\r
if exist "%RT%\\python\\python.exe" ("%RT%\\python\\python.exe" -V) else (echo missing)\r
echo [PATH tools]\r
where node 2>nul\r
where python 2>nul\r
where firecrawl 2>nul\r
where mmx 2>nul\r
where tvly 2>nul\r
echo.\r
echo [bin]\r
dir /b "%~dp0"\r
`;
  fs.writeFileSync(path.join(binDir, "emsoder-skill-doctor.cmd"), doctor, "utf8");
}

function dirSizeMB(root) {
  let size = 0;
  function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else size += fs.statSync(p).size;
    }
  }
  walk(root);
  return size / 1024 / 1024;
}

async function main() {
  if (process.env.EMSODER_SKIP_RUNTIME_SYNC === "1") {
    console.log("skip skill-runtime sync");
    return;
  }

  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(path.join(OUT, "bin"), { recursive: true });

  const tools = [];
  const runtime = { node: null, python: null };

  // 1) Node first so npm tools can be smoke-tested later
  try {
    runtime.node = bundleNode();
  } catch (e) {
    console.warn("bundleNode failed:", e.message || e);
  }

  // 2) npm skill CLIs
  try {
    npmInstall(NPM_TOOLS);
  } catch (e) {
    console.error("npm install failed:", e.message || e);
  }

  for (const t of NPM_TOOLS) {
    const entry = path.join(OUT, "node_modules", t.pkg, t.entry);
    if (exists(entry)) {
      writeCmdShim(
        path.join(OUT, "bin"),
        t.bin,
        path.join("node_modules", t.pkg, t.entry)
      );
      tools.push({ name: t.bin, kind: "npm", pkg: t.pkg });
      console.log("  + npm", t.bin, "←", t.pkg);
    } else {
      console.warn("  ! missing", entry);
    }
  }

  // 3) optional Python + tavily
  try {
    runtime.python = bundlePython();
    if (runtime.python) tools.push({ name: "python", kind: "runtime" });
    if (exists(path.join(OUT, "bin", "tvly.cmd"))) {
      tools.push({ name: "tvly", kind: "python-tool" });
    }
  } catch (e) {
    console.warn("bundlePython failed:", e.message || e);
  }

  writeNodeShim(path.join(OUT, "bin"));
  writeDoctor(path.join(OUT, "bin"));
  tools.push({ name: "node", kind: "runtime" });

  const manifest = {
    version: 2,
    syncedAt: new Date().toISOString(),
    tools,
    runtime: {
      node: runtime.node
        ? { bundled: true, kind: runtime.node.kind, version: runtime.node.version || null }
        : { bundled: false },
      python: runtime.python
        ? { bundled: true, from: runtime.python.from }
        : { bundled: false },
    },
    notes: [
      "PATH injects skill-runtime/bin + node + python so portable works without system installs.",
      "API keys are NOT bundled.",
      "Same resources work for portable.exe and NSIS installer (extraResources).",
    ],
  };
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));

  const mb = dirSizeMB(OUT);
  console.log("");
  console.log(`skill-runtime: ${tools.length} tools · ~${mb.toFixed(1)} MB → ${OUT}`);
  console.log(
    "  node:",
    runtime.node ? "YES" : "NO",
    " python:",
    runtime.python ? "YES" : "NO"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
