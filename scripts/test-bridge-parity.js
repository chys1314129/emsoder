/**
 * Guards the load-bearing invariant of the migration: `window.emsoder` must
 * expose exactly the same members in the Tauri build as the Electron preload
 * did. The renderer calls these by bare name, so a missing member is a feature
 * that silently stops working — not a compile error.
 *
 * Compares the top-level keys of
 *   src/preload/preload.js : contextBridge.exposeInMainWorld("emsoder", {...})
 *   renderer/js/tauri-bridge.js : window.emsoder = {...}
 *
 * Run: node scripts/test-bridge-parity.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

/** Top-level keys of the object literal starting at `openBraceIndex`. */
function objectKeys(source, openBraceIndex) {
  const keys = [];
  let depth = 0;
  let i = openBraceIndex;
  let expectKey = false;

  const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
  const isIdent = (c) => /[A-Za-z0-9_$]/.test(c);

  while (i < source.length) {
    const ch = source[i];

    // comments
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // strings / templates
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        i++;
      }
      i++;
      continue;
    }

    if (ch === "{") {
      depth++;
      if (depth === 1) expectKey = true;
      i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) return keys;
      i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "<") {
      // Track parens/brackets/angles only to avoid mistaking nested keys; we do
      // not extract keys from those, but we must skip their contents' braces
      // correctly. Only braces matter for depth, and nested object literals
      // inside () are still depth>1, so nothing to do here.
      i++;
      continue;
    }

    if (depth === 1 && expectKey && isIdentStart(ch)) {
      let j = i;
      while (j < source.length && isIdent(source[j])) j++;
      const name = source.slice(i, j);
      let k = j;
      while (k < source.length && /\s/.test(source[k])) k++;
      // Only `name:` is a key. `name(` would be a call — e.g. the `rpc(...)`
      // inside `getState: () => rpc("app:get-state")` — and must not be counted.
      // Both bridge objects use the `name: value` form exclusively.
      if (source[k] === ":") {
        keys.push(name);
        expectKey = false;
      }
      i = j;
      continue;
    }
    if (depth === 1 && ch === ",") {
      expectKey = true;
      i++;
      continue;
    }
    i++;
  }
  return keys;
}

function extract(source, marker) {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`找不到标记：${marker}`);
  const brace = source.indexOf("{", at + marker.length);
  if (brace < 0) throw new Error(`标记后没有对象字面量：${marker}`);
  return objectKeys(source, brace);
}

function main() {
  const preload = fs.readFileSync(path.join(root, "src", "preload", "preload.js"), "utf8");
  const bridge = fs.readFileSync(path.join(root, "renderer", "js", "tauri-bridge.js"), "utf8");

  const expected = extract(preload, 'exposeInMainWorld("emsoder"');
  const actual = extract(bridge, "window.emsoder =");

  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  const missing = expected.filter((k) => !actualSet.has(k));
  const extra = actual.filter((k) => !expectedSet.has(k));

  console.log(`preload.js  暴露 ${expectedSet.size} 个成员`);
  console.log(`tauri-bridge 暴露 ${actualSet.size} 个成员`);

  let failed = false;
  if (missing.length) {
    failed = true;
    console.log(`\n缺失（渲染层会 crash 或功能静默失效）：`);
    for (const k of missing) console.log(`  - ${k}`);
  }
  if (extra.length) {
    // Extra members are not fatal, but they mean the two bridges have drifted.
    console.log(`\n多出（两边已漂移，请确认是否有意为之）：`);
    for (const k of extra) console.log(`  + ${k}`);
  }
  if (!failed && !extra.length) {
    console.log("\n桥成员完全一致 ✓");
  }
  if (failed) process.exitCode = 1;
}

main();
