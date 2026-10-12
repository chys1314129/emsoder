/**
 * End-to-end chat-flow test: send one message and count the chat bubbles.
 *
 * Why this exists: the Tauri tunnel initially delivered each push to every window
 * instead of the single window Electron addressed, so the renderer showed two
 * copies of every message while a reply streamed and then healed itself on
 * completion. That is a *rendering* symptom of a *transport* bug, so proving it
 * fixed needs a test that actually sends a message and counts what the user sees.
 *
 * Self-contained: it builds a throwaway config directory (with a scratch
 * workspace, since the app refuses to send without one), launches the app against
 * it, drives the real composer, samples the DOM mid-stream and after, then shuts
 * everything down and deletes the directory. The model is a local mock speaking
 * OpenAI's SSE dialect, so it costs nothing and never touches a real provider —
 * and because the whole run is confined to the temp directory, your own config,
 * sessions and API keys are never read or written.
 *
 * Run: node scripts/test-chat-flow.js
 */
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const root = path.join(__dirname, "..");
/** Point at the release build with EMSODER_EXE to test what users actually run. */
const EXE = process.env.EMSODER_EXE
  ? path.resolve(root, process.env.EMSODER_EXE)
  : path.join(root, "src-tauri", "target", "debug", "emsoder.exe");
const CDP_PORT = Number(process.env.CDP_PORT || 9231);
const MOCK_PORT = Number(process.env.MOCK_LLM_PORT || 8799);
const CHUNKS = ["你", "好", "，", "我", "是", "本", "地", "假", "模", "型", "。"];
const CHUNK_DELAY_MS = 260;

let failures = 0;
const fail = (m) => {
  console.error(`FAIL  ${m}`);
  failures += 1;
};
const pass = (m) => console.log(`  ok  ${m}`);

// ---------------------------------------------------------------------------
// Mock model (in-process)
// ---------------------------------------------------------------------------
let mockHits = 0;
const mockLog = [];

function startMockServer() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url.includes("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "mock-model", object: "model" }] }));
        return;
      }
      mockHits += 1;
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* keep {} */
      }
      mockLog.push({
        url: req.url,
        model: parsed.model,
        stream: parsed.stream,
        messages: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
        tools: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
      });
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      let i = 0;
      const tick = setInterval(() => {
        if (i >= CHUNKS.length) {
          clearInterval(tick);
          res.write(
            `data: ${JSON.stringify({
              id: "mock",
              object: "chat.completion.chunk",
              model: "mock-model",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: CHUNKS.length, total_tokens: 1 + CHUNKS.length },
            })}\n\n`
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.write(
          `data: ${JSON.stringify({
            id: "mock",
            object: "chat.completion.chunk",
            model: "mock-model",
            choices: [{ index: 0, delta: { content: CHUNKS[i++] }, finish_reason: null }],
          })}\n\n`
        );
      }, CHUNK_DELAY_MS);
      // Clear on the *response* closing, not the request: an incoming request
      // emits 'close' as soon as its body has been read, which would kill the
      // timer after the first chunk and leave the stream open forever — the app
      // then waits for a reply that never ends.
      res.on("close", () => clearInterval(tick));
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server)));
}

// ---------------------------------------------------------------------------
// CDP
// ---------------------------------------------------------------------------
function cdpTargets() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: CDP_PORT, path: "/json/list", timeout: 5000 }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve(JSON.parse(b)));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("超时")));
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    let id = 0;
    const pending = new Map();
    const pageConsole = [];
    ws.on("open", () => {
      ws.send(JSON.stringify({ id: ++id, method: "Runtime.enable" }));
      ws.send(JSON.stringify({ id: ++id, method: "Log.enable" }));
      resolve({
        /** Page-side console output and uncaught errors — where a swallowed
         *  exception inside an app event handler shows up. */
        console: pageConsole,
        evaluate(expression, timeoutMs = 60000) {
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
            }, timeoutMs);
          });
        },
        close: () => ws.close(),
      });
    });
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = (msg.params.args || [])
          .map((a) => a.value ?? a.description ?? a.type)
          .join(" ");
        pageConsole.push(`[${msg.params.type}] ${text}`.slice(0, 300));
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        pageConsole.push(`[exception] ${d.text} ${d.exception?.description || ""}`.slice(0, 300));
      }
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) return entry.rej(new Error(msg.error.message));
      const details = msg.result?.exceptionDetails;
      if (details) {
        return entry.rej(
          new Error(`页面内抛错: ${details.text} ${details.exception?.description || ""}`.trim())
        );
      }
      entry.res(msg.result?.result?.value);
    });
  });
}

