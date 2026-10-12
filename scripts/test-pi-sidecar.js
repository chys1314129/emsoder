#!/usr/bin/env node
/** Pi sidecar protocol/client smoke tests. */
const assert = require("assert");
const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");
const { METHODS, parseLine, encode, request, notification } = require("../src/pi/protocol");
const { PiSidecarClient } = require("../src/pi/sidecarClient");

function assertProtocol() {
  const msg = request("x", METHODS.health, {});
  const parsed = parseLine(encode(msg));
  assert.deepStrictEqual(parsed, msg);
  assert.strictEqual(parseLine("not-json"), null);
  assert.strictEqual(notification(METHODS.agentEvent, {}).jsonrpc, "2.0");
}

async function healthSmoke() {
  const sidecar = path.join(__dirname, "..", "src", "pi", "sidecar.mjs");
  const child = spawn(process.execPath, [sidecar], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const rl = readline.createInterface({ input: child.stdout });
  const lines = [];
  const line = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sidecar health timeout")), 10000);
    rl.on("line", (raw) => {
      lines.push(parseLine(raw));
      if (lines.at(-1)?.id === "health") { clearTimeout(timer); resolve(lines.at(-1)); }
    });
    child.once("error", reject);
  });
  child.stdin.write(encode(request("health", METHODS.health, {})));
  const result = await line;
  assert.strictEqual(result.result.ok, true);
  assert.strictEqual(result.result.runtimes, 0);
  child.kill();
  rl.close();
}

async function clientSmoke() {
  const client = new PiSidecarClient();
  const h = await client.health();
  assert.strictEqual(h.ok, true);
  assert.strictEqual(h.runtimes, 0);
  const a = await client.status({ sessionId: "missing-a" });
  const b = await client.status({ sessionId: "missing-b" });
  assert.strictEqual(a.status.sessionId, "missing-a");
  assert.strictEqual(b.status.sessionId, "missing-b");
  await client.close();
}

(async () => {
  assertProtocol();
  await healthSmoke();
  await clientSmoke();
  console.log("OK Pi protocol/sidecar smoke test");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
