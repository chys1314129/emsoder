/* EmsoderMention: @-mention file picker for the chat input.
   Depends on: EmsoderState (state, $), emsoder (walkFiles/readFile), EmsoderDom (toast).
   Self-contained: all mention functions call each other; inputEl via $("input"). */
(() => {
  const { state, $ } = EmsoderState;
  const toast = (...a) => EmsoderDom.toast(...a);
  const inputEl = $("input");

  let _mentionCachePromise = null;

  async function loadMentionCache() {
    if (_mentionCachePromise) return _mentionCachePromise;
    _mentionCachePromise = emsoder.walkFiles({ maxFiles: 600 }).then((r) => {
      const all = [
        ...(r.dirs || []).map((d) => ({ ...d, icon: "📁" })),
        ...(r.files || []).map((f) => ({ ...f, icon: "📄" })),
      ];
      // sort: dirs first, then by path
      all.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.path.localeCompare(b.path);
      });
      state.mention.cache = all;
      state.mention.ts = Date.now();
      return all;
    }).catch(() => {
      _mentionCachePromise = null;
      return [];
    });
    return _mentionCachePromise;
  }

  function escapeMentionHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function highlightMatch(text, query) {
    if (!query) return escapeMentionHtml(text);
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return escapeMentionHtml(text);
    return (
      escapeMentionHtml(text.slice(0, idx)) +
      `<span class="mhl">${escapeMentionHtml(text.slice(idx, idx + query.length))}</span>` +
      escapeMentionHtml(text.slice(idx + query.length))
    );
  }

  async function showMentionPopup(searchText) {
    const m = state.mention;
    if (!m.cache || Date.now() - m.ts > 120_000) {
      await loadMentionCache();
    }
    const items = (m.cache || []).filter((f) => {
      if (!searchText) return true;
      const q = searchText.toLowerCase();
      return f.path.toLowerCase().includes(q);
    }).slice(0, 30);
    if (!items.length) {
      hideMentionPopup();
      return;
    }
    m.items = items;
    m.visible = true;
    m.searchText = searchText;
    m.index = Math.min(m.index, items.length - 1);
    renderMentionList();
    $("mentionPopup").hidden = false;
  }

  function hideMentionPopup() {
    const m = state.mention;
    m.visible = false;
    m.items = [];
    m.index = 0;
    m.searchText = "";
    m.triggerPos = -1;
    $("mentionPopup").hidden = true;
  }

  function renderMentionList() {
    const m = state.mention;
    const list = $("mentionList");
    list.innerHTML = "";
    m.items.forEach((f, i) => {
      const el = document.createElement("div");
      el.className = "mention-item" + (i === m.index ? " active" : "");
      el.innerHTML = `<span class="micon">${f.icon || "📄"}</span><span class="mpath">${highlightMatch(f.path, m.searchText)}</span>`;
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        selectMentionAt(i);
      });
      list.appendChild(el);
    });
    // scroll active into view
    const active = list.children[m.index];
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function selectMentionAt(index) {
    const m = state.mention;
    const item = m.items[index];
    if (!item) return;
    // Replace @text from trigger position in textarea
    const pos = m.triggerPos;
    if (pos >= 0) {
      const v = inputEl.value;
      const cursor = inputEl.selectionStart || 0;
      const prefix = v.slice(0, pos);
      const suffix = v.slice(cursor);
      const ref = "@" + item.path + " ";
      inputEl.value = prefix + ref + suffix;
      const newPos = pos + ref.length;
      inputEl.selectionStart = inputEl.selectionEnd = newPos;
    }
    hideMentionPopup();
    inputEl.focus();
  }

  function detectAtTrigger() {
    const v = inputEl.value;
    const cursor = inputEl.selectionStart;
    if (cursor == null) return;
    // find the @ before cursor
    let pos = -1;
    for (let i = cursor - 1; i >= 0; i--) {
      if (v[i] === "@" && (i === 0 || /\s/.test(v[i - 1]) || v[i - 1] === "\n")) {
        pos = i;
        break;
      }
      if (/\s/.test(v[i]) || v[i] === "\n") break;
    }
    if (pos < 0) { hideMentionPopup(); return; }
    const search = v.slice(pos + 1, cursor);
    // ignore @ only (no search) if cursor just typed @ - show after 1ms debounce
    if (search.includes(" ")) { hideMentionPopup(); return; }
    state.mention.triggerPos = pos;
    showMentionPopup(search);
  }

  // @ 引用：单文件与合计上限，避免一次塞爆模型上下文（buildAttachmentPayload 另有 120k 切片）
  const AT_MENTION_MAX_CHARS = 80000;
  const AT_MENTION_MAX_TOTAL = 200000;
  const AT_MENTION_MAX_FILES = 12;

  /** Parse @path references from text, read files, return attachment-style objects. */
  async function resolveAtMentions(text) {
    if (!text || !state.workspace) return [];
    const re = /(?:^|\s)@([^\s@]+)/g;
    const paths = new Set();
    let m;
    while ((m = re.exec(text)) !== null) {
      const p = m[1].trim();
      if (p && !p.startsWith("@") && p.length > 1 && p.length < 300) {
        paths.add(p);
      }
    }
    if (!paths.size) return [];
    const results = [];
    let totalChars = 0;
    let skippedLarge = 0;
    const root = state.workspace.replace(/[/\\]+$/, "");
    for (const rel of paths) {
      if (results.length >= AT_MENTION_MAX_FILES) {
        skippedLarge++;
        break;
      }
      if (totalChars >= AT_MENTION_MAX_TOTAL) {
        skippedLarge++;
        break;
      }
      try {
        // Windows 下 / 亦可；统一去掉 rel 前导分隔，避免 // 或 \\
        const cleanRel = String(rel).replace(/^[/\\]+/, "").replace(/\\/g, "/");
        const abs = root + "/" + cleanRel;
        let content = await emsoder.readFile(abs);
        if (typeof content !== "string") continue;
        if (content.includes("\u0000")) continue;
        const origLen = content.length;
        let truncated = false;
        const room = Math.max(0, AT_MENTION_MAX_TOTAL - totalChars);
        const cap = Math.min(AT_MENTION_MAX_CHARS, room);
        if (content.length > cap) {
          content =
            content.slice(0, cap) +
            "\n\n/* … 已截断：原 " +
            origLen +
            " 字符，本次仅附带前 " +
            cap +
            " 字符（@ 引用上限）… */\n";
          truncated = true;
        }
        totalChars += content.length;
        results.push({
          kind: "text",
          path: cleanRel,
          name: cleanRel.split("/").pop() || cleanRel,
          size: origLen,
          content,
          truncated,
        });
      } catch {
        /* file unreadable */
      }
    }
    if (skippedLarge > 0 && results.length) {
      // 在首条 meta 上不污染 content；调用方可 toast，这里轻量提示一次
      try {
        toast(
          "@ 引用已达上限（单文件 " +
            AT_MENTION_MAX_CHARS +
            " / 合计 " +
            AT_MENTION_MAX_TOTAL +
            " / 最多 " +
            AT_MENTION_MAX_FILES +
            " 个），部分文件未附带全文",
          false
        );
      } catch {
        /* toast 未就绪时忽略 */
      }
    }
    return results;
  }

  /** Drop the cached file list so the next popup re-reads the workspace. */
  function invalidateCache() {
    _mentionCachePromise = null;
    state.mention.ts = 0;
  }

  window.EmsoderMention = {
    loadMentionCache,
    showMentionPopup,
    hideMentionPopup,
    renderMentionList,
    selectMentionAt,
    detectAtTrigger,
    resolveAtMentions,
    invalidateCache,
  };
})();
