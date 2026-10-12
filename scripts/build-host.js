/**
 * Builds the packaged Node host into `resources/runtime/`.
 *
 * Layout (which must mirror the repo layout, because `host/host.js` resolves
 * the app with `require("../src/...")`):
 *
 *   resources/runtime/host/host.js      <- copied from desktop/host/
 *   resources/runtime/src/**            <- copied from desktop/src/
 *   resources/runtime/node_modules/**   <- dependency closure of the four
 *                                          third-party packages the host loads
 *
 * Node resolves `node_modules` by walking up from the requiring file, so
 * `runtime/src/tools/documentReader.js` requiring `mammoth` finds
 * `runtime/node_modules/mammoth`. No NODE_PATH needed.
 *
 * What the host does NOT need here: the Pi packages
 * (`@earendil-works/pi-agent-core` / `pi-ai`), which are only imported inside
 * `src/pi/sidecar.mjs` and already ship in `resources/agent-runtime`.
 *
 * Run: node scripts/build-host.js   (npm run build:host)
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outRoot = path.join(root, "resources", "runtime");
const outNodeModules = path.join(outRoot, "node_modules");

/** Packages the host requires outside of src/pi/sidecar.mjs. */
const RUNTIME_ROOTS = [
  "ws", // src/main/debugger.js — CDP socket fallback where no global WebSocket
  "@homebridge/node-pty-prebuilt-multiarch", // src/main/terminal.js — real PTY
  "exceljs", // src/tools/documentReader.js — .xlsx
  "mammoth", // src/tools/documentReader.js — .docx
];

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyTree(src, dst, { skipMaps = true } = {}) {
  fs.mkdirSync(dst, { recursive: true });
  let files = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      files += copyTree(s, d, { skipMaps });
    } else if (entry.isFile()) {
      if (skipMaps && entry.name.endsWith(".map")) continue;
      fs.copyFileSync(s, d);
      files += 1;
    }
  }
  return files;
}

/** Directory size in bytes, for the summary line. */
function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

/**
 * Recursively copy a package plus its `dependencies`, skipping what's already
 * been copied. Version conflicts between two branches are resolved by "first
 * writer wins" — acceptable here because these four trees are small and this is
 * the same approach scripts/build-pi-sidecar.js takes.
 */
function copyClosure(name, seen) {
  if (seen.has(name)) return 0;
  seen.add(name);

  const src = path.join(root, "node_modules", name);
  if (!fs.existsSync(src)) {
    // A missing *root* is a real problem; a missing transitive package is
    // usually a build-only or optional dep (e.g. node-pty's node-addon-api,
    // which is only needed to compile the native module).
    if (RUNTIME_ROOTS.includes(name)) {
      console.warn(`  ! 缺少必需依赖：${name}（请先 npm install）`);
    } else {
      console.log(`  · 跳过缺失的间接依赖：${name}（仅构建期需要，运行时无关）`);
    }
    return 0;
  }
  const dst = path.join(outNodeModules, name);
  const files = copyTree(src, dst);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
  } catch {
    return files;
  }
  let nested = files;
  for (const dep of Object.keys(manifest.dependencies || {})) {
    nested += copyClosure(dep, seen);
  }
  return nested;
}

function main() {
  const hostSrc = path.join(root, "host");
  const srcSrc = path.join(root, "src");
  for (const required of [hostSrc, srcSrc]) {
    if (!fs.existsSync(required)) {
      console.error(`[build-host] 缺少源目录：${required}`);
      process.exit(1);
    }
  }

  rmrf(outRoot);
  fs.mkdirSync(outNodeModules, { recursive: true });

  const hostFiles = copyTree(hostSrc, path.join(outRoot, "host"));
  console.log(`[build-host] host/  ${hostFiles} 个文件`);

  const srcFiles = copyTree(srcSrc, path.join(outRoot, "src"));
  console.log(`[build-host] src/   ${srcFiles} 个文件`);

  const seen = new Set();
  const pkgCount = [];
  for (const name of RUNTIME_ROOTS) {
    const before = seen.size;
    copyClosure(name, seen);
    pkgCount.push(`${name} (+${seen.size - before})`);
  }
  console.log(`[build-host] node_modules: ${seen.size} 个包 — ${pkgCount.join(", ")}`);

  console.log(
    `[build-host] 合计 ${(dirSize(outRoot) / 1024 / 1024).toFixed(1)} MB -> ${path.relative(root, outRoot)}`
  );
}

main();
