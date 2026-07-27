/**
 * Draggable splitters for Quest + IDE:
 * - Columns (left / right)
 * - Rows: IDE bottom panel, Chat composer, Quest composer
 * Widths/heights persisted in localStorage.
 */
(function () {
  const QUEST_KEY = "emsoder.questColumnWidths";
  const IDE_KEY = "emsoder.ideColumnWidths";
  const ROW_KEY = "emsoder.rowHeights";

  const QUEST_DEFAULTS = { left: 280, right: 320 };
  const IDE_DEFAULTS = { left: 260, editor: 420 };
  const ROW_DEFAULTS = {
    bottom: 220,
    chatComposer: 140,
    questComposer: 120,
  };

  const QUEST_LIMITS = {
    left: { min: 200, max: 520 },
    right: { min: 220, max: 560 },
  };
  const IDE_LIMITS = {
    left: { min: 180, max: 480 },
    editor: { min: 280, max: 900 },
  };
  const ROW_LIMITS = {
    bottom: { min: 100, max: 560 },
    chatComposer: { min: 96, max: 360 },
    questComposer: { min: 88, max: 320 },
  };

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function isQuestShell() {
    return document.getElementById("app")?.classList.contains("quest-shell");
  }

  function load(key, defaults, limits) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return { ...defaults };
      const j = JSON.parse(raw);
      const out = { ...defaults };
      for (const k of Object.keys(defaults)) {
        if (j[k] != null && limits[k]) {
          out[k] = clamp(
            Number(j[k]) || defaults[k],
            limits[k].min,
            limits[k].max
          );
        }
      }
      return out;
    } catch {
      return { ...defaults };
    }
  }

  function save(key, w) {
    try {
      localStorage.setItem(key, JSON.stringify(w));
    } catch {
      /* ignore */
    }
  }

  function applyQuest(w) {
    const root = document.documentElement;
    root.style.setProperty("--quest-left", `${w.left}px`);
    root.style.setProperty("--quest-right", `${w.right}px`);
  }

  function applyIde(w) {
    const root = document.documentElement;
    root.style.setProperty("--side-width", `${w.left}px`);
    root.style.setProperty("--editor-width", `${w.editor}px`);
  }

  function applyRows(h) {
    const root = document.documentElement;
    root.style.setProperty("--bottom-height", `${h.bottom}px`);
    root.style.setProperty("--chat-composer-height", `${h.chatComposer}px`);
    root.style.setProperty("--quest-composer-height", `${h.questComposer}px`);
  }

  function syncBottomResizerVisibility() {
    const bottom = document.getElementById("bottomPanel");
    const handle = document.getElementById("resizeBottom");
    if (!handle) return;
    const collapsed = bottom?.classList.contains("collapsed");
    const hide = isQuestShell() || collapsed;
    handle.classList.toggle("disabled", !!hide);
  }

  function init() {
    const questW = load(QUEST_KEY, QUEST_DEFAULTS, QUEST_LIMITS);
    const ideW = load(IDE_KEY, IDE_DEFAULTS, IDE_LIMITS);
    const rows = load(ROW_KEY, ROW_DEFAULTS, ROW_LIMITS);
    applyQuest(questW);
    applyIde(ideW);
    applyRows(rows);
    syncBottomResizerVisibility();

    const leftHandle = document.getElementById("resizeLeft");
    const rightHandle = document.getElementById("resizeRight");
    const bottomHandle = document.getElementById("resizeBottom");
    const chatCompHandle = document.getElementById("resizeChatComposer");
    const questCompHandle = document.getElementById("resizeQuestComposer");

    /** @type {null | { kind: string, handle: HTMLElement, startY?: number, startH?: number }} */
    let drag = null;

    function onMove(ev) {
      if (!drag) return;
      const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
      const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
      const main = document.getElementById("mainLayout");
      if (!main) return;
      const rect = main.getBoundingClientRect();
      const rail = 52;
      const resizer = 5;

      if (drag.kind === "col-left" || drag.kind === "col-right") {
        if (isQuestShell()) {
          if (drag.kind === "col-left") {
            const next = clamp(
              clientX - rect.left - rail,
              QUEST_LIMITS.left.min,
              Math.min(
                QUEST_LIMITS.left.max,
                rect.width - rail - questW.right - 120
              )
            );
            questW.left = Math.round(next);
            applyQuest(questW);
          } else {
            const next = clamp(
              rect.right - clientX,
              QUEST_LIMITS.right.min,
              Math.min(
                QUEST_LIMITS.right.max,
                rect.width - rail - questW.left - 120
              )
            );
            questW.right = Math.round(next);
            applyQuest(questW);
          }
        } else {
          if (drag.kind === "col-left") {
            const next = clamp(
              clientX - rect.left - rail,
              IDE_LIMITS.left.min,
              Math.min(
                IDE_LIMITS.left.max,
                rect.width - rail - ideW.editor - resizer * 2 - 200
              )
            );
            ideW.left = Math.round(next);
            applyIde(ideW);
          } else {
            const next = clamp(
              rect.right - clientX,
              IDE_LIMITS.editor.min,
              Math.min(
                IDE_LIMITS.editor.max,
                rect.width - rail - ideW.left - resizer * 2 - 200
              )
            );
            ideW.editor = Math.round(next);
            applyIde(ideW);
          }
        }
      } else if (drag.kind === "row-bottom") {
        const center = document.getElementById("centerCol");
        if (!center) return;
        const cRect = center.getBoundingClientRect();
        // bottom panel height from bottom of center-col
        const next = clamp(
          cRect.bottom - clientY,
          ROW_LIMITS.bottom.min,
          Math.min(ROW_LIMITS.bottom.max, cRect.height - 100)
        );
        rows.bottom = Math.round(next);
        applyRows(rows);
      } else if (drag.kind === "row-chat-composer") {
        const chat = document.getElementById("chatPanel");
        if (!chat) return;
        const cRect = chat.getBoundingClientRect();
        const next = clamp(
          cRect.bottom - clientY,
          ROW_LIMITS.chatComposer.min,
          Math.min(ROW_LIMITS.chatComposer.max, cRect.height - 100)
        );
        rows.chatComposer = Math.round(next);
        applyRows(rows);
      } else if (drag.kind === "row-quest-composer") {
        const panel = document.getElementById("questPanel");
        if (!panel) return;
        const pRect = panel.getBoundingClientRect();
        const next = clamp(
          pRect.bottom - clientY,
          ROW_LIMITS.questComposer.min,
          Math.min(ROW_LIMITS.questComposer.max, pRect.height - 120)
        );
        rows.questComposer = Math.round(next);
        applyRows(rows);
      }

      if (ev.cancelable) ev.preventDefault();
    }

    function onUp() {
      if (!drag) return;
      drag.handle.classList.remove("dragging");
      document.body.classList.remove("col-resizing");
      document.body.classList.remove("row-resizing");
      drag = null;
      save(QUEST_KEY, questW);
      save(IDE_KEY, ideW);
      save(ROW_KEY, rows);
      window.dispatchEvent(
        new CustomEvent("emsoder:columns-resized", {
          detail: {
            quest: { ...questW },
            ide: { ...ideW },
            rows: { ...rows },
          },
        })
      );
      try {
        window.EmsoderEditor?.layout?.();
        window.EmsoderPanels?.resizeTerm?.();
      } catch {
        /* ignore */
      }
    }

    function start(kind, handle, ev) {
      if (kind.startsWith("col-") || kind.startsWith("row-")) {
        // ok
      }
      if (kind === "row-bottom" && handle.classList.contains("disabled")) {
        return;
      }
      drag = { kind, handle };
      handle.classList.add("dragging");
      if (kind.startsWith("row-")) {
        document.body.classList.add("row-resizing");
      } else {
        document.body.classList.add("col-resizing");
      }
      if (ev.cancelable) ev.preventDefault();
    }

    function bind(handle, kind) {
      if (!handle) return;
      handle.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        start(kind, handle, e);
      });
      handle.addEventListener(
        "touchstart",
        (e) => start(kind, handle, e),
        { passive: false }
      );
    }

    bind(leftHandle, "col-left");
    bind(rightHandle, "col-right");
    bind(bottomHandle, "row-bottom");
    bind(chatCompHandle, "row-chat-composer");
    bind(questCompHandle, "row-quest-composer");

    window.addEventListener("mousemove", onMove, { passive: false });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchend", onUp);
    window.addEventListener("blur", onUp);

    // double-click reset per handle
    leftHandle?.addEventListener("dblclick", () => {
      if (isQuestShell()) {
        questW.left = QUEST_DEFAULTS.left;
        applyQuest(questW);
        save(QUEST_KEY, questW);
      } else {
        ideW.left = IDE_DEFAULTS.left;
        applyIde(ideW);
        save(IDE_KEY, ideW);
      }
    });
    rightHandle?.addEventListener("dblclick", () => {
      if (isQuestShell()) {
        questW.right = QUEST_DEFAULTS.right;
        applyQuest(questW);
        save(QUEST_KEY, questW);
      } else {
        ideW.editor = IDE_DEFAULTS.editor;
        applyIde(ideW);
        save(IDE_KEY, ideW);
      }
    });
    bottomHandle?.addEventListener("dblclick", () => {
      rows.bottom = ROW_DEFAULTS.bottom;
      applyRows(rows);
      save(ROW_KEY, rows);
      try {
        window.EmsoderPanels?.resizeTerm?.();
      } catch {
        /* ignore */
      }
    });
    chatCompHandle?.addEventListener("dblclick", () => {
      rows.chatComposer = ROW_DEFAULTS.chatComposer;
      applyRows(rows);
      save(ROW_KEY, rows);
    });
    questCompHandle?.addEventListener("dblclick", () => {
      rows.questComposer = ROW_DEFAULTS.questComposer;
      applyRows(rows);
      save(ROW_KEY, rows);
    });

    function refreshTitles() {
      if (leftHandle) {
        leftHandle.title = isQuestShell()
          ? "拖动调整左栏（任务板）宽度"
          : "拖动调整资源管理器宽度";
      }
      if (rightHandle) {
        rightHandle.title = isQuestShell()
          ? "拖动调整右栏（计划/Changes）宽度"
          : "拖动调整编辑器宽度";
      }
      if (bottomHandle) {
        bottomHandle.title = "拖动调整底部面板高度 · 双击恢复默认";
      }
      if (chatCompHandle) {
        chatCompHandle.title = "拖动调整 Chat 输入区高度 · 双击恢复默认";
      }
      if (questCompHandle) {
        questCompHandle.title = "拖动调整 Quest 输入区高度 · 双击恢复默认";
      }
      syncBottomResizerVisibility();
    }
    refreshTitles();

    const app = document.getElementById("app");
    if (app && typeof MutationObserver !== "undefined") {
      new MutationObserver(refreshTitles).observe(app, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }
    const bottom = document.getElementById("bottomPanel");
    if (bottom && typeof MutationObserver !== "undefined") {
      new MutationObserver(syncBottomResizerVisibility).observe(bottom, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }

    window.EmsoderResize = {
      getWidths: () => ({
        quest: { ...questW },
        ide: { ...ideW },
        rows: { ...rows },
      }),
      setQuestWidths: (w) => {
        if (w.left != null) {
          questW.left = clamp(
            w.left,
            QUEST_LIMITS.left.min,
            QUEST_LIMITS.left.max
          );
        }
        if (w.right != null) {
          questW.right = clamp(
            w.right,
            QUEST_LIMITS.right.min,
            QUEST_LIMITS.right.max
          );
        }
        applyQuest(questW);
        save(QUEST_KEY, questW);
      },
      setIdeWidths: (w) => {
        if (w.left != null) {
          ideW.left = clamp(w.left, IDE_LIMITS.left.min, IDE_LIMITS.left.max);
        }
        if (w.editor != null) {
          ideW.editor = clamp(
            w.editor,
            IDE_LIMITS.editor.min,
            IDE_LIMITS.editor.max
          );
        }
        applyIde(ideW);
        save(IDE_KEY, ideW);
      },
      setRowHeights: (h) => {
        if (h.bottom != null) {
          rows.bottom = clamp(
            h.bottom,
            ROW_LIMITS.bottom.min,
            ROW_LIMITS.bottom.max
          );
        }
        if (h.chatComposer != null) {
          rows.chatComposer = clamp(
            h.chatComposer,
            ROW_LIMITS.chatComposer.min,
            ROW_LIMITS.chatComposer.max
          );
        }
        if (h.questComposer != null) {
          rows.questComposer = clamp(
            h.questComposer,
            ROW_LIMITS.questComposer.min,
            ROW_LIMITS.questComposer.max
          );
        }
        applyRows(rows);
        save(ROW_KEY, rows);
      },
      syncBottomResizerVisibility,
      reset: () => {
        Object.assign(questW, QUEST_DEFAULTS);
        Object.assign(ideW, IDE_DEFAULTS);
        Object.assign(rows, ROW_DEFAULTS);
        applyQuest(questW);
        applyIde(ideW);
        applyRows(rows);
        save(QUEST_KEY, questW);
        save(IDE_KEY, ideW);
        save(ROW_KEY, rows);
      },
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
