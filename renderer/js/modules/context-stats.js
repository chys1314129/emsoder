/* EmsoderContextStats: statusbar context-window / cache-hit stats UI.
   Depends on: EmsoderState ($), EmsoderDom (formatTok/toast), emsoder. */
(() => {
  const $ = EmsoderState.$;
  const formatTok = (n) => EmsoderDom.formatTok(n);
  const toast = (...a) => EmsoderDom.toast(...a);

  const QUICK_VALUES = [0, 32768, 65536, 128000, 256000, 512000, 1000000, 2000000];
  const MAX_WINDOW = 100_000_000;

  function ensureEditor() {
    let el = document.getElementById("sbCtxEditor");
    if (el) return el;
    el = document.createElement("div");
    el.id = "sbCtxEditor";
    el.className = "sb-ctx-editor";
    el.innerHTML = `
      <div class="sb-ctx-title">上下文窗口容量（tokens）</div>
      <input id="sbCtxInput" type="number" min="0" step="1000" placeholder="0 = 按模型自动" />
      <div class="sb-ctx-quick">
        ${QUICK_VALUES.map((v) => `<button type="button" data-v="${v}">${v === 0 ? "自动" : formatTok(v)}</button>`).join("")}
      </div>
      <div class="sb-ctx-foot">
        <span class="sb-ctx-hint">0 = 按模型自动 · 对全部请求生效 · 占用到自动压缩阈值时任务中会压缩</span>
        <span class="sb-ctx-actions">
          <button type="button" id="sbCtxRefresh" class="link">刷新</button>
          <button type="button" id="sbCtxCancel">取消</button>
          <button type="button" id="sbCtxSave" class="primary">保存</button>
        </span>
      </div>`;
    document.body.appendChild(el);

    const input = $("sbCtxInput");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); saveEditor(); }
      else if (e.key === "Escape") { e.preventDefault(); closeEditor(); }
    });
    for (const b of el.querySelectorAll(".sb-ctx-quick button")) {
      b.addEventListener("click", () => {
        input.value = b.dataset.v;
        input.focus();
        input.select();
      });
    }
    $("sbCtxSave").addEventListener("click", saveEditor);
    $("sbCtxCancel").addEventListener("click", closeEditor);
    $("sbCtxRefresh").addEventListener("click", () => {
      closeEditor();
      EmsoderContextStats.refresh();
    });
    document.addEventListener("mousedown", (e) => {
      // 打开动作发生在 click（晚于 mousedown），所以这里无需"防首次误关"标记：
      // mousedown 时编辑器尚未 open，点编辑器内部/锚点本身也不关闭。
      if (el.classList.contains("open") && !el.contains(e.target) && e.target !== $("sbContext")) {
        closeEditor();
      }
    });
    return el;
  }

  function openEditor() {
    const el = ensureEditor();
    const anchor = $("sbContext");
    const current = EmsoderState.state.config?.contextWindow;
    const input = $("sbCtxInput");
    input.value = Number(current) > 0 ? Math.floor(Number(current)) : 0;
    input.placeholder = `当前自动窗口 ≈ ${formatTok(currentWindowDisplayed())}`;
    el.classList.add("open");
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      const w = el.offsetWidth || 400;
      let left = r.left + r.width / 2 - w / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      el.style.left = `${Math.round(left)}px`;
      el.style.bottom = `${Math.round(window.innerHeight - r.top + 8)}px`;
    }
    setTimeout(() => input.focus(), 0);
  }

  function closeEditor() {
    document.getElementById("sbCtxEditor")?.classList.remove("open");
  }

  function currentWindowDisplayed() {
    // 底栏当前显示的窗口值（tokens），供占位提示使用
    const el = $("sbContext");
    return el?.dataset?.window ? Number(el.dataset.window) : 0;
  }

  async function saveEditor() {
    const input = $("sbCtxInput");
    if (!input) return;
    const raw = String(input.value ?? "").trim();
    if (raw === "") {
      toast("请输入容量值（0 = 按模型自动）", true);
      input.focus();
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      toast("无效数值，请输入非负整数", true);
      input.focus();
      return;
    }
    const v = Math.min(MAX_WINDOW, Math.floor(n));
    try {
      EmsoderState.state.config = await emsoder.updateConfig({ contextWindow: v });
      closeEditor();
      toast(v === 0 ? "上下文窗口已设为自动（按模型判断）" : `上下文窗口已设为 ${formatTok(v)}`);
      EmsoderContextStats.refresh();
    } catch (e) {
      toast(e?.message || e || "保存失败", true);
    }
  }

  function updateContextStatsUI(stats) {
    const ctxEl = $("sbContext");
    const cacheEl = $("sbCache");
    if (!ctxEl && !cacheEl) return;
    if (!stats) {
      if (ctxEl) ctxEl.textContent = "ctx -";
      if (cacheEl) cacheEl.textContent = "cache -";
      return;
    }
    const used = formatTok(stats.usedTokens);
    const win = formatTok(stats.contextWindow);
    const pct = stats.fillPercent != null ? stats.fillPercent : 0;
    if (ctxEl) {
      ctxEl.dataset.window = String(stats.contextWindow || 0);
      ctxEl.textContent = `ctx ${used}/${win} (${pct}%)`;
      ctxEl.classList.toggle("warn", pct >= 70 && pct < 90);
      ctxEl.classList.toggle("danger", pct >= 90);
      ctxEl.title = [
        `上下文窗口: ${stats.usedTokens || 0} / ${stats.contextWindow || 0} tokens`,
        `占用 ${pct}%`,
        stats.model ? `模型: ${stats.model}` : "",
        stats.lastSource ? `来源: ${stats.lastSource}` : "",
        "约 80% 会在任务中自动压缩较早对话；也可点「压缩上下文」",
        "点击可刷新；可在配置里设 contextWindow / modelContextWindows",
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (cacheEl) {
      const avg =
        stats.avgCacheHitPercent != null ? stats.avgCacheHitPercent : 0;
      const samples = stats.samples || 0;
      cacheEl.textContent = samples
        ? `cache ${avg}%`
        : "cache -";
      cacheEl.classList.toggle("good", avg >= 30);
      cacheEl.title = [
        `平均缓存命中率: ${avg}%（近 ${samples} 次请求）`,
        stats.lastCacheHitPercent != null
          ? `上次命中: ${stats.lastCacheHitPercent}%`
          : "",
        stats.cachedTokens
          ? `上次缓存 tokens: ${stats.cachedTokens}`
          : "",
        "有 API usage 时用服务商数据；否则用本地前缀复用估算",
      ]
        .filter(Boolean)
        .join("\n");
    }
  }

  async function refreshContextStats() {
    try {
      const stats = await emsoder.getContextStats();
      updateContextStatsUI(stats);
    } catch {
      /* ignore */
    }
  }

  window.EmsoderContextStats = {
    update: updateContextStatsUI,
    refresh: refreshContextStats,
    openEditor,
    closeEditor,
  };
})();
