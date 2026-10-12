const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const versions = require("./runtime-versions.json");
const { versionInfo } = require("./prepare-runtime");
const forbidden = /^(?:\.env(?:\..*)?|credentials\.json|secrets?\.json|emsoder-(?:config|sessions|memories)\.json|Local State|id_rsa|id_ed25519)$/i;
function files(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) throw new Error(`Symlink not allowed in release resources: ${p}`);
    if (ent.isDirectory()) out.push(...files(p));
    else if (ent.isFile()) out.push(p);
  }
  return out;
}
function validateResources() {
  const needed = ["runtime/host/host.js", "runtime/src/providers/pollinations.js", "agent-runtime/sidecar.mjs", "agent-runtime/protocol.js", "skill-runtime/node/node.exe", "skill-runtime/python/python.exe", "skill-runtime/python/_socket.pyd", "skill-runtime/python/_ssl.pyd", "skill-runtime/bin/python.cmd", "skill-runtime/bin/node.cmd", "skill-runtime/bin/tvly.cmd", "skill-runtime/node_modules/firecrawl-cli/dist/index.js", "skill-runtime/node_modules/mmx-cli/dist/mmx.mjs", "icon.png"];
  for (const rel of needed) if (!fs.existsSync(path.join(root, "resources", rel))) throw new Error(`Missing resource: ${rel}`);
  for (const skill of versions.coreSkills) if (!fs.existsSync(path.join(root, "resources/core-skills", skill, "SKILL.md"))) throw new Error(`Missing core skill: ${skill}`);
  const roots = ["resources/runtime", "resources/agent-runtime", "resources/core-skills", "resources/bundled-skills", "resources/skill-runtime"];
  for (const dir of roots) for (const p of files(path.join(root, dir))) {
    const rel = path.relative(root, p).replace(/\\/g, "/");
    if (forbidden.test(path.basename(p))) throw new Error(`Private file in release: ${rel}`);
    if (/\.(?:pfx|p12|key|pem)$/i.test(p) && !/\/(?:certifi\/cacert\.pem|pip\/_vendor\/certifi\/cacert\.pem)$/i.test(rel)) throw new Error(`Credential-like file in release: ${rel}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "resources/skill-runtime/manifest.json")));
  if (manifest.source !== "clean-ci-downloads" || manifest.runtime.node.version !== versions.node.version || manifest.runtime.python.version !== versions.python.version) throw new Error("Runtime is not the clean pinned CI build");
  const coreManifest = JSON.parse(fs.readFileSync(path.join(root, "resources/bundled-skills/manifest.json")));
  if (coreManifest.count !== 0 || coreManifest.sources?.length) throw new Error("Personal mirrored skills must not enter public release");
  const privatePath = /[A-Z]:\\Users\\[^\\]+|\.zcode[\\/]skills|\.agents[\\/]skills/i;
  if (privatePath.test(JSON.stringify({ manifest, coreManifest }))) throw new Error("Local user path leaked into runtime manifest");
  const pty = path.join(root, "resources/runtime/node_modules/@homebridge/node-pty-prebuilt-multiarch");
  execFileSync(path.join(root, "resources/skill-runtime/node/node.exe"), ["-e", `require(${JSON.stringify(pty)});console.log('Packaged PTY loads')`], { stdio: "inherit" });
  console.log("Release resources validated (no user data or personal skill mirrors)");
}
function collectAssets() {
  validateResources();
  const info = versionInfo();
  const target = path.join(root, "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis");
  const installers = files(target).filter((p) => /-setup\.exe$/i.test(p));
  if (installers.length !== 1) throw new Error(`Expected one NSIS setup installer, got ${installers.length}`);
  const out = path.join(root, "release-assets");
  if (fs.existsSync(out)) throw new Error("release-assets already exists; refusing to include stale artifacts");
  fs.mkdirSync(out);
  const name = `EMSoder-${info.version}-windows-x64-setup.exe`;
  if (fs.statSync(installers[0]).size >= 2 * 1024 ** 3) throw new Error("Installer exceeds GitHub's per-asset size limit");
  fs.copyFileSync(installers[0], path.join(out, name));
  fs.copyFileSync(path.join(root, "LICENSE"), path.join(out, "LICENSE"));
  const metadata = { version: info.version, tag: info.tag, commit: process.env.GITHUB_SHA || "local-unverified", platform: "windows-x64", format: "nsis", runtimes: { node: versions.node.version, python: versions.python.version }, signing: "unsigned", tests: "protocol, UI logic, host/Pi regression and release-executable mock chat", privateSkillMirrorsIncluded: false, limits: ["Third-party model/API quotas apply", "PDF browser-based rendering needs optional Playwright/Chromium", "Review third-party licenses before public distribution"] };
  fs.writeFileSync(path.join(out, "build-info.json"), JSON.stringify(metadata, null, 2));
  const sum = files(out).sort().map((p) => `${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}  ${path.basename(p)}`).join("\n") + "\n";
  fs.writeFileSync(path.join(out, "SHA256SUMS.txt"), sum);
  console.log(`Collected tested installer: ${name}`);
}
module.exports = { files, validateResources, collectAssets };
if (require.main === module) { try { if (process.argv.includes("--collect")) collectAssets(); else if (process.argv.includes("--resources")) validateResources(); else throw new Error("Specify --resources or --collect"); } catch (e) { console.error(e.message); process.exitCode = 1; } }
