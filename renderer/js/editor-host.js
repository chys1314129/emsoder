/* global emsoder, EmsoderMonaco, monaco, EmsoderLsp */
(function () {
  let monacoReady = null;
  let editor = null;
  let currentModel = null;
  let onChange = null;
  let onCursor = null;
  let completeTimer = null;
  let completeProviderDisposable = null;
  let completeSeq = 0;

  async function ensure() {
    if (editor) return editor;
    if (!monacoReady) monacoReady = EmsoderMonaco.load();
    await monacoReady;
    // init built-in TS/JS language service defaults
    try {
      window.EmsoderLsp?.init?.();
    } catch (e) {
      console.warn("lsp init", e);
    }
    const el = document.getElementById("monacoEditor");
    if (!el) throw new Error("#monacoEditor missing");
    const initialTheme =
      document.body.getAttribute("data-theme") === "light"
        ? "emsoder-light"
        : "emsoder-sky";
    editor = monaco.editor.create(el, {
      value: "",
      language: "plaintext",
      theme: initialTheme,
      automaticLayout: true,
      fontSize: 14,
      fontFamily:
        "'Cascadia Code', 'JetBrains Mono', Consolas, 'Courier New', monospace",
      minimap: { enabled: false },
      wordWrap: "off",
      tabSize: 2,
      insertSpaces: true,
      renderLineHighlight: "line",
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: "smooth",
      padding: { top: 8 },
      quickSuggestions: true,
      glyphMargin: true,
      lineNumbersMinChars: 3,
      // LSP-ish UX
      gotoLocation: {
        multiple: "goto",
        multipleDefinitions: "goto",
        multipleReferences: "gotoAndPeek",
      },
      links: true,
      lightbulb: { enabled: true },
      parameterHints: { enabled: true },
      suggestOnTriggerCharacters: true,
      acceptSuggestionOnEnter: "on",
    });
    editor.onDidChangeModelContent(() => {
      if (onChange) onChange(editor.getValue());
      const model = editor.getModel();
      if (model?.uri?.fsPath) {
        window.EmsoderLsp?.updateOpenFile?.(
          model.uri.fsPath,
          editor.getValue()
        );
      }
    });
    editor.onDidChangeCursorPosition((e) => {
      if (onCursor) onCursor(e.position);
    });
    try {
      window.EmsoderLsp?.installEditorActions?.(editor);
    } catch {
      /* ignore */
    }
    // F9 toggle breakpoint
    editor.addCommand(monaco.KeyCode.F9, () => {
      const pos = editor.getPosition();
      const model = editor.getModel();
      if (!pos || !model) return;
      const filePath = model.uri.fsPath || model.uri.path;
      window.EmsoderApp?.toggleBreakpoint?.(filePath, pos.lineNumber);
    });
    editor.onMouseDown((e) => {
      if (
        e.target?.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        e.target?.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
      ) {
        const line = e.target.position?.lineNumber;
        const model = editor.getModel();
        if (!line || !model) return;
        const filePath = model.uri.fsPath || model.uri.path;
        window.EmsoderApp?.toggleBreakpoint?.(filePath, line);
      }
    });
    return editor;
  }

  const bpDecorations = new Map(); // path -> decoration ids

  async function syncBreakpointDecorations(filePath, lines) {
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    const cur =
      (model.uri.fsPath || model.uri.path || "").replace(/\\/g, "/").toLowerCase();
    const key = String(filePath || "").replace(/\\/g, "/").toLowerCase();
    if (cur !== key && filePath) {
      // only decorate active file
      const activePath = model.uri.fsPath || model.uri.path;
      if (
        String(activePath).replace(/\\/g, "/").toLowerCase() !== key
      ) {
        return;
      }
    }
    const decos = (lines || []).map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        glyphMarginClassName: "emsoder-bp-glyph",
        className: "emsoder-bp-line",
        stickiness:
          monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }));
    const old = bpDecorations.get(key) || [];
    const next = editor.deltaDecorations(old, decos);
    bpDecorations.set(key, next);
  }

  function applyConfig(cfg) {
    if (!editor || !cfg) return;
    editor.updateOptions({
      fontSize: cfg.fontSize || 14,
      tabSize: cfg.tabSize || 2,
      wordWrap: cfg.wordWrap || "off",
      minimap: { enabled: !!cfg.minimap },
    });
  }

  async function openDocument({ path, content, language }) {
    await ensure();
    const lang =
      language || EmsoderMonaco.languageFromPath(path) || "plaintext";
    // Prefer path-based file URI so TS worker can resolve relative imports
    let uri;
    try {
      uri = path
        ? monaco.Uri.file(path)
        : monaco.Uri.parse(`inmemory://model/${Date.now()}`);
    } catch {
      uri = monaco.Uri.parse(`inmemory://model/${Date.now()}`);
    }
    let model = monaco.editor.getModel(uri);
    if (model) {
      if (model.getValue() !== (content || "")) model.setValue(content || "");
      if (model.getLanguageId() !== lang) {
        monaco.editor.setModelLanguage(model, lang);
      }
    } else {
      model = monaco.editor.createModel(content || "", lang, uri);
    }
    currentModel = model;
    editor.setModel(model);
    editor.focus();
    if (path) {
      try {
        window.EmsoderLsp?.rememberOpenFile?.(path, content || "");
      } catch {
        /* ignore */
      }
    }
    return { language: lang };
  }

  function getValue() {
    return editor ? editor.getValue() : "";
  }

  function setValue(v, markClean) {
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    model.setValue(v || "");
  }

  function getSelectionText() {
    if (!editor) return "";
    const sel = editor.getSelection();
    if (!sel || sel.isEmpty()) return "";
    return editor.getModel().getValueInRange(sel);
  }

  function getCursorLine() {
    if (!editor) return 1;
    return editor.getPosition()?.lineNumber || 1;
  }

  function getLanguage() {
    const model = editor?.getModel();
    return model ? model.getLanguageId() : "plaintext";
  }

  /** 关闭标签时释放 Monaco model，防止模型无限累积（含语言服务引用） */
  function disposeModel(filePath) {
    if (!filePath) return;
    let uri;
    try {
      uri = monaco.Uri.file(filePath);
    } catch {
      return;
    }
    const model = monaco.editor.getModel(uri);
    if (model) {
      try {
        model.dispose();
      } catch { /* ignore */ }
    }
    try {
      window.EmsoderLsp?.forgetFile?.(filePath);
    } catch { /* ignore */ }
  }

  function revealLine(line) {
    if (!editor) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  }

  function focus() {
    editor?.focus();
  }

  function layout() {
    editor?.layout();
  }

  function setOnChange(fn) {
    onChange = fn;
  }
  function setOnCursor(fn) {
    onCursor = fn;
  }

  async function enableCompletion(enabled, debounceMs) {
    await ensure();
    if (completeProviderDisposable) {
      completeProviderDisposable.dispose();
      completeProviderDisposable = null;
    }
    if (!enabled) return;

    completeProviderDisposable = monaco.languages.registerInlineCompletionsProvider(
      { pattern: "**" },
      {
        provideInlineCompletions: async (model, position, _ctx, token) => {
          return new Promise((resolve) => {
            if (completeTimer) clearTimeout(completeTimer);
            const seq = ++completeSeq;
            completeTimer = setTimeout(async () => {
              if (token.isCancellationRequested || seq !== completeSeq) {
                resolve({ items: [] });
                return;
              }
              try {
                const offset = model.getOffsetAt(position);
                const value = model.getValue();
                const prefix = value.slice(0, offset);
                const suffix = value.slice(offset);
                const res = await emsoder.complete({
                  prefix,
                  suffix,
                  language: model.getLanguageId(),
                });
                // drop stale responses from older keystrokes
                if (
                  seq !== completeSeq ||
                  token.isCancellationRequested ||
                  res?.stale
                ) {
                  resolve({ items: [] });
                  return;
                }
                const text = (res?.text || "").trimEnd();
                if (!text) {
                  resolve({ items: [] });
                  return;
                }
                resolve({
                  items: [
                    {
                      insertText: text,
                      range: new monaco.Range(
                        position.lineNumber,
                        position.column,
                        position.lineNumber,
                        position.column
                      ),
                    },
                  ],
                });
              } catch {
                resolve({ items: [] });
              }
            }, debounceMs || 400);
          });
        },
        freeInlineCompletions: () => {
          completeSeq += 1;
          if (completeTimer) {
            clearTimeout(completeTimer);
            completeTimer = null;
          }
        },
      }
    );
  }

  function replaceSelectionOrAll(next) {
    if (!editor) return;
    const sel = editor.getSelection();
    if (sel && !sel.isEmpty()) {
      editor.executeEdits("emsoder", [
        { range: sel, text: next, forceMoveMarkers: true },
      ]);
    } else {
      const model = editor.getModel();
      const full = model.getFullModelRange();
      editor.executeEdits("emsoder", [
        { range: full, text: next, forceMoveMarkers: true },
      ]);
    }
  }

  function getEditor() {
    return editor;
  }

  window.EmsoderEditor = {
    ensure,
    applyConfig,
    openDocument,
    getValue,
    setValue,
    getSelectionText,
    getCursorLine,
    getLanguage,
    revealLine,
    focus,
    layout,
    disposeModel,
    setOnChange,
    setOnCursor,
    enableCompletion,
    replaceSelectionOrAll,
    getEditor,
    syncBreakpointDecorations,
    languageFromPath: (p) => EmsoderMonaco.languageFromPath(p),
  };
})();
