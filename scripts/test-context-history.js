#!/usr/bin/env node
const assert = require("assert");
const { normalizeContextHistory } = require("../src/agent/contextHistory");
const a = (ids) => ({ role: "assistant", content: "calling", tool_calls: ids.map((id) => ({ id, type: "function", function: { name: "x", arguments: "{}" } })) });
const t = (id) => ({ role: "tool", toolCallId: id, toolName: "x", content: "ok" });

let out = normalizeContextHistory([{ role: "user", content: "u" }, a(["a"]), t("a"), { role: "assistant", content: "done" }]);
assert.deepStrictEqual(out.map((m) => m.role), ["user", "assistant", "tool", "assistant"], "complete transaction retained");
out = normalizeContextHistory([{ role: "user", content: "u" }, t("orphan"), { role: "assistant", content: "done" }]);
assert.deepStrictEqual(out.map((m) => m.role), ["user", "assistant"], "orphan tool dropped");
out = normalizeContextHistory([{ role: "user", content: "u" }, a(["a"]), { role: "assistant", content: "next" }]);
assert.deepStrictEqual(out.map((m) => m.role), ["user", "assistant"], "incomplete call transaction dropped");
out = normalizeContextHistory([{ role: "user", content: "u" }, a(["a", "b"]), t("a"), { role: "assistant", content: "next" }]);
assert.deepStrictEqual(out.map((m) => m.role), ["user", "assistant"], "partial multi-call transaction dropped");
out = normalizeContextHistory([{ role: "user", content: "u" }, a(["a"]), t("a"), t("a"), { role: "assistant", content: "next" }]);
assert.deepStrictEqual(out.map((m) => m.role), ["user", "assistant"], "duplicate tool result drops transaction and orphan");
console.log("OK context history normalizes tool transactions safely");
