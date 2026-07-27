/**
 * Repair Windows node-pty native binaries (conpty.node / pty.node).
 * Usage: node scripts/fix-pty.js
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const pkgDir = path.join(
  root,
  "node_modules",
  "@homebridge",
  "node-pty-prebuilt-multiarch"
);

function run(cmd, cwd) {
  console.log(">", cmd);
  execSync(cmd, { cwd, stdio: "inherit", env: process.env, shell: true });
}

function main() {
  if (!fs.existsSync(pkgDir)) {
    console.log("package missing, npm install…");
    run("npm install @homebridge/node-pty-prebuilt-multiarch --save", root);
  }

  const release = path.join(pkgDir, "build", "Release");
  console.log("repairing native addons in", pkgDir);

  // npm install script: check-prebuild || prebuild-install || node-gyp
  run("npm run install", pkgDir);

  const need = ["conpty.node", "pty.node"];
  const missing = need.filter((n) => !fs.existsSync(path.join(release, n)));
  if (missing.length) {
    console.error("still missing:", missing.join(", "));
    console.error("try: npm rebuild @homebridge/node-pty-prebuilt-multiarch");
    process.exit(1);
  }

  console.log("OK files:");
  for (const n of fs.readdirSync(release)) {
    if (n.endsWith(".node") || n.endsWith(".dll") || n.endsWith(".exe")) {
      console.log(" ", n);
    }
  }

  // smoke test under system node
  try {
    run("node scripts/test-pty.js", root);
  } catch {
    console.warn("test-pty.js reported issues; still check Electron app.");
  }

  console.log("\nDone. Fully quit EMSoder and start again (npm start).");
}

main();
