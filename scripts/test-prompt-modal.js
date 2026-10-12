#!/usr/bin/env node
/* Source-level regression guard for the in-app prompt: environment/key actions
 * must use EmsoderDom.showPrompt rather than unreliable native window.prompt. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const dom = fs.readFileSync(path.join(root, "renderer", "js", "dom-util.js"), "utf8");
const env = fs.readFileSync(path.join(root, "renderer", "js", "modules", "env-side.js"), "utf8");
const app = fs.readFileSync(path.join(root, "renderer", "js", "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
assert.ok(html.includes('id="modalPrompt"'), "prompt modal markup exists");
assert.ok(dom.includes("function showPrompt("), "showPrompt helper exists");
assert.ok(dom.includes('input.type = type === "password" ? "password" : "text"'), "password input supported");
assert.ok(dom.includes('event.key === "Escape"'), "Escape cancels prompt");
assert.ok(dom.includes('event.key === "Enter"'), "Enter submits prompt");
assert.ok(env.includes("EmsoderDom.showPrompt"), "environment actions use in-app prompt");
assert.ok(!/\bprompt\s*\(/.test(env), "environment module has no native prompt call");
assert.ok(app.includes("EmsoderDom.showPrompt"), "assistant edit uses in-app prompt");
console.log("OK in-app prompt modal guards environment and assistant editing flows");
