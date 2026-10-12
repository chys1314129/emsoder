/**
 * Vendor renderer assets (Monaco + xterm) out of node_modules into
 * renderer/vendor/, so the Tauri webview can load them as same-origin
 * static files.
 *
 * The Electron build serves these straight out of node_modules over file://
 * (see src/preload/preload.js). Tauri serves the whole renderer/ tree over
 * http://tauri.localhost/, so the assets have to live inside it.
 *
 * Run: node scripts/vendor-assets.js   (also wired into npm run vendor / tauri hooks)
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const nm = path.join(root, "node_modules");
const outRoot = path.join(root, "renderer", "vendor");

/** monaco-editor: copy min/vs (loader + editor.main + language workers) */
const MONACO_SRC = path.join(nm, "monaco-editor", "min", "vs");
const MONACO_DST = path.join(outRoot, "monaco", "min", "vs");

/** xterm: 4 individual files */
const XTERM_FILES = [
  ["xterm/css/xterm.css", "xterm/xterm.css"],
  ["xterm/lib/xterm.js", "xterm/xterm.js"],
  ["xterm-addon-fit/lib/xterm-addon-fit.js", "xterm/addon-fit.js"],
  ["xterm-addon-web-links/lib/xterm-addon-web-links.js", "xterm/addon-web-links.js"],
];

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  let files = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    // Monaco ships .map files that are useless at runtime and cost ~10 MB.
    if (entry.isFile() && entry.name.endsWith(".map")) continue;
    if (entry.isDirectory()) files += copyDir(s, d);
    else if (entry.isFile()) {
      fs.copyFileSync(s, d);
      files += 1;
    }
  }
  return files;
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function main() {
  const missing = [];
  if (!fs.existsSync(MONACO_SRC)) missing.push(MONACO_SRC);
  for (const [rel] of XTERM_FILES) {
    const abs = path.join(nm, rel);
    if (!fs.existsSync(abs)) missing.push(abs);
  }
  if (missing.length) {
    console.error("[vendor-assets] 缺少源文件，请先在 desktop/ 下执行 npm install:");
    for (const m of missing) console.error("  - " + m);
    process.exit(1);
  }

  fs.rmSync(outRoot, { recursive: true, force: true });

  const monacoFiles = copyDir(MONACO_SRC, MONACO_DST);
  console.log(`[vendor-assets] monaco: ${monacoFiles} 个文件 -> ${path.relative(root, MONACO_DST)}`);

  for (const [rel, dstRel] of XTERM_FILES) {
    const dst = path.join(outRoot, dstRel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(nm, rel), dst);
  }
  console.log(`[vendor-assets] xterm: ${XTERM_FILES.length} 个文件 -> ${path.relative(root, path.join(outRoot, "xterm"))}`);

  // A marker the renderer can probe: if it is missing, the app was built
  // without vendoring and the bridge reports a clear error instead of a
  // blank editor.
  fs.writeFileSync(
    path.join(outRoot, "vendor-manifest.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        monaco: { baseUrl: "vendor/monaco/min/", vsUrl: "vendor/monaco/min/vs/", loaderUrl: "vendor/monaco/min/vs/loader.js" },
        xterm: {
          cssUrl: "vendor/xterm/xterm.css",
          jsUrl: "vendor/xterm/xterm.js",
          fitUrl: "vendor/xterm/addon-fit.js",
          webLinksUrl: "vendor/xterm/addon-web-links.js",
        },
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  console.log(`[vendor-assets] 总计 ${mb(dirSize(outRoot))} -> renderer/vendor/`);
}

main();
