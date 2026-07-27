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

  function toast(text, isError = false) {
    // Prefer app-owned toast if present
    if (global.EmsoderApp?.toast && global.EmsoderApp.toast !== toast) {
      return global.EmsoderApp.toast(text, isError);
    }
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
        resolve(result);
      }
      function onOk() { cleanup(true); }
      function onCancel() { cleanup(false); }
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
    });
  }

  global.EmsoderDom = {
    $,
    escapeHtml,
    basename,
    toast,
    openModal,
    closeModal,
    formatTok,
    showCtxMenu,
    hideCtxMenu,
    copyText,
    showConfirm,
  };
})(typeof window !== "undefined" ? window : globalThis);
