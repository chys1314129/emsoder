/**
 * Inspects the running app's webviews over the WebView2 DevTools protocol.
 *
 * The renderer is the one layer that cannot be checked by unit tests: whether the
 * CSP lets Monaco load, whether the bridge is actually present in the page, and
 * whether anything is throwing in the console. This connects to WebView2's
 * remote debugging port and asks the page directly.
 *
 * Usage:
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 emsoder.exe
 *   node scripts/inspect-webview.js [port]
 *
 * Run: node scripts/inspect-webview.js
 */
const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.argv[2] || 9223);

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path, timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("超时")));
  });
}

/** Minimal CDP client: evaluate expressions and collect console/log events. */
function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    let id = 0;
    const pending = new Map();
    const logs = [];

    ws.on("open", () => {
      ws.send(JSON.stringify({ id: ++id, method: "Runtime.enable" }));
      ws.send(JSON.stringify({ id: ++id, method: "Log.enable" }));
      resolve({
        logs,
        evaluate(expression) {
          const msgId = ++id;
          return new Promise((res, rej) => {
            pending.set(msgId, { res, rej });
            ws.send(
              JSON.stringify({
                id: msgId,
                method: "Runtime.evaluate",
                params: { expression, awaitPromise: true, returnByValue: true },
              })
            );
            setTimeout(() => {
              if (pending.delete(msgId)) rej(new Error("evaluate 超时"));
            }, 8000);
          });
        },
        close: () => ws.close(),
      });
    });
    ws.on("error", reject);
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result?.result?.value);
        return;
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = (msg.params.args || [])
          .map((a) => a.value ?? a.description ?? a.type)
          .join(" ");
        logs.push({ kind: "console", level: msg.params.type, text });
      }
      if (msg.method === "Log.entryAdded") {
        const e = msg.params.entry;
        logs.push({ kind: "log", level: e.level, source: e.source, text: e.text });
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        logs.push({
          kind: "exception",
          level: "error",
          text: `${d.text} ${d.exception?.description || ""}`.trim(),
        });
      }
    });
  });
}

const PROBES = {
  "页面 URL": "location.href",
  "DOM 就绪": "document.readyState",
  "DOM 节点数": "document.querySelectorAll('*').length",
  "Tauri 全局": "typeof window.__TAURI__",
  "桥存在": "typeof window.emsoder",
  "桥成员数": "window.emsoder ? Object.keys(window.emsoder).length : 0",
  "主题": "document.body.getAttribute('data-theme')",
  "背景色": "getComputedStyle(document.body).backgroundColor",
  "Monaco 已加载": "!!window.monaco",
  "Monaco 编辑器实例": "document.querySelectorAll('.monaco-editor').length",
  "xterm Terminal": "typeof window.Terminal",
  "xterm FitAddon": "typeof window.FitAddon",
  "聊天列表存在": "!!document.querySelector('#messages, .messages, #chatList')",
  "资源基址": "window.emsoder ? window.emsoder.monaco.vsUrl : 'n/a'",
};

/**
 * Deeper probes that exercise real end-to-end paths from inside the page —
 * sessions, config, skills, and a genuine PTY round trip (which is the only way
 * to prove node-pty works on the bundled node.exe without clicking around).
 */
const FUNCTIONAL_PROBE = `(async () => {
  const out = {};
  const err = (e) => "ERR " + String((e && e.message) || e);

  try {
    const cfg = await window.emsoder.getConfig();
    out.model = cfg.activeModel;
    out.providers = cfg.providers.length;
    out.workspace = cfg.lastWorkspace || "(未设置)";
    out.permissionMode = cfg.permissionMode;
  } catch (e) { out.config = err(e); }

  try {
    const s = await window.emsoder.listSessions();
    out.sessions = Array.isArray(s) ? s.length : Object.keys(s || {}).length;
  } catch (e) { out.sessions = err(e); }

  try {
    const sk = await window.emsoder.listSkills();
    out.skills = Array.isArray(sk) ? sk.length : (sk && sk.items ? sk.items.length : "?");
  } catch (e) { out.skills = err(e); }

  try {
    const avail = await window.emsoder.termAvailable();
    out.ptyAvailable = avail && avail.available;
  } catch (e) { out.ptyAvailable = err(e); }

  // The real test: spawn a PTY, run a command, read the output back through the
  // tunnel, then clean up.
  try {
    const chunks = [];
    const off = window.emsoder.onTermData((d) => {
      if (d && d.type === "out" && d.text) chunks.push(d.text);
    });
    const created = await window.emsoder.termCreate({ cols: 80, rows: 24 });
    let id = created && (created.id || created.termId || created.sessionId);
    if (!id) {
      const list = await window.emsoder.termList();
      const arr = Array.isArray(list) ? list : (list && list.items) || [];
      if (arr.length) id = arr[arr.length - 1].id || arr[arr.length - 1];
    }
    out.ptyId = id || "(无 id)";
    if (id) {
      await new Promise((r) => setTimeout(r, 1500));
      await window.emsoder.termWrite(id, "echo EMSODER_PTY_MARKER\\r");
      await new Promise((r) => setTimeout(r, 2500));
      const joined = chunks.join("");
      out.ptyBytes = joined.length;
      out.ptyMarkerSeen = joined.includes("EMSODER_PTY_MARKER");
      await window.emsoder.termKill(id);
    }
    off();
  } catch (e) { out.pty = err(e); }

  return out;
})()`;

