/**
 * Windowed virtual list for Chat #messages.
 * Live streaming nodes go into .vlist-live (always mounted at bottom).
 */
(() => {
  const EST = { user: 88, assistant: 120, tool: 48, reasoning: 48, error: 72, default: 80 };
  const OVERSCAN = 6;

  function roleOf(m) {
    if (!m) return "default";
    if (m.role === "tool" || m.role === "reasoning" || m.role === "error") return m.role;
    if (m.role === "user" || m.role === "assistant") return m.role;
    return "default";
  }

  function isToolCallPlaceholderText(text) {
    const t = String(text || "").trim();
    return /^调用工具\s*[:：]/.test(t);
  }

  function estimateHeight(m) {
    const role = roleOf(m);
    // 工具调用与「调用工具: …」占位在 UI 中隐藏，占位高度为 0
    if (role === "tool") return 0;
    if (role === "assistant" && isToolCallPlaceholderText(m?.content)) return 0;
    const base = EST[role] || EST.default;
    const len = String(m.content || "").length;
    if (role === "assistant" || role === "user") {
      return Math.min(480, base + Math.floor(len / 120) * 18);
    }
    return base;
  }

  /**
   * @param {HTMLElement} container #messages
   * @param {{ renderItem: Function }} opts
   */
  function createChatVirtualList(container, opts = {}) {
    const renderItem = opts.renderItem;
    let items = [];
    let heights = [];
    let total = 0;
    let start = 0;
    let end = 0;
    let raf = 0;
    let stickBottom = true;
    let prefix = [0];
    let nodeCache = new Map();

    const top = document.createElement("div");
    top.className = "vlist-spacer vlist-top";
    top.setAttribute("aria-hidden", "true");
    const windowEl = document.createElement("div");
    windowEl.className = "vlist-window";
    const bottom = document.createElement("div");
    bottom.className = "vlist-spacer vlist-bottom";
    bottom.setAttribute("aria-hidden", "true");
    const live = document.createElement("div");
    live.className = "vlist-live";

    function ensureSkeleton() {
      if (container.dataset.vlist === "1") return;
      container.dataset.vlist = "1";
      container.innerHTML = "";
      container.appendChild(top);
      container.appendChild(windowEl);
      container.appendChild(bottom);
      container.appendChild(live);
      container.addEventListener("scroll", onScroll, { passive: true });
    }

    // 高度前缀和：findStart / topH / botH 从 O(n) 降到 O(log n)/O(1)
    function rebuildPrefix() {
      prefix = new Array(heights.length + 1);
      prefix[0] = 0;
      for (let i = 0; i < heights.length; i++) prefix[i + 1] = prefix[i] + heights[i];
    }

    function recomputeTotal() {
      total = prefix[heights.length] ?? 0;
    }

    function measureMounted() {
      const kids = windowEl.children;
      for (let i = 0; i < kids.length; i++) {
        const el = kids[i];
        const idx = Number(el.dataset.vidx);
        if (!Number.isFinite(idx) || idx < 0 || idx >= heights.length) continue;
        const h = el.getBoundingClientRect().height;
        if (h > 8 && Math.abs(h - heights[idx]) > 2) {
          heights[idx] = h;
        }
      }
      rebuildPrefix();
    }

    function findStart(scrollTop) {
      // 二分：最大的 i 使 prefix[i] <= scrollTop
      let lo = 0;
      let hi = heights.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (prefix[mid] <= scrollTop) lo = mid;
        else hi = mid - 1;
      }
      return Math.min(lo, Math.max(0, heights.length - 1));
    }

    // 按 message id 缓存渲染节点：窗口滚动时复用，避免重跑 markdown
    function cachedRender(item, i) {
      const key = item?.id || `i${i}`;
      let node = nodeCache.get(key);
      if (!node) {
        node = renderItem(item, i);
        nodeCache.set(key, node);
      }
      return node;
    }

    function layout() {
      if (!items.length) {
        top.style.height = "0px";
        bottom.style.height = "0px";
        windowEl.innerHTML = "";
        start = 0;
        end = 0;
        return;
      }
      const viewH = container.clientHeight || 400;
      const scrollTop = container.scrollTop;
      let s = findStart(scrollTop);
      s = Math.max(0, s - OVERSCAN);
      let e = s;
      let used = 0;
      while (e < items.length && used < viewH + OVERSCAN * 60) {
        used += heights[e];
        e++;
      }
      e = Math.min(items.length, e + OVERSCAN);

      const topH = prefix[s] || 0;
      const botH = total - (prefix[e] ?? 0);

      const needRebuild = s !== start || e !== end || windowEl.childElementCount !== e - s;
      start = s;
      end = e;
      top.style.height = topH + "px";
      bottom.style.height = botH + "px";

      if (needRebuild) {
        windowEl.innerHTML = "";
        const frag = document.createDocumentFragment();
        for (let i = s; i < e; i++) {
          const node = cachedRender(items[i], i);
          if (!node) continue;
          const el = node.nodeType === 1 ? node : node;
          const wrap = el.closest?.(".msg") || el;
          if (wrap && wrap.classList && wrap.classList.contains("msg")) {
            wrap.dataset.vidx = String(i);
            frag.appendChild(wrap);
          } else if (el) {
            el.dataset.vidx = String(i);
            frag.appendChild(el);
          }
        }
        windowEl.appendChild(frag);
        requestAnimationFrame(() => {
          measureMounted();
          top.style.height = (prefix[start] || 0) + "px";
          bottom.style.height = (total - (prefix[end] ?? 0)) + "px";
        });
      }
    }

    function onScroll() {
      const dist =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      stickBottom = dist < 80;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        layout();
      });
    }

    function setItems(list) {
      ensureSkeleton();
      live.innerHTML = "";
      items = Array.isArray(list) ? list : [];
      heights = items.map((m) => estimateHeight(m));
      nodeCache = new Map();
      rebuildPrefix();
      recomputeTotal();
      if (!items.length) {
        container.dataset.vlist = "";
        container.innerHTML = "";
        return { empty: true };
      }
      stickBottom = true;
      layout();
      scrollToEnd();
      return { empty: false, count: items.length };
    }

    function scrollToEnd() {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
        stickBottom = true;
      });
    }

    /** Scroll so item at index is near the top of the viewport. */
    function scrollToIndex(index) {
      if (!items.length) return false;
      const idx = Math.max(0, Math.min(items.length - 1, Number(index) || 0));
      ensureSkeleton();
      let topH = prefix[idx] || 0;
      stickBottom = false;
      container.scrollTop = Math.max(0, topH - 8);
      layout();
      // second pass after paint so measured heights refine position
      requestAnimationFrame(() => {
        measureMounted();
        const refined = prefix[idx] || 0;
        container.scrollTop = Math.max(0, refined - 8);
        layout();
        const el = windowEl.querySelector(`[data-vidx="${idx}"]`);
        if (el) {
          el.classList.add("toc-flash");
          setTimeout(() => el.classList.remove("toc-flash"), 1200);
        }
      });
      return true;
    }

    function getLiveRoot() {
      ensureSkeleton();
      return live;
    }

    function clear() {
      items = [];
      heights = [];
      total = 0;
      live.innerHTML = "";
      windowEl.innerHTML = "";
      top.style.height = "0px";
      bottom.style.height = "0px";
      container.dataset.vlist = "";
      container.innerHTML = "";
    }

    function isActive() {
      return container.dataset.vlist === "1";
    }

    function onLiveAppend() {
      if (stickBottom) scrollToEnd();
    }

    return {
      setItems,
      scrollToEnd,
      scrollToIndex,
      getLiveRoot,
      clear,
      isActive,
      onLiveAppend,
      layout,
    };
  }

  window.EmsoderChatVirtual = { createChatVirtualList, estimateHeight };
})();
