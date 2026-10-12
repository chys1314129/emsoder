/** Copy the Pi sidecar JS bundle plus its ESM deps into the packaged resource directory. */
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const src = path.join(root, "src", "pi");
const out = path.join(root, "resources", "agent-runtime");

function copyDir(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
  return true;
}

fs.mkdirSync(out, { recursive: true });
// Sidecar bundle + protocol definition.
for (const name of ["sidecar.mjs", "protocol.js"]) {
  fs.copyFileSync(path.join(src, name), path.join(out, name));
}

// Self-contained Pi deps so the sidecar resolves bare specifiers in the packaged
// build (it runs outside app.asar as a standalone Node process). The heavy
// provider SDKs (openai / anthropic / aws / google) are lazily imported by pi-ai
// and never touched under the EMSoder host-proxy streamFn, so they are excluded.
const deps = [
  path.join("node_modules", "@earendil-works"),
  path.join("node_modules", "typebox"),
  path.join("node_modules", "diff"),
  path.join("node_modules", "ignore"),
  path.join("node_modules", "yaml"),
  path.join("node_modules", "partial-json"),
];
for (const rel of deps) {
  const from = path.join(root, rel);
  const to = path.join(out, "node_modules", rel.replace(/^node_modules[/\\]/, ""));
  if (copyDir(from, to)) fs.mkdirSync(path.dirname(to), { recursive: true });
  else console.warn(`[build-pi-sidecar] missing dep: ${rel}`);
}

console.log(`Pi sidecar + deps copied to ${out}`);
