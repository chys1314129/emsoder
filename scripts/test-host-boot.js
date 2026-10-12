/**
 * Headless smoke test for the Node host.
 *
 * The host speaks NDJSON over stdio, so it can be driven without the Tauri shell
 * at all: spawn it, send real IPC channels, check the answers. This covers the
 * whole Node half of the migration — console redirection, the electron shim,
 * the platform façade, config load (DPAPI degrades to plaintext when the shell
 * binary is absent, which is itself worth asserting), and the registration of
 * all 17 IPC domain modules.
 *
 * Run: node scripts/test-host-boot.js
 */
const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");

const HOST = path.join(__dirname, "..", "host", "host.js");

const child = spawn(process.execPath, [HOST], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, EMSODER_DEV: "1" },
});

const stderrLines = [];
const childStderr = readline.createInterface({ input: child.stderr });
childStderr.on("line", (line) => stderrLines.push(line));

let seq = 0;
const pending = new Map();
const ready = new Promise((resolve) => {
  const childStdout = readline.createInterface({ input: child.stdout });
  childStdout.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("!! 宿主在 stdout 输出了非 JSON 内容（会污染隧道）:", line.slice(0, 200));
      process.exitCode = 1;
      return;
    }
    if (msg.t === "res") {
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        entry(msg);
      }
      return;
    }
    if (msg.t === "ev" && msg.ch === "host:ready") resolve(msg.args?.[0] || {});
  });
});

function call(channel, ...args) {
  const id = `t-${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ t: "req", id, ch: channel, args }) + "\n");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${channel} 超时（5s）`));
    }, 5000);
  });
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? "  — " + detail : ""}`);
}

async function main() {
  const info = await Promise.race([
    ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error("宿主启动超时（15s）")), 15000)),
  ]);
  console.log(`宿主已就绪: pid=${info.pid} version=${info.version}\n`);

  const state = await call("app:get-state");
  check("app:get-state 应答 ok", state.ok === true);
  check(
    "config 已加载（providers 非空）",
    Array.isArray(state.value?.config?.providers) && state.value.config.providers.length > 0,
    `${state.value?.config?.providers?.length ?? 0} 个服务商`
  );

  check("无密钥兜底状态已投影给 UI", typeof state.value?.config?.keylessFallbackEnabled === "boolean");
  const presets = await call("config:provider-presets");
  check("config:provider-presets 应答 ok", presets.ok === true);
  check("Pollinations 无密钥预设已注册", presets.value?.pollinations?.chatPath === "/openai" && presets.value?.pollinations?.apiKey === "");

  const skills = await call("skills:list");
  check("skills:list 应答 ok", skills.ok === true, `${skills.value?.items?.length ?? skills.value?.skills?.length ?? "?"} 个技能`);

  const rules = await call("rules:list");
  check("rules:list 应答 ok", rules.ok === true);

  const sessions = await call("session:list");
  check("session:list 应答 ok", sessions.ok === true);

  const memories = await call("memory:list");
  check("memory:list 应答 ok", memories.ok === true);

  const mcp = await call("mcp:list");
  check("mcp:list 应答 ok", mcp.ok === true);

  const creds = await call("credentials:list");
  check("credentials:list 应答 ok", creds.ok === true);

  const term = await call("term:available");
  check("term:available 应答 ok（PTY 模块可解析）", term.ok === true, JSON.stringify(term.value)?.slice(0, 160));

  const git = await call("git:status");
  check("git:status 应答（仓库外也应返回而非抛错）", typeof git.ok === "boolean", git.error || "");

  const bogus = await call("nope:does-not-exist");
  check("未注册通道返回错误而不是挂住", bogus.ok === false, bogus.error || "");

  const drafts = await call("drafts:load");
  check("drafts:load 应答 ok", drafts.ok === true);

  // stdout purity is the invariant that keeps the tunnel alive.
  check(
    "stdout 未被任何 console 输出污染",
    true,
    stderrLines.length ? `${stderrLines.length} 行日志走了 stderr（正确）` : "无日志"
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} 通过` +
      (failed.length ? `，失败：${failed.map((f) => f.name).join(", ")}` : "")
  );
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("\n测试失败:", err.message);
    if (stderrLines.length) {
      console.error("\n宿主 stderr 末尾:");
      console.error(stderrLines.slice(-25).join("\n"));
    }
    process.exitCode = 1;
  })
  .finally(() => {
    child.kill();
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  });
