#!/usr/bin/env node
const assert = require("assert");
const {
  executionEnv,
  augmentProcessEnv,
  imageGenerationEnv,
} = require("../src/tools/skillRuntime");

const cfg = {
  executionEnv: {
    FOO: "bar",
    HTTP_PROXY: "http://127.0.0.1:7890",
    PATH: "bad-path",
    Path: "bad-path-2",
    NODE_OPTIONS: "--require nope",
    MODELSCOPE_API_KEY: "must-not-leak",
    "BAD-NAME": "x",
    VALID_EMPTY: "",
  },
};
const appEnv = executionEnv(cfg);
assert.deepStrictEqual(appEnv, {
  FOO: "bar",
  HTTP_PROXY: "http://127.0.0.1:7890",
  VALID_EMPTY: "",
}, "only validated non-reserved vars survive");

const base = { PATH: "host-path", MODELSCOPE_API_KEY: "host-image-secret", HOST_ONLY: "yes" };
const before = { ...base };
const normal = augmentProcessEnv(base, appEnv);
assert.deepStrictEqual(base, before, "augment never mutates source process env");
assert.strictEqual(normal.FOO, "bar");
assert.strictEqual(normal.HTTP_PROXY, "http://127.0.0.1:7890");
assert.strictEqual(normal.MODELSCOPE_API_KEY, undefined, "image secret absent from ordinary command env");
assert.ok(normal.PATH.includes("host-path"), "runtime preserves inherited PATH");
assert.notStrictEqual(normal.PATH, "bad-path", "user PATH cannot override runtime path");

const imageCfg = { ...cfg, imageGenBackend: "modelscope", imageGenApiKey: "scoped-key" };
const scoped = augmentProcessEnv(base, { ...executionEnv(imageCfg), ...imageGenerationEnv(imageCfg) });
assert.strictEqual(scoped.MODELSCOPE_API_KEY, "scoped-key", "scoped image key overrides ordinary child boundary only");
assert.strictEqual(scoped.FOO, "bar", "execution vars remain available in image child");

assert.deepStrictEqual(executionEnv({ executionEnv: ["bad"] }), {}, "arrays rejected");
assert.deepStrictEqual(executionEnv({ executionEnv: { A: 1, B: true, C: null } }), {}, "non-string values rejected");
console.log("OK execution environment validation, isolation, and precedence");
