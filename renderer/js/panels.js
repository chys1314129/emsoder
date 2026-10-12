/* global emsoder, EmsoderDom */
(function () {
  // ---------- load xterm from node_modules via preload URLs ----------
  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("脚本加载失败: " + url));
      document.head.appendChild(s);
    });
  }

  function loadCss(url) {
    return new Promise((resolve, reject) => {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = url;
      l.onload = () => resolve();
      l.onerror = () => reject(new Error("样式加载失败: " + url));
      document.head.appendChild(l);
    });
  }

  /** Inject UMD source as inline script so exports attach to window even if module globals exist */
  async function injectScriptText(code, label) {
    const wrapped =
      "(function(global){\n" +
      "var module = { exports: {} };\n" +
      "var exports = module.exports;\n" +
      "var define = undefined;\n" +
      code +
      "\n" +
      "var exp = module.exports;\n" +
      "if (exp && typeof exp === 'object') {\n" +
      "  if (exp.Terminal && !global.Terminal) global.Terminal = exp.Terminal;\n" +
      "  if (exp.FitAddon && !global.FitAddon) global.FitAddon = exp;\n" +
      "  if (exp.WebLinksAddon && !global.WebLinksAddon) global.WebLinksAddon = exp;\n" +
      "  for (var k in exp) {\n" +
      "    if (Object.prototype.hasOwnProperty.call(exp, k) && global[k] == null) global[k] = exp[k];\n" +
      "  }\n" +
      "}\n" +
      "})(typeof globalThis !== 'undefined' ? globalThis : window);\n";
    const s = document.createElement("script");
    s.textContent = wrapped;
    s.setAttribute("data-emsoder-lib", label || "xterm");
    document.head.appendChild(s);
  }

  async function loadLibSmart(url, label) {
    // Prefer fetch + inline inject (reliable with Chinese paths / Electron file://)
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const code = await res.text();
      if (!code || code.length < 50) throw new Error("empty script");
      await injectScriptText(code, label);
      return;
    } catch (fetchErr) {
      // Fallback: classic <script src>
      try {
        await loadScript(url);
      } catch (srcErr) {
        throw new Error(
          (label || "lib") +
            " 加载失败: " +
            (fetchErr.message || fetchErr) +
            " / " +
            (srcErr.message || srcErr)
        );
      }
    }
  }

  function resolveTerminalCtor() {
    const g = typeof globalThis !== "undefined" ? globalThis : window;
    return (
      g.Terminal ||
      window.Terminal ||
      (typeof Terminal !== "undefined" ? Terminal : null)
    );
  }

  function resolveFitCtor() {
    const g = typeof globalThis !== "undefined" ? globalThis : window;
    const Fit =
      g.FitAddon ||
      window.FitAddon ||
      (typeof FitAddon !== "undefined" ? FitAddon : null);
    if (!Fit) return null;
    if (typeof Fit === "function") return Fit;
    if (Fit.FitAddon) return Fit.FitAddon;
    return null;
  }

  function resolveWebLinksCtor() {
    const g = typeof globalThis !== "undefined" ? globalThis : window;
    const W =
      g.WebLinksAddon ||
      window.WebLinksAddon ||
      (typeof WebLinksAddon !== "undefined" ? WebLinksAddon : null);
    if (!W) return null;
    if (typeof W === "function") return W;
    if (W.WebLinksAddon) return W.WebLinksAddon;
    return null;
  }

  let xtermReady = null;
  async function ensureXtermLibs() {
    if (resolveTerminalCtor()) return;
    if (xtermReady) return xtermReady;
    const urls = window.emsoder?.xterm;
    if (!urls?.jsUrl) {
      throw new Error(
        "xterm 资源 URL 缺失（preload 未暴露 emsoder.xterm）。请重启应用。"
      );
    }
    xtermReady = (async () => {
      try {
        await loadCss(urls.cssUrl);
      } catch {
        /* css optional for function; terminal still works unstyled-ish */
      }
      await loadLibSmart(urls.jsUrl, "xterm");
      if (!resolveTerminalCtor()) {
        // one more classic load attempt
        await loadScript(urls.jsUrl);
      }
      if (!resolveTerminalCtor()) {
        throw new Error(
          "xterm.js 已加载但未导出 Terminal（可能被页面脚本环境影响）。请重启 EMSoder 或检查 renderer 控制台。"
        );
      }
      try {
        await loadLibSmart(urls.fitUrl, "fit");
      } catch {
        /* fit optional */
      }
      try {
        if (urls.webLinksUrl) await loadLibSmart(urls.webLinksUrl, "web-links");
      } catch {
        /* optional */
      }
    })().catch((err) => {
      xtermReady = null;
      throw err;
    });
    return xtermReady;
  }

  function isLightTheme() {
    return (
      document.body.getAttribute("data-theme") === "light" ||
      document.documentElement.getAttribute("data-theme") === "light"
    );
  }

  function getXtermTheme() {
    if (isLightTheme()) {
      return {
        background: "#fbfaf6",
        foreground: "#1f1e1a",
        cursor: "#0d44a8",
        cursorAccent: "#ffffff",
        selectionBackground: "#0ea5e933",
        black: "#1f1e1a",
        red: "#c5221f",
        green: "#137333",
        yellow: "#b06000",
        blue: "#0d44a8",
        magenta: "#7c3aed",
        cyan: "#0e7490",
        white: "#4a463c",
        brightBlack: "#6b6558",
        brightRed: "#ea4335",
        brightGreen: "#34a853",
        brightYellow: "#b06000",
        brightBlue: "#1a73e8",
        brightMagenta: "#7c3aed",
        brightCyan: "#0e7490",
        brightWhite: "#1f1e1a",
      };
    }
    return {
      background: "#070e18",
      foreground: "#d7e3f4",
      cursor: "#38bdf8",
      cursorAccent: "#041018",
      selectionBackground: "#0ea5e966",
      black: "#0b1220",
      red: "#f87171",
      green: "#34d399",
      yellow: "#fbbf24",
      blue: "#38bdf8",
      magenta: "#c084fc",
      cyan: "#22d3ee",
      white: "#e8eef7",
      brightBlack: "#6d8099",
      brightRed: "#fca5a5",
      brightGreen: "#6ee7b7",
      brightYellow: "#fde68a",
      brightBlue: "#7dd3fc",
      brightMagenta: "#d8b4fe",
      brightCyan: "#67e8f9",
      brightWhite: "#ffffff",
    };
  }

  function applyXtermTheme() {
    try {
      termState.term?.options && (termState.term.options.theme = getXtermTheme());
    } catch {
      /* ignore */
    }
  }

  // ---------- Terminal panel (real PTY + xterm) ----------
  const termState = {
    id: null,
    term: null,
    fit: null,
    host: null,
    ro: null,
    dataUnsub: null,
  };

  function disposeXtermUi() {
    try {
      termState.ro?.disconnect();
    } catch {
      /* ignore */
    }
    termState.ro = null;
    try {
      termState.term?.dispose();
    } catch {
      /* ignore */
    }
    termState.term = null;
    termState.fit = null;
    if (termState.host) termState.host.innerHTML = "";
  }

  async function createPtySession() {
    await ensureXtermLibs();
    termState.host = document.getElementById("xtermHost");
    if (!termState.host) throw new Error("#xtermHost missing");

    disposeXtermUi();

    const TerminalCtor = resolveTerminalCtor();
    if (typeof TerminalCtor !== "function") {
      throw new Error(
        "Terminal is not defined — xterm 前端库未就绪（与 node-pty 无关）。请重启应用；若仍失败请开 DevTools 看 Network 是否加载 xterm.js"
      );
    }

    const term = new TerminalCtor({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        "'Cascadia Code', 'Consolas', 'Courier New', monospace",
      theme: getXtermTheme(),
      allowProposedApi: true,
      scrollback: 5000,
      convertEol: false,
    });

    const FitCtor = resolveFitCtor();
    const fit = FitCtor ? new FitCtor() : null;
    if (fit) term.loadAddon(fit);

    try {
      const WebCtor = resolveWebLinksCtor();
      if (WebCtor) term.loadAddon(new WebCtor());
    } catch {
      /* optional */
    }

    term.open(termState.host);
    if (fit) {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    }

    const dims = fit
      ? fit.proposeDimensions()
      : { cols: term.cols, rows: term.rows };
    const cols = dims?.cols || term.cols || 80;
    const rows = dims?.rows || term.rows || 24;

    const session = await emsoder.termCreate({ cols, rows });
    termState.id = session.id;
    termState.term = term;
    termState.fit = fit;
    try {
      await emsoder.setPreferredPty(session.id);
    } catch {
      /* ignore */
    }

    term.onData((data) => {
      if (termState.id) emsoder.termWrite(termState.id, data);
    });

    // paste support is built-in; focus on click
    termState.host.addEventListener("mousedown", () => term.focus());
    // right-click: copy selection / paste
    termState.host.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const sel = term.getSelection?.() || "";
      let menu = document.getElementById("emsoder-term-ctx");
      if (!menu) {
        menu = document.createElement("div");
        menu.id = "emsoder-term-ctx";
        menu.className = "ctx-menu";
        document.body.appendChild(menu);
      }
      menu.innerHTML = "";
      const mk = (label, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ctx-item";
        b.textContent = label;
        b.onclick = () => {
          menu.classList.remove("show");
          fn();
        };
        menu.appendChild(b);
      };
      mk("复制", async () => {
        const t = sel || "";
        if (!t) return;
        try {
          await navigator.clipboard.writeText(t);
          window.EmsoderApp?.toast?.("已复制");
        } catch {
          /* ignore */
        }
      });
      mk("粘贴", async () => {
        try {
          const t = await navigator.clipboard.readText();
          if (t && termState.id) emsoder.termWrite(termState.id, t);
        } catch {
          window.EmsoderApp?.toast?.("无法读取剪贴板", true);
        }
      });
      mk("清屏", () => term.clear());
      menu.style.left = Math.min(e.clientX, window.innerWidth - 160) + "px";
      menu.style.top = Math.min(e.clientY, window.innerHeight - 120) + "px";
      menu.classList.add("show");
      const hide = () => {
        menu.classList.remove("show");
        document.removeEventListener("click", hide);
      };
      setTimeout(() => document.addEventListener("click", hide), 0);
    });

    if (termState.dataUnsub) termState.dataUnsub();
    termState.dataUnsub = emsoder.onTermData((payload) => {
      if (!payload || payload.id !== termState.id) return;
      if (payload.type === "out" || payload.type === "err") {
        term.write(payload.text || "");
      } else if (payload.type === "exit") {
        term.writeln(payload.text || "\r\n[session ended]");
      }
    });

    // resize observer
    if (typeof ResizeObserver !== "undefined") {
      termState.ro = new ResizeObserver(() => {
        resizeTerm();
      });
      termState.ro.observe(termState.host);
    }

    term.focus();
    resizeTerm();
    return session;
  }

  function resizeTerm() {
    if (!termState.term || !termState.id) return;
    try {
      if (termState.fit) termState.fit.fit();
      emsoder.termResize(termState.id, termState.term.cols, termState.term.rows);
    } catch {
      /* ignore */
    }
  }

  async function ensureTerm() {
    if (termState.id && termState.term) {
      resizeTerm();
      termState.term.focus();
      return termState.id;
    }
    try {
      const avail = await emsoder.termAvailable();
      if (avail && avail.available === false) {
        throw new Error("PTY 不可用");
      }
      const s = await createPtySession();
      return s.id;
    } catch (err) {
      const host = document.getElementById("xtermHost");
      const msg = String(err?.message || err);
      const isXterm =
        /Terminal is not defined|xterm|脚本加载|样式加载/i.test(msg);
      const tip = isXterm
        ? "这是前端 xterm 库加载问题（不是 node-pty）。请完全退出后重新 npm start；或 DevTools → Console 查看报错。"
        : "原生 PTY 缺失时，在 desktop 目录执行：npm run fix-pty ，然后完全退出并重启应用。";
      if (host) {
        host.innerHTML = `<div class="panel-empty">终端启动失败：${escapeHtml(
          msg
        )}<br/><br/>${escapeHtml(tip)}<br/><button class="btn" id="btnTermRetry" style="margin-top:10px">重试</button></div>`;
        host.querySelector("#btnTermRetry")?.addEventListener("click", () => {
          host.innerHTML = "";
          ensureTerm().catch(() => {});
        });
      }
      window.EmsoderApp?.toast?.(msg, true);
      throw err;
    }
  }

  const escapeHtml = (s) =>
    (window.EmsoderDom && EmsoderDom.escapeHtml
      ? EmsoderDom.escapeHtml(s)
      : String(s ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;"));

  async function newTerm() {
    if (termState.id) {
      try {
        await emsoder.termDispose(termState.id);
      } catch {
        /* ignore */
      }
    }
    termState.id = null;
    disposeXtermUi();
    return ensureTerm();
  }

  function initTerminal() {
    document.getElementById("btnTermKill")?.addEventListener("click", async () => {
      if (termState.id) {
        await emsoder.termInterrupt(termState.id);
        // if still alive, hard kill
        setTimeout(() => {
          if (termState.id) emsoder.termKill(termState.id);
        }, 300);
      }
    });
    document.getElementById("btnTermClear")?.addEventListener("click", () => {
      termState.term?.clear();
    });
    document.getElementById("btnTermNew")?.addEventListener("click", () => {
      newTerm();
    });
  }

  // ---------- Git panel ----------
  let gitSelected = null;

  function statusLabel(f) {
    if (f.untracked) return "U";
    return (f.status || "M").trim() || "M";
  }

  async function refreshGit() {
    const list = document.getElementById("gitFileList");
    const branch = document.getElementById("gitBranch");
    const diffEl = document.getElementById("gitDiff");
    if (!list) return;
    list.innerHTML = '<div class="panel-empty">加载中…</div>';
    try {
      const st = await emsoder.gitStatus();
      if (!st.isRepo) {
        branch.textContent = "非 Git 仓库";
        list.innerHTML =
          '<div class="panel-empty">当前工作区不是 Git 仓库，或未打开文件夹。</div>';
        if (diffEl) diffEl.textContent = "";
        return;
      }
      branch.textContent = st.branch || "HEAD";
      if (!st.files?.length) {
        list.innerHTML = '<div class="panel-empty">工作区干净</div>';
        if (diffEl) diffEl.textContent = "";
        return;
      }
      list.innerHTML = "";
      for (const f of st.files) {
        const row = document.createElement("div");
        row.className = "git-row" + (gitSelected === f.path ? " active" : "");
        row.innerHTML = `
          <span class="git-badge">${statusLabel(f)}</span>
          <span class="git-path"></span>
          <span class="git-actions">
            <button data-a="stage" title="暂存">+</button>
            <button data-a="unstage" title="取消暂存">−</button>
            <button data-a="discard" title="丢弃">↺</button>
          </span>`;
        row.querySelector(".git-path").textContent = f.path;
        row.querySelector(".git-path").title = f.path;
        row.addEventListener("click", async (e) => {
          if (e.target.closest("button")) return;
          gitSelected = f.path;
          await refreshGit();
          const d = await emsoder.gitDiff({
            path: f.path,
            staged: f.staged && !f.unstaged,
          });
          if (diffEl) diffEl.textContent = d.diff || "(no diff)";
        });
        row.querySelector('[data-a="stage"]').onclick = async (e) => {
          e.stopPropagation();
          await emsoder.gitStage(f.path);
          await refreshGit();
        };
        row.querySelector('[data-a="unstage"]').onclick = async (e) => {
          e.stopPropagation();
          await emsoder.gitUnstage(f.path);
          await refreshGit();
        };
        row.querySelector('[data-a="discard"]').onclick = async (e) => {
          e.stopPropagation();
          await emsoder.gitDiscard(f.path);
          await refreshGit();
        };
        list.appendChild(row);
      }
    } catch (err) {
      list.innerHTML = `<div class="panel-empty">${err.message || err}</div>`;
    }
  }

  function initGit() {
    document.getElementById("btnGitRefresh")?.addEventListener("click", refreshGit);
    document.getElementById("btnGitCommit")?.addEventListener("click", async () => {
      const msg = document.getElementById("gitCommitMsg")?.value?.trim();
      if (!msg) {
        window.EmsoderApp?.toast?.("请填写提交信息", true);
        return;
      }
      const r = await emsoder.gitCommit(msg);
      if (!r.ok) {
        window.EmsoderApp?.toast?.(r.error || "commit failed", true);
        return;
      }
      document.getElementById("gitCommitMsg").value = "";
      window.EmsoderApp?.toast?.("已提交");
      await refreshGit();
    });
    document.getElementById("btnGenCommit")?.addEventListener("click", async () => {
      try {
        window.EmsoderApp?.toast?.("生成 commit message…");
        const r = await emsoder.genCommitMessage();
        if (r.empty) {
          window.EmsoderApp?.toast?.("没有可提交的更改", true);
          return;
        }
        document.getElementById("gitCommitMsg").value = r.message || "";
      } catch (err) {
        window.EmsoderApp?.toast?.(err.message || err, true);
      }
    });
  }

  // ---------- Bottom panel chrome ----------
  function showBottomTab(name) {
    document.querySelectorAll(".bottom-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.tab === name);
    });
    document.querySelectorAll(".bottom-pane").forEach((p) => {
      p.classList.toggle("hidden", p.dataset.pane !== name);
    });
    if (name === "git") refreshGit();
    if (name === "terminal") {
      ensureTerm()
        .then(() => {
          resizeTerm();
          termState.term?.focus();
        })
        .catch(() => {});
    }
    if (name === "debug") refreshDebugUi();
    if (name === "problems") renderProblems(window.EmsoderLsp?.getProblems?.() || []);
    if (name === "rules") renderRules();
    setTimeout(() => window.EmsoderEditor?.layout?.(), 50);
  }

  // ---------- Debug panel ----------
  const debugState = {
    frames: [],
    consoleEl: null,
  };

  function debugLog(text) {
    if (!debugState.consoleEl) {
      debugState.consoleEl = document.getElementById("debugConsole");
    }
    if (!debugState.consoleEl) return;
    debugState.consoleEl.textContent += text;
    debugState.consoleEl.scrollTop = debugState.consoleEl.scrollHeight;
  }

  async function refreshBreakpointsList() {
    const el = document.getElementById("debugBreakpoints");
    if (!el) return;
    try {
      const r = await emsoder.debugListBreakpoints();
      const bps = r.breakpoints || [];
      if (!bps.length) {
        el.innerHTML = '<div class="panel-empty" style="padding:8px;">无断点 · 编辑器行号旁点 F9</div>';
        return;
      }
      el.innerHTML = "";
      for (const bp of bps) {
        const btn = document.createElement("button");
        btn.className = "debug-item";
        const name = String(bp.path).split(/[/\\]/).pop();
        btn.textContent = `${name}:${bp.line}`;
        btn.title = bp.path;
        btn.onclick = () => {
          window.EmsoderLsp?.onNavigate?.(bp.path, bp.line, 1);
        };
        el.appendChild(btn);
      }
    } catch (err) {
      el.textContent = err.message || err;
    }
  }

  function renderStack(frames) {
    const el = document.getElementById("debugStack");
    if (!el) return;
    debugState.frames = frames || [];
    if (!debugState.frames.length) {
      el.innerHTML = '<div class="panel-empty" style="padding:8px;">未暂停</div>';
      return;
    }
    el.innerHTML = "";
    debugState.frames.forEach((f, idx) => {
      const btn = document.createElement("button");
      btn.className = "debug-item" + (idx === 0 ? " active" : "");
      const name = f.path ? String(f.path).split(/[/\\]/).pop() : f.url || "";
      btn.textContent = `${f.functionName} · ${name}:${f.line}`;
      btn.onclick = () => {
        if (f.path) window.EmsoderLsp?.onNavigate?.(f.path, f.line, f.column || 1);
      };
      el.appendChild(btn);
    });
  }

  async function refreshDebugUi() {
    await refreshBreakpointsList();
    try {
      const st = await emsoder.debugState();
      if (!st.running) {
        renderStack([]);
      }
    } catch {
      /* ignore */
    }
  }

  function initDebug() {
    debugState.consoleEl = document.getElementById("debugConsole");
    emsoder.onDebugEvent((ev) => {
      if (!ev) return;
      if (ev.type === "output") {
        debugLog(ev.text || "");
      } else if (ev.type === "paused") {
        debugLog(`\n[paused] ${ev.reason || ""}\n`);
        renderStack(ev.frames || []);
        const top = (ev.frames || [])[0];
        if (top?.path) {
          window.EmsoderLsp?.onNavigate?.(top.path, top.line, top.column || 1);
        }
        document.getElementById("bottomPanel")?.classList.remove("collapsed");
      } else if (ev.type === "resumed") {
        debugLog("[resumed]\n");
      } else if (ev.type === "exited" || ev.type === "stopped") {
        debugLog(`[${ev.type}] code=${ev.code ?? ""}\n`);
        renderStack([]);
        refreshBreakpointsList();
      } else if (ev.program) {
        debugLog(`[started] ${ev.program}\n`);
      }
    });

    document.getElementById("btnDebugStart")?.addEventListener("click", async () => {
      let program = document.getElementById("debugProgram")?.value?.trim();
      if (!program) {
        // default: active editor if js
        program = window.EmsoderApp?.getActivePath?.() || "";
      }
      if (!program) {
        window.EmsoderApp?.toast?.("请填写要调试的 JS 文件", true);
        return;
      }
      const argsRaw = document.getElementById("debugArgs")?.value?.trim() || "";
      const args = argsRaw ? argsRaw.split(/\s+/).filter(Boolean) : [];
      debugLog(`\n$ node --inspect-brk ${program} ${args.join(" ")}\n`);
      const r = await emsoder.debugLaunch({ program, args });
      if (!r.ok && r.error) {
        window.EmsoderApp?.toast?.(r.error, true);
        debugLog(`[error] ${r.error}\n`);
      } else {
        window.EmsoderApp?.toast?.("调试已启动（inspect-brk）");
      }
    });
    document.getElementById("btnDebugContinue")?.addEventListener("click", () =>
      emsoder.debugContinue()
    );
    document.getElementById("btnDebugPause")?.addEventListener("click", () =>
      emsoder.debugPause()
    );
    document.getElementById("btnDebugStepOver")?.addEventListener("click", () =>
      emsoder.debugStepOver()
    );
    document.getElementById("btnDebugStepInto")?.addEventListener("click", () =>
      emsoder.debugStepInto()
    );
    document.getElementById("btnDebugStepOut")?.addEventListener("click", () =>
      emsoder.debugStepOut()
    );
    document.getElementById("btnDebugStop")?.addEventListener("click", () =>
      emsoder.debugStop()
    );
    document.getElementById("btnDebugEval")?.addEventListener("click", async () => {
      const expression = document.getElementById("debugEval")?.value?.trim();
      if (!expression) return;
      const frameId = debugState.frames[0]?.callFrameId;
      const r = await emsoder.debugEvaluate(expression, frameId);
      if (r.error) debugLog(`[eval error] ${r.error}\n`);
      else debugLog(`[eval] ${expression} => ${JSON.stringify(r.result)}\n`);
    });
  }

  const basename = (p) =>
    window.EmsoderDom?.basename
      ? EmsoderDom.basename(p)
      : String(p || "").split(/[/\\]/).pop() || "";

  function renderProblems(items) {
    const list = document.getElementById("problemsList");
    const summary = document.getElementById("problemsSummary");
    const bottomPanel = document.getElementById("bottomPanel");
    const problemsPane = list?.closest?.('.bottom-pane[data-pane="problems"]');
    const badge = document.getElementById("problemsBadge");
    const sb = document.getElementById("sbProblems");
    if (!list) return;

    const arr = Array.isArray(items) ? items : [];
    let errors = 0;
    let warnings = 0;
    for (const it of arr) {
      if (it.severity === 8) errors++;
      else if (it.severity === 4) warnings++;
    }

    if (summary) {
      summary.textContent = arr.length
        ? `${errors} 错误 · ${warnings} 警告 · 共 ${arr.length}`
        : "暂无问题";
    }
    if (badge) {
      if (errors + warnings > 0) {
        badge.textContent = String(errors + warnings);
        badge.classList.remove("hidden");
        badge.classList.toggle("warn", errors === 0 && warnings > 0);
      } else {
        badge.classList.add("hidden");
      }
    }
    if (sb) {
      sb.textContent =
        errors + warnings > 0
          ? `${errors}E ${warnings}W`
          : "0 问题";
      sb.style.opacity = errors + warnings > 0 ? "1" : "0.75";
    }

    // 诊断数据和统计始终更新；底部面板不可见时跳过列表 DOM 重建，
    // 等用户切到 Problems 标签时由 showBottomTab 统一渲染。
    const visible =
      (!bottomPanel || !bottomPanel.classList.contains("collapsed")) &&
      (!problemsPane || !problemsPane.classList.contains("hidden"));
    if (!visible) return;

    if (!arr.length) {
      list.innerHTML =
        '<div class="panel-empty">没有诊断信息。<br/>打开或索引 TS、JS、CSS、HTML、JSON 文件后会显示。F12 跳转定义。</div>';
      return;
    }

    list.innerHTML = "";
    for (const it of arr.slice(0, 500)) {
      const sev =
        it.severity === 8
          ? "error"
          : it.severity === 4
            ? "warning"
            : "info";
      const row = document.createElement("div");
      row.className = "problem-row";
      row.innerHTML = `
        <span class="problem-sev ${sev}">${sev === "error" ? "Error" : sev === "warning" ? "Warn" : "Info"}</span>
        <span class="problem-msg"></span>
        <span class="problem-loc"></span>`;
      row.querySelector(".problem-msg").textContent = it.message || "";
      row.querySelector(".problem-loc").textContent = `${basename(
        it.path
      )}:${it.startLineNumber}`;
      row.title = it.path || "";
      row.onclick = () => {
        if (window.EmsoderLsp?.onNavigate && it.path) {
          window.EmsoderLsp.onNavigate(it.path, it.startLineNumber, it.startColumn);
        }
      };
      list.appendChild(row);
    }
  }

  async function renderRules() {
    const el = document.getElementById("rulesList");
    if (!el) return;
    try {
      const r = await emsoder.listRules();
      if (!r.files?.length) {
      el.innerHTML = '<div class="panel-empty">未发现项目规则。可添加 AGENTS.md / .emsoder/rules.md / CLAUDE.md</div>';
      } else {
        el.innerHTML = "";
        for (const f of r.files) {
          const item = document.createElement("div");
          item.className = "rules-item";
          const tag = document.createElement("span");
          tag.className = "tag";
          tag.textContent = "RULE";
          item.appendChild(tag);
          item.appendChild(document.createTextNode(" " + f));
          el.appendChild(item);
        }
      }
    } catch (err) {
      el.textContent = err.message || err;
    }
  }

  function initProblems() {
    window.EmsoderLsp?.setProblemsHandler?.((items) => {
      renderProblems(items);
    });
    document.getElementById("btnReindexLsp")?.addEventListener("click", async () => {
      window.EmsoderApp?.toast?.("正在索引工作区源文件…");
      try {
        const r = await window.EmsoderLsp?.indexWorkspace?.(
          (await emsoder.getWorkspace()) || ""
        );
        window.EmsoderApp?.toast?.(
          `索引完成：${r?.count || 0} 个源文件`
        );
        renderProblems(window.EmsoderLsp?.getProblems?.() || []);
      } catch (err) {
        window.EmsoderApp?.toast?.(err.message || err, true);
      }
    });
    document.getElementById("sbProblems")?.addEventListener("click", () => {
      document.getElementById("bottomPanel")?.classList.remove("collapsed");
      showBottomTab("problems");
    });
  }

  function initBottom() {
    initTerminal();
    initGit();
    initDebug();
    initProblems();
    document.querySelectorAll(".bottom-tab").forEach((tab) => {
      tab.addEventListener("click", () => showBottomTab(tab.dataset.tab));
    });
    // 折叠按钮的点击处理在 app.js 里统一绑定（toggleBottom）。
    // 这里不要再绑一次：重复绑定会 toggle 两次相互抵消，导致「面板」按钮看似无效。
  }

  window.EmsoderPanels = {
    init: initBottom,
    showTab: showBottomTab,
    refreshGit,
    ensureTerm,
    resizeTerm,
    renderRules,
    renderProblems,
    refreshDebugUi,
    refreshBreakpointsList,
    getTermId: () => termState.id,
    applyTheme: applyXtermTheme,
  };
})();
