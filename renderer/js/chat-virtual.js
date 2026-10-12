/**
 * Chat message list (#messages)
 *
 * 不用虚拟列表 spacer（估高误差会导致滚轮「跳很远」）。
 * 改为：原生 overflow 滚动 + 按 message id 复用节点 + 底部 live 区挂流式内容。
 *
 * 滚轮 / 触控板：完全交给浏览器；我们只在「贴底」时自动跟随新内容。
 */
(() => {
  /** 距底部多少像素内视为贴底（继续跟随新消息） */
  const STICK_PX = 96;
  /** 滚轮向上超过该距离则解除贴底 */
  const UNSTICK_PX = 48;

  function isToolCallPlaceholderText(text) {
    const t = String(text || "").trim();
    return /^调用工具\s*[:：]/.test(t);
  }

  function shouldSkipItem(m) {
    if (!m) return true;
    if (m.role === "tool") return true;
    if (m.role === "assistant" && isToolCallPlaceholderText(m.content)) return true;
    return false;
  }

  /**
   * @param {HTMLElement} container #messages
   * @param {{ renderItem: (item: any, index: number) => HTMLElement|null }} opts
   */
  function createChatVirtualList(container, opts = {}) {
    const renderItem = opts.renderItem;
    /** @type {any[]} */
    let items = [];
    /** @type {Map<string, HTMLElement>} */
    let nodeCache = new Map();
    let stickBottom = true;
    let bound = false;
    /** 程序改 scrollTop 时忽略 scroll 事件，避免误判贴底状态 */
    let ignoreScroll = 0;
    let followRaf = 0;
    let wheelLockUntil = 0;

    const history = document.createElement("div");
    history.className = "vlist-history";
    const live = document.createElement("div");
    live.className = "vlist-live";

    function ensureSkeleton() {
      if (container.dataset.vlist === "1") return;
      container.dataset.vlist = "1";
      container.innerHTML = "";
      container.appendChild(history);
      container.appendChild(live);
      bindOnce();
    }

    function bindOnce() {
      if (bound || container.__vlistBound) {
        bound = true;
        return;
      }
      bound = true;
      container.__vlistBound = true;

      // 原生滚动：只更新贴底状态，绝不在 scroll 回调里改 scrollTop
      container.addEventListener(
        "scroll",
        () => {
          if (ignoreScroll > 0) return;
          // 用户刚用滚轮时，以用户意图为准
          const dist = distanceFromBottom();
          if (dist <= STICK_PX) stickBottom = true;
          else if (dist > UNSTICK_PX) stickBottom = false;
        },
        { passive: true }
      );

      // 滚轮：只负责「用户意图」，不改写 delta，不 preventDefault
      container.addEventListener(
        "wheel",
        (e) => {
          // 向上滚 → 立刻解除贴底，后续流式不再拽回底部
          if (e.deltaY < 0) {
            stickBottom = false;
            wheelLockUntil = Date.now() + 400;
          } else if (e.deltaY > 0) {
            // 向下滚到接近底部 → 恢复贴底
            // 用 rAF 等浏览器先应用本次滚动再量距离
            requestAnimationFrame(() => {
              if (distanceFromBottom() <= STICK_PX) stickBottom = true;
            });
          }
        },
        { passive: true }
      );

      // 触控板/触摸：touchmove 向上也解除贴底
      let touchY0 = 0;
      container.addEventListener(
        "touchstart",
        (e) => {
          touchY0 = e.touches?.[0]?.clientY || 0;
        },
        { passive: true }
      );
      container.addEventListener(
        "touchmove",
        (e) => {
          const y = e.touches?.[0]?.clientY || 0;
          if (y - touchY0 > 6) {
            // 手指下拖 = 内容上翻
            stickBottom = false;
            wheelLockUntil = Date.now() + 400;
          }
          touchY0 = y;
        },
        { passive: true }
      );
    }

    function distanceFromBottom() {
      return (
        container.scrollHeight - container.scrollTop - container.clientHeight
      );
    }

    function withScrollQuiet(fn) {
      ignoreScroll += 1;
      try {
        fn();
      } finally {
        // 等浏览器处理完 scroll 事件再恢复
        requestAnimationFrame(() => {
          ignoreScroll = Math.max(0, ignoreScroll - 1);
        });
      }
    }

    function pinToBottom() {
      withScrollQuiet(() => {
        container.scrollTop = container.scrollHeight;
      });
    }

    function scheduleFollow() {
      if (!stickBottom) return;
      if (Date.now() < wheelLockUntil) return;
      if (followRaf) return;
      followRaf = requestAnimationFrame(() => {
        followRaf = 0;
        if (!stickBottom) return;
        if (Date.now() < wheelLockUntil) return;
        pinToBottom();
      });
    }

    function itemKey(m, i) {
      return m?.id ? String(m.id) : `i${i}`;
    }

    function buildNode(m, i) {
      if (shouldSkipItem(m)) return null;
      const key = itemKey(m, i);
      let node = nodeCache.get(key);
      if (node && node.isConnected === false) {
        // 仍可复用 detached 节点
      }
      if (!node) {
        const rendered = renderItem(m, i);
        if (!rendered) return null;
        node = rendered.nodeType === 1 ? rendered : null;
        if (!node) return null;
        const wrap = node.classList?.contains("msg")
          ? node
          : node.closest?.(".msg") || node;
        wrap.dataset.vkey = key;
        wrap.dataset.vidx = String(i);
        nodeCache.set(key, wrap);
        node = wrap;
      } else {
        node.dataset.vidx = String(i);
      }
      return node;
    }

    /**
     * 增量同步 history：尽量复用已有节点顺序，避免整表 innerHTML 清空导致滚动跳动。
     */
    function syncHistory() {
      ensureSkeleton();
      const nextKeys = [];
      const nextNodes = [];
      for (let i = 0; i < items.length; i++) {
        const node = buildNode(items[i], i);
        if (!node) continue;
        nextKeys.push(node.dataset.vkey || itemKey(items[i], i));
        nextNodes.push(node);
      }

      // 丢掉已不存在的缓存
      const keep = new Set(nextKeys);
      for (const [k, el] of nodeCache) {
        if (!keep.has(k)) {
          el.remove();
          nodeCache.delete(k);
        }
      }

      // 按顺序挂到 history：已在正确位置则不动
      let cursor = history.firstChild;
      for (const node of nextNodes) {
        if (cursor === node) {
          cursor = cursor.nextSibling;
          continue;
        }
        if (cursor) {
          history.insertBefore(node, cursor);
        } else {
          history.appendChild(node);
        }
      }
      // 去掉尾部多余（理论上已被 remove）
      while (history.childElementCount > nextNodes.length) {
        history.lastElementChild?.remove();
      }
    }

    function setItems(list) {
      ensureSkeleton();
      live.innerHTML = "";
      items = Array.isArray(list) ? list : [];
      // 全量换会话时清缓存，避免串会话节点
      nodeCache = new Map();
      history.replaceChildren();
      if (!items.length) {
        container.dataset.vlist = "";
        container.innerHTML = "";
        // skeleton 被清掉后下次 ensure 会重建
        return { empty: true };
      }
      syncHistory();
      stickBottom = true;
      // 首帧布局后再贴底，避免图片/字体导致二次跳动
      pinToBottom();
      requestAnimationFrame(() => {
        if (stickBottom) pinToBottom();
      });
      return { empty: false, count: items.length };
    }

    function scrollToEnd() {
      stickBottom = true;
      wheelLockUntil = 0;
      pinToBottom();
      requestAnimationFrame(() => pinToBottom());
    }

    function scrollToIndex(index) {
      if (!items.length) return false;
      const idx = Math.max(0, Math.min(items.length - 1, Number(index) || 0));
      ensureSkeleton();
      // 若 history 还没同步完，先同步
      if (!history.childElementCount) syncHistory();
      stickBottom = false;
      wheelLockUntil = Date.now() + 300;

      let el = history.querySelector(`[data-vidx="${idx}"]`);
      if (!el) {
        const m = items[idx];
        if (m?.id) {
          const key = String(m.id);
          el =
            nodeCache.get(key) ||
            [...history.children].find((n) => n.dataset?.vkey === key) ||
            null;
        }
      }

      if (!el) {
        // 尝试渲染该条
        const node = buildNode(items[idx], idx);
        if (node) {
          history.appendChild(node);
          el = node;
        }
      }
      if (!el) return false;

      withScrollQuiet(() => {
        const top =
          el.offsetTop - history.offsetTop - 8 + (history.offsetTop || 0);
        // offsetTop 相对 offsetParent；更稳：用 getBoundingClientRect 差值
        const cRect = container.getBoundingClientRect();
        const eRect = el.getBoundingClientRect();
        const next = container.scrollTop + (eRect.top - cRect.top) - 8;
        container.scrollTop = Math.max(0, next);
      });
      el.classList.add("toc-flash");
      setTimeout(() => el.classList.remove("toc-flash"), 1200);
      return true;
    }

    function getLiveRoot() {
      ensureSkeleton();
      return live;
    }

    function clear() {
      items = [];
      nodeCache = new Map();
      if (followRaf) {
        cancelAnimationFrame(followRaf);
        followRaf = 0;
      }
      history.replaceChildren();
      live.innerHTML = "";
      container.dataset.vlist = "";
      container.innerHTML = "";
    }

    function isActive() {
      return container.dataset.vlist === "1";
    }

    function isStickBottom() {
      return stickBottom;
    }

    /** 流式追加 / 新气泡：仅贴底时跟随 */
    function onLiveAppend() {
      scheduleFollow();
    }

    function layout() {
      // 兼容旧调用：无 spacer，仅在贴底时跟随
      scheduleFollow();
    }

    return {
      setItems,
      scrollToEnd,
      scrollToIndex,
      getLiveRoot,
      clear,
      isActive,
      isStickBottom,
      onLiveAppend,
      layout,
    };
  }

  // 兼容旧 EST 导出（外部若引用）
  function estimateHeight() {
    return 80;
  }

  window.EmsoderChatVirtual = { createChatVirtualList, estimateHeight };
})();