async function probePage(target, functional) {
  const client = await cdp(target.webSocketDebuggerUrl);
  console.log(`\n──── 目标: ${target.title || "(无标题)"}  ${target.url}`);

  for (const [label, expression] of Object.entries(PROBES)) {
    try {
      const value = await client.evaluate(expression);
      console.log(`  ${label.padEnd(16, " ")} ${JSON.stringify(value)}`);
    } catch (err) {
      console.log(`  ${label.padEnd(16, " ")} !! ${err.message}`);
    }
  }

  // The main window is served at the bare origin (`http://tauri.localhost/`), not
  // at `/index.html`; only the ball has a distinct path.
  const isMainWindow = !/ball\.html/.test(target.url || "");
  if (isMainWindow) {
    try {
      const result = await client.evaluate(
        `(async () => {
           try {
             const cfg = await window.emsoder.getConfig();
             return { ok: true, model: cfg.activeModel, providers: cfg.providers.length };
           } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
         })()`
      );
      console.log(`  ${"页面内调用桥".padEnd(16, " ")} ${JSON.stringify(result)}`);
    } catch (err) {
      console.log(`  ${"页面内调用桥".padEnd(16, " ")} !! ${err.message}`);
    }

    if (functional) {
      console.log("  功能探测（会话/配置/技能/PTY）…");
      try {
        const result = await client.evaluate(FUNCTIONAL_PROBE);
        for (const [key, value] of Object.entries(result || {})) {
          console.log(`    ${key.padEnd(16, " ")} ${JSON.stringify(value)}`);
        }
      } catch (err) {
        console.log(`    !! ${err.message}`);
      }
    }

    // Force Monaco to load, then re-check: this is the CSP-sensitive path.
    try {
      const monaco = await client.evaluate(
        `(async () => {
           try {
             if (window.monaco) return { already: true };
             if (!window.EmsoderMonaco) return { error: "EmsoderMonaco 未定义" };
             await window.EmsoderMonaco.load();
             return { loaded: true, version: window.monaco && window.monaco.version };
           } catch (err) { return { error: String(err && err.message || err) }; }
         })()`
      );
      console.log(`  ${"强制加载 Monaco".padEnd(16, " ")} ${JSON.stringify(monaco)}`);
    } catch (err) {
      console.log(`  ${"强制加载 Monaco".padEnd(16, " ")} !! ${err.message}`);
    }
  }

  await new Promise((r) => setTimeout(r, 600));
  if (client.logs.length) {
    console.log("  控制台/日志:");
    for (const entry of client.logs.slice(0, 25)) {
      console.log(`    [${entry.level}${entry.source ? "/" + entry.source : ""}] ${entry.text.slice(0, 400)}`);
    }
  } else {
    console.log("  控制台/日志: （无输出，无 CSP 违规）");
  }
  client.close();
}

async function main() {
  const functional = process.argv.includes("--functional");
  let targets;
  try {
    targets = JSON.parse(await httpGet("/json/list"));
  } catch (err) {
    console.error(
      `无法连接 WebView2 调试端口 ${PORT}：${err.message}\n` +
        `请带调试参数启动应用：\n` +
        `  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=${PORT} src-tauri/target/debug/emsoder.exe`
    );
    process.exit(1);
  }
  const pages = targets.filter((t) => t.type === "page");
  console.log(`发现 ${pages.length} 个页面目标（端口 ${PORT}）${functional ? " — 含功能探测" : ""}`);
  for (const page of pages) await probePage(page, functional);
}

main().catch((err) => {
  console.error("探测失败:", err.message);
  process.exit(1);
});