/** Poll a page expression until it is truthy. */
async function waitUntil(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(expression).catch((e) => `ERR ${e.message}`);
    if (last === true) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${label}（最后取值：${JSON.stringify(last)}）`);
}

/**
 * The CDP target exists as soon as the document does, which is before the page's
 * scripts have run — evaluating then finds no `window.emsoder`. Wait for the
 * bridge to actually be there.
 */
async function waitForBridge(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await cdp
      .evaluate(`typeof window.emsoder === 'object' && typeof window.emsoder.getConfig === 'function'`)
      .catch(() => false);
    if (ready) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("等待渲染层桥就绪超时（window.emsoder 始终不存在）");
}

async function waitForTarget(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await cdpTargets();
      const page = list.find(
        (t) => t.type === "page" && /^https?:\/\/tauri\.localhost\//.test(t.url) && !/ball\.html/.test(t.url)
      );
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error("等待主窗口页面超时");
}

/** What the user sees: children of #messages, classified by role. */
const COUNT_EXPR = `(() => {
  const box = document.querySelector('#messages');
  if (!box) return { error: '找不到 #messages' };
  const kids = [...box.children].filter((el) => !el.classList.contains('welcome'));
  const texts = kids.map((el) => (el.innerText || '').slice(0, 60));
  return {
    total: kids.length,
    users: texts.filter((t) => /USER/i.test(t)).length,
    assistants: texts.filter((t) => /ASSISTANT/i.test(t)).length,
    busy: !document.querySelector('#runIndicator')?.hidden,
  };
})()`;
const COUNT_BUBBLES = COUNT_EXPR;

/**
 * Sample the bubble counts from inside the page for the whole turn.
 *
 * The duplicate-bubble symptom was transient: the Pi backend buffers a reply and
 * then delivers the whole event burst at once, so the doubled delivery was
 * visible only for a moment. Sampling from Node over CDP would miss it, so the
 * page samples itself every 120 ms and the test looks at the *maximum*.
 */
const START_SAMPLER = `(() => {
  window.__samples = [];
  window.__sampler && clearInterval(window.__sampler);
  const count = () => { const c = ${COUNT_EXPR}; window.__samples.push(c); return c; };
  count();
  window.__sampler = setInterval(count, 120);
  return true;
})()`;

const STOP_SAMPLER = `(() => {
  window.__sampler && clearInterval(window.__sampler);
  window.__sampler = null;
  const s = window.__samples || [];
  const max = (key) => s.reduce((m, c) => Math.max(m, c && c[key] != null ? c[key] : 0), 0);
  const withBubbles = s.filter((c) => c && (c.total || 0) > 0);
  return {
    samples: s.length,
    maxUsers: max('users'),
    maxAssistants: max('assistants'),
    maxTotal: max('total'),
    // The state at the first moment *any* bubble existed — the "right after the
    // burst" view the user described as duplicated.
    firstSeen: withBubbles.length ? withBubbles[0] : null,
    last: s.length ? s[s.length - 1] : null,
  };
})()`;

// ---------------------------------------------------------------------------
// Throwaway environment
// ---------------------------------------------------------------------------
function makeTempEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "emsoder-chatflow-"));
  const userData = path.join(base, "userdata");
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "readme.txt"), "scratch workspace\n", "utf8");

  // A pre-seeded config: the app refuses to send without a workspace, and driving
  // the native folder picker is not something a headless test can do.
  fs.writeFileSync(
    path.join(userData, "emsoder-config.json"),
    JSON.stringify(
      {
        lastWorkspace: workspace,
        agentBackend: "pi",
        activeProviderId: "mock",
        activeModel: "mock-model",
        providers: [
          {
            id: "mock",
            name: "Mock",
            type: "openai",
            baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
            apiKey: "mock",
            models: ["mock-model"],
            enabled: true,
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );
  return { base, userData, workspace };
}

/** Start the app against the throwaway config and return a cleanup handle. */
function launchApp(env) {
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      EMSODER_USER_DATA: env.userData,
      EMSODER_DEBUG: '1',
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr = [];
  child.stderr.on("data", (d) => stderr.push(String(d)));
  return { child, stderr: () => stderr.join("") };
}

/** Windows keeps a directory busy for a moment after the owner exits. */
async function removeDirWithRetry(dir, attempts = 15) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      if (i === attempts - 1) {
        console.warn(`  --  临时目录暂时删不掉（${err.code}），保留在 ${dir}`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return false;
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error(`找不到 ${EXE}\n请先构建：cd src-tauri && cargo build`);
    process.exit(1);
  }

  const env = makeTempEnv();
  const mock = await startMockServer();
  const app = launchApp(env);
  let cdp = null;
  let exited = false;
  app.child.on("exit", () => (exited = true));

  console.log(`临时环境: ${env.base}`);
  console.log(`  配置目录: ${env.userData}`);
  console.log(`  工作区  : ${env.workspace}`);
  console.log(`本地假模型: http://127.0.0.1:${MOCK_PORT}/v1（零成本、不联网）\n`);

  let primaryError = null;
  try {
    const page = await waitForTarget();
    cdp = await connect(page.webSocketDebuggerUrl);
    await waitForBridge(cdp);
    pass("应用已启动，渲染层桥就绪");

    // Prove we are on the throwaway config before sending anything.
    const state = await cdp.evaluate(`(async () => {
      const c = await window.emsoder.getConfig();
      return { workspace: c.lastWorkspace || '', model: c.activeModel, backend: c.agentBackend };
    })()`);
    if (!state.workspace || !state.workspace.toLowerCase().includes("emsoder-chatflow-")) {
      fail(`当前工作区不是临时目录（${state.workspace}），拒绝继续，以免影响你的真实配置`);
      throw new Error("aborted");
    }
    pass(`确认使用临时配置：工作区=${state.workspace}`);
    pass(`模型就绪：model=${state.model} backend=${state.backend}`);

    // Clicking before the app has finished its own init makes sendMessage bail
    // out ("还没模型。先点服务商。") and open the providers modal instead of sending.
    await waitUntil(
      cdp,
      `(() => { const s = window.EmsoderState && window.EmsoderState.state;
         return !!(s && s.config && s.config.activeModel && s.workspace && document.querySelector('#input')); })()`,
      25000,
      "等待应用状态就绪（activeModel + workspace + 输入框）超时"
    );
    await cdp.evaluate(`(() => {
      // If a modal is somehow open, get it out of the way before typing.
      for (const el of document.querySelectorAll('.modal-backdrop, .modal-mask, #providersModal, #settingsModal')) {
        if (el && el.offsetParent !== null) el.style.display = 'none';
      }
      return true;
    })()`);
    pass("应用状态就绪（模型与工作区均已装入）");

    const before = await cdp.evaluate(COUNT_BUBBLES);
    pass(`发送前气泡数：${before?.total}（用户 ${before?.users} / 助手 ${before?.assistants}）`);
    if (before?.total !== 0) fail(`新会话不应该是空的：有 ${before?.total} 个气泡`);

    // Count the agent event stream itself. Bubbles are rendered from these
    // events, so "no bubbles" is either "no events" or "events ignored".
    await cdp.evaluate(`(() => {
      window.__evTypes = [];
      window.__evOff = window.emsoder.onAgentEvent((e) => {
        if (window.__evTypes.length < 200) window.__evTypes.push((e && e.type) || 'unknown');
      });
      return true;
    })()`);

    // Sample from inside the page for the whole turn (the duplicate was transient).
    await cdp.evaluate(START_SAMPLER);

    // Type into the real composer and click the real button.
    const typed = await cdp.evaluate(`(() => {
      const ta = document.querySelector('#input');
      if (!ta) return 'no-textarea';
      ta.focus();
      ta.value = '你好';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = document.querySelector('#btnSend');
      if (!btn) return 'no-button';
      btn.click();
      return 'sent';
    })()`);
    if (typed !== "sent") {
      fail(`发送动作失败：${typed}`);
      throw new Error("aborted");
    }
    pass("已在真实输入框输入并点击发送");

    // Wait for the turn to finish, sampling from inside the page throughout.
    let after = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      after = await cdp.evaluate(COUNT_BUBBLES);
      if (after?.assistants >= 1 && !after?.busy) break;
    }
    const sampled = await cdp.evaluate(STOP_SAMPLER);
    console.log(
      `  回合结束：气泡 ${after?.total}（用户 ${after?.users} / 助手 ${after?.assistants}）busy=${after?.busy}`
    );
    console.log(
      `  整个过程采样 ${sampled?.samples} 次（每 120ms）：用户最多 ${sampled?.maxUsers} 个、` +
        `助手最多 ${sampled?.maxAssistants} 个、气泡总数最多 ${sampled?.maxTotal} 个`
    );
    if (sampled?.firstSeen) {
      console.log(`  气泡刚出现时：${JSON.stringify(sampled.firstSeen)}`);
    }

    const events = await cdp.evaluate(`(() => {
      const t = window.__evTypes || [];
      const counts = {};
      for (const x of t) counts[x] = (counts[x] || 0) + 1;
      window.__evOff && window.__evOff();
      return { total: t.length, counts };
    })()`);
    console.log(`  agent:event 事件：共 ${events?.total} 条 ${JSON.stringify(events?.counts)}`);
    if (events?.total === 0) fail("渲染层一条 agent:event 都没收到 —— 推流没到页面");
    else pass("agent:event 推流到达渲染层");

    // The symptom the user reported: two copies while the reply arrives.
    if (sampled?.maxUsers === 1) pass("全程用户气泡峰值 1 个（没有出现重复框）");
    else fail(`全程用户气泡峰值 ${sampled?.maxUsers} 个，应为 1 —— 这就是重复框问题`);

    if (sampled?.maxAssistants === 1) pass("全程助手气泡峰值 1 个（没有出现重复框）");
    else fail(`全程助手气泡峰值 ${sampled?.maxAssistants} 个，应为 1 —— 这就是重复框问题`);

    if (after?.users === 1 && after?.assistants === 1) pass("回合结束：1 用户 + 1 助手");
    else fail(`回合结束后气泡不一致：用户 ${after?.users} / 助手 ${after?.assistants}`);

    const assistantText = await cdp.evaluate(
      `(() => { const b = document.querySelectorAll('#messages > *'); for (const el of b) { if (/ASSISTANT/i.test(el.innerText||'')) return el.innerText.replace(/\\s+/g,' ').slice(0,80); } return ''; })()`
    );
    if (assistantText && assistantText.includes("本地假模型")) pass(`流式内容完整：${assistantText}`);
    else fail(`助手内容不完整：${JSON.stringify(assistantText)}`);

    // When nothing rendered, find out where the messages actually are instead of
    // guessing at selectors.
    if ((after?.total ?? 0) === 0) {
      const dom = await cdp.evaluate(`(() => {
        const box = document.querySelector('#messages');
        const anyMsg = [...document.querySelectorAll('*')].filter((el) =>
          /msg|message|bubble|chat-item/i.test(el.className || '')
        ).slice(0, 8).map((el) => ({
          tag: el.tagName,
          cls: String(el.className).slice(0,40),
          id: el.id || '',
          text: (el.innerText||'').replace(/\\s+/g,' ').slice(0,40),
          // where it actually lives, to stop guessing at selectors
          path: (() => { const p=[]; let n=el; while(n && n!==document.body){ p.unshift(n.id ? '#'+n.id : n.className ? '.'+String(n.className).split(' ')[0] : n.tagName); n=n.parentElement; } return p.slice(-4).join('>'); })(),
          visible: !!(el.offsetParent || el.getClientRects().length),
        }));
        const st = window.EmsoderState && window.EmsoderState.state;
        return {
          messagesHTML: box ? box.outerHTML.slice(0, 300) : '(no #messages)',
          descendants: box ? box.querySelectorAll('*').length : -1,
          candidates: anyMsg,
          statusText: document.querySelector('#statusText')?.textContent,
          runText: document.querySelector('#runIndicatorText')?.textContent,
          stateMessages: Array.isArray(st?.messages) ? st.messages.length : typeof st?.messages,
          stateGenerating: st?.generating,
          stateActiveSession: st?.activeSessionId,
          stateKeys: st ? Object.keys(st).length : -1,
        };
      })()`);
      console.log("\n  DOM 诊断：");
      if (cdp.console.length) {
        console.log("    页面控制台/异常:");
        for (const line of cdp.console.slice(-25)) console.log("      " + line);
      } else {
        console.log("    页面控制台/异常：（无输出）");
      }
      console.log("    #messages 后代元素数:", dom?.descendants);
      console.log("    状态栏:", JSON.stringify(dom?.statusText));
      console.log("    渲染层状态: messages=" + dom?.stateMessages, "generating=" + dom?.stateGenerating, "session=" + JSON.stringify(dom?.stateActiveSession), "state字段数=" + dom?.stateKeys);
      for (const c of dom?.candidates || []) {
        console.log(`    元素 ${c.tag}.${c.cls} id=${c.id || "-"} 可见=${c.visible} 位置=${c.path} 文本=${JSON.stringify(c.text)}`);
      }
      console.log("    #messages HTML:", (dom?.messagesHTML || "").slice(0, 200));
      const errLines = app.stderr().split("\n").filter((l) => l.trim()).slice(-20);
      console.log("    宿主 stderr 末尾:");
      for (const l of errLines) console.log("      " + l.slice(0, 200));

      // The host writes its own log next to the config — that is where agent,
      // session and sidecar trouble shows up.
      try {
        const logText = fs.readFileSync(path.join(env.userData, "emsoder.log"), "utf8");
        const lines = logText.split("\n").filter((l) => l.trim()).slice(-18);
        console.log("    宿主日志 (emsoder.log) 末尾:");
        for (const l of lines) console.log("      " + l.slice(0, 220));
      } catch (err) {
        console.log("    (读不到宿主日志: " + err.message + ")");
      }
    }
  } catch (err) {
    primaryError = err;
  } finally {
    // Report before cleaning up: a Windows directory-in-use error here used to
    // replace the real failure and send the reader chasing the wrong thing.
    const noise = app
      .stderr()
      .split("\n")
      .filter((l) => /EISDIR|Error|失败|抛错/.test(l) && !/\[tunnel\]/.test(l));
    if (noise.length) console.log(`\n宿主 stderr 中的异常行:\n  ${noise.slice(0, 8).join("\n  ")}`);
    if (primaryError) console.log(`\n真正的失败原因: ${primaryError.message}`);
    console.log(`\n假模型收到 ${mockHits} 次请求${mockLog.length ? "：" + JSON.stringify(mockLog.slice(0, 3)) : "（说明请求根本没到模型）"}`);

    if (cdp) cdp.close();
    // Ask the app to close the way a user would, then force it if it lingers.
    try {
      const list = await cdpTargets();
      const page = list.find((t) => t.type === "page" && /tauri\.localhost/.test(t.url));
      if (page) {
        await connect(page.webSocketDebuggerUrl)
          .then((c) => c.evaluate(`window.emsoder.allowClose()`))
          .catch(() => {});
      }
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 20 && !exited; i++) await new Promise((r) => setTimeout(r, 300));
    if (!exited) app.child.kill();
    mock.close();
    if (process.env.KEEP_TEMP === "1") console.log(`保留临时目录供检查：${env.base}`);
    else await removeDirWithRetry(env.base);
  }

  if (primaryError) {
    console.log(failures === 0 ? "\n测试中断（见上面的失败原因）" : `\n聊天气泡检查失败（${failures} 项）`);
    process.exitCode = 1;
    return;
  }
  console.log(failures === 0 ? "\n聊天气泡检查通过" : `\n聊天气泡检查失败（${failures} 项）`);
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  if (err.message !== "aborted") console.error("测试失败:", err.message);
  process.exit(1);
});
