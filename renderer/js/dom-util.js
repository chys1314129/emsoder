/* Shared DOM helpers for renderer (loaded before app.js / panels.js / quest.js) */
(function (global) {
  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function basename(p) {
    return String(p || "").split(/[/\\]/).pop() || "";
  }

  function playDoneChime(volume = 1) {
    try {
      // 权威静音：全局声音关闭时任何调用点都直接不发（AudioContext 不理会
      // webContents.setAudioMuted，必须在源头拦截）。
      const cfg = window.EmsoderState?.state?.config;
      if (cfg && cfg.soundEnabled === false) return;
      const vol = Math.max(0, Math.min(1, Number(volume)));
      if (vol <= 0) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = playDoneChime._ctx || (playDoneChime._ctx = new Ctx());
      if (ctx.state === "suspended") ctx.resume();
      const now = ctx.currentTime;
      const beep = (t, freq, dur) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.setValueAtTime(freq, t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(t);
        o.stop(t + dur + 0.02);
      };
      beep(now, 880, 0.11);
      beep(now + 0.11, 1175, 0.16);
    } catch {
      /* ignore */
    }
  }

  function toast(text, isError = false) {
    let el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.toggle("error", !!isError);
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 2800);
  }

  function openModal(id) {
    $(id)?.classList.add("show");
  }

  function closeModal(id) {
    $(id)?.classList.remove("show");
  }

  /** 标准空状态元素：<div class="tree-empty">…</div> */
  function emptyState(text) {
    const el = document.createElement("div");
    el.className = "tree-empty";
    el.textContent = text;
    return el;
  }

  function formatTok(n) {
    const v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (v >= 10000) return Math.round(v / 1000) + "k";
    if (v >= 1000) return (v / 1000).toFixed(1) + "k";
    return String(Math.round(v));
  }

  /**
   * Lightweight context menu at (x,y). items: [{label, run, disabled?, sep?}]
   */
  function showCtxMenu(x, y, items, menuId = "emsoder-ctx-menu") {
    let menu = document.getElementById(menuId);
    if (!menu) {
      menu = document.createElement("div");
      menu.id = menuId;
      menu.className = "ctx-menu";
      document.body.appendChild(menu);
    }
    menu.innerHTML = "";
    for (const it of items || []) {
      if (it.sep) {
        const s = document.createElement("div");
        s.className = "ctx-sep";
        menu.appendChild(s);
        continue;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ctx-item";
      b.textContent = it.label;
      b.disabled = !!it.disabled;
      b.onclick = () => {
        menu.classList.remove("show");
        try {
          it.run?.();
        } catch (e) {
          toast(e.message || e, true);
        }
      };
      menu.appendChild(b);
    }
    const pad = 8;
    menu.style.left =
      Math.min(x, window.innerWidth - 200 - pad) + "px";
    menu.style.top =
      Math.min(y, window.innerHeight - 160 - pad) + "px";
    menu.classList.add("show");
    const hide = () => {
      menu.classList.remove("show");
      document.removeEventListener("click", hide);
    };
    setTimeout(() => document.addEventListener("click", hide), 0);
    return menu;
  }

  function hideCtxMenu(menuId = "emsoder-ctx-menu") {
    document.getElementById(menuId)?.classList.remove("show");
  }

  async function copyText(t, okMsg = "已复制") {
    const s = String(t || "");
    if (!s) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(s);
        toast(okMsg);
        return true;
      }
    } catch {
      /* fall through */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = s;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast(okMsg);
      return true;
    } catch {
      toast("复制失败", true);
      return false;
    }
  }

  /**
   * Styled async confirm dialog — replaces native confirm().
   * Returns a Promise<boolean>. Requires #modalConfirm in the DOM.
   */
  function showConfirm(message) {
    return new Promise((resolve) => {
      const modal = $("modalConfirm");
      const msgEl = $("modalConfirmMsg");
      const okBtn = $("modalConfirmOk");
      const cancelBtn = $("modalConfirmCancel");
      const closeBtn = modal?.querySelector('[data-close="modalConfirm"]');
      if (!modal || !msgEl || !okBtn || !cancelBtn) {
        // Fallback to native if modal not yet in DOM
        resolve(window.confirm(message));
        return;
      }
      msgEl.textContent = message;
      openModal("modalConfirm");
      function cleanup(result) {
        closeModal("modalConfirm");
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        closeBtn?.removeEventListener("click", onClose);
        resolve(result);
      }
      function onOk() { cleanup(true); }
      function onCancel() { cleanup(false); }
      function onClose() { cleanup(false); }
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      closeBtn?.addEventListener("click", onClose);
    });
  }

  /**
   * Styled async text/password prompt. Unlike window.prompt(), this remains
   * visible and predictable in Electron desktop windows.
   * Returns input text, or null on cancel/escape/backdrop.
   */
  function showPrompt({ title = "输入内容", message = "", value = "", type = "text", placeholder = "", confirmText = "保存" } = {}) {
    return new Promise((resolve) => {
      const modal = $("modalPrompt");
      const titleEl = $("modalPromptTitle");
      const msgEl = $("modalPromptMsg");
      const input = $("modalPromptInput");
      const okBtn = $("modalPromptOk");
      const cancelBtn = $("modalPromptCancel");
      const closeBtn = modal?.querySelector('[data-close="modalPrompt"]');
      if (!modal || !titleEl || !msgEl || !input || !okBtn || !cancelBtn) {
        toast("输入窗口未就绪，请重新打开环境变量面板", true);
        resolve(null);
        return;
      }
      titleEl.textContent = title;
      msgEl.textContent = message;
      input.type = type === "password" ? "password" : "text";
      input.value = String(value ?? "");
      input.placeholder = placeholder;
      okBtn.textContent = confirmText;
      openModal("modalPrompt");
      let settled = false;
      function cleanup(result) {
        if (settled) return;
        settled = true;
        closeModal("modalPrompt");
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        closeBtn?.removeEventListener("click", onCancel);
        modal.removeEventListener("mousedown", onBackdrop);
        document.removeEventListener("keydown", onKey, true);
        resolve(result);
      }
      function onOk() { cleanup(input.value); }
      function onCancel() { cleanup(null); }
      function onBackdrop(event) { if (event.target === modal) cleanup(null); }
      function onKey(event) {
        if (event.key === "Escape") { event.preventDefault(); cleanup(null); }
        else if (event.key === "Enter") { event.preventDefault(); cleanup(input.value); }
      }
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      closeBtn?.addEventListener("click", onCancel);
      modal.addEventListener("mousedown", onBackdrop);
      document.addEventListener("keydown", onKey, true);
      setTimeout(() => { input.focus(); input.select(); }, 0);
    });
  }

  global.EmsoderDom = {
    $,
    escapeHtml,
    basename,
    toast,
    playDoneChime,
    openModal,
    closeModal,
    emptyState,
    formatTok,
    showCtxMenu,
    hideCtxMenu,
    copyText,
    showConfirm,
    showPrompt,
  };
})(typeof window !== "undefined" ? window : globalThis);
