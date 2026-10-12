/* global monaco, emsoder, EmsoderEditor */
(function () {
  const state = {
    ready: false,
    indexing: false,
    indexedRoot: "",
    models: new Map(), // path -> model
    extraLibs: [],
    onProblems: null,
    markerSub: null,
    lastProblems: [],
  };

  function toFileUri(filePath) {
    // Monaco on Windows wants file:///C:/...
    let p = String(filePath || "").replace(/\\/g, "/");
    if (/^[A-Za-z]:\//.test(p)) {
      return monaco.Uri.parse("file:///" + p);
    }
    if (p.startsWith("/")) return monaco.Uri.file(p);
    return monaco.Uri.file(p);
  }

  function languageOf(filePath) {
    const ext = String(filePath).split(".").pop().toLowerCase();
    if (ext === "ts" || ext === "tsx") return "typescript";
    if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") {
      return "javascript";
    }
    if (ext === "json") return "json";
    if (ext === "css") return "css";
    if (ext === "scss") return "scss";
    if (ext === "html" || ext === "htm" || ext === "vue" || ext === "svelte") {
      return "html";
    }
    return null;
  }

  function mapTarget(v) {
    const T = monaco.languages.typescript.ScriptTarget;
    const key = String(v || "ES2022").toUpperCase().replace(/^ES/, "ES");
    return (
      T[key] ||
      T[String(v).toUpperCase()] ||
      T.ES2022 ||
      T.Latest
    );
  }

  function mapModule(v) {
    const M = monaco.languages.typescript.ModuleKind;
    const s = String(v || "ESNext");
    const key = s.replace(/-/g, "");
    if (/node16/i.test(s)) return M.Node16 || M.ESNext;
    if (/nodenext/i.test(s)) return M.NodeNext || M.ESNext;
    return M[key] || M[s] || M.ESNext;
  }

  function mapModuleResolution(v) {
    const MR = monaco.languages.typescript.ModuleResolutionKind;
    const s = String(v || "node").toLowerCase();
    if (s === "nodenext") return MR.NodeNext || MR.NodeJs;
    if (s === "node16") return MR.Node16 || MR.NodeJs;
    if (s === "bundler") return MR.Bundler || MR.NodeJs;
    if (s === "classic") return MR.Classic || MR.NodeJs;
    return MR.NodeJs;
  }

  function mapJsx(v) {
    const J = monaco.languages.typescript.JsxEmit;
    const s = String(v || "react-jsx").toLowerCase();
    if (s === "react") return J.React;
    if (s === "react-native") return J.ReactNative;
    if (s === "preserve") return J.Preserve;
    if (s === "react-jsxdev") return J.ReactJSXDev || J.ReactJSX;
    return J.ReactJSX || J.React;
  }

  function buildCompilerOptions(fromTsconfig) {
    const c = fromTsconfig || {};
    return {
      target: mapTarget(c.target),
      allowNonTsExtensions: true,
      moduleResolution: mapModuleResolution(c.moduleResolution),
      module: mapModule(c.module),
      noEmit: true,
      esModuleInterop: c.esModuleInterop !== false,
      allowJs: c.allowJs !== false,
      checkJs: !!c.checkJs,
      jsx: mapJsx(c.jsx),
      allowSyntheticDefaultImports: c.allowSyntheticDefaultImports !== false,
      resolveJsonModule: c.resolveJsonModule !== false,
      isolatedModules: c.isolatedModules !== false,
      skipLibCheck: c.skipLibCheck !== false,
      strict: !!c.strict,
      noImplicitAny: c.noImplicitAny ?? !!c.strict,
      strictNullChecks: c.strictNullChecks ?? !!c.strict,
      experimentalDecorators: !!c.experimentalDecorators,
      emitDecoratorMetadata: !!c.emitDecoratorMetadata,
      baseUrl: c.baseUrl || undefined,
      paths: c.paths || undefined,
      lib: Array.isArray(c.lib) && c.lib.length ? c.lib : ["es2022", "dom"],
    };
  }

  function applyCompilerOptions(fromTsconfig) {
    if (!window.monaco?.languages?.typescript) return;
    const compilerOptions = buildCompilerOptions(fromTsconfig);
    const diagnostics = {
      noSemanticValidation: false,
      noSyntaxValidation: false,
      noSuggestionDiagnostics: true,
    };
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
    monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(diagnostics);
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(diagnostics);
    monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
    monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
    return compilerOptions;
  }

  function configureTsJs() {
    if (!window.monaco?.languages?.typescript) return;
    applyCompilerOptions({});

    // Minimal ambient stubs so common node/globals don't flood errors
    const stubs = [
      {
        name: "emsoder-node-stub.d.ts",
        content: `
declare const process: { env: Record<string, string | undefined>; cwd(): string; platform: string; version: string };
declare const __dirname: string;
declare const __filename: string;
declare const module: { exports: any };
declare const exports: any;
declare const require: NodeRequire;
interface NodeRequire { (id: string): any; cache: any; resolve(id: string): string; }
declare const Buffer: { from(data: any, enc?: string): any; isBuffer(o: any): boolean };
declare function setImmediate(fn: (...args: any[]) => void, ...args: any[]): any;
declare function clearImmediate(id: any): void;
`,
      },
    ];

    for (const lib of state.extraLibs) {
      try {
        lib.dispose?.();
      } catch {
        /* ignore */
      }
    }
    state.extraLibs = [];
    for (const s of stubs) {
      state.extraLibs.push(
        monaco.languages.typescript.typescriptDefaults.addExtraLib(
          s.content,
          `file:///node_modules/@types/${s.name}`
        )
      );
      state.extraLibs.push(
        monaco.languages.typescript.javascriptDefaults.addExtraLib(
          s.content,
          `file:///node_modules/@types/${s.name}`
        )
      );
    }
  }

  function ensureModel(filePath, content, language) {
    const lang = language || languageOf(filePath);
    if (!lang || lang === "json") {
      // still open via editor; language service mainly TS/JS
    }
    const uri = toFileUri(filePath);
    let model = monaco.editor.getModel(uri);
    if (model) {
      if (typeof content === "string" && model.getValue() !== content) {
        model.setValue(content);
      }
    } else {
      model = monaco.editor.createModel(
        content ?? "",
        lang || "plaintext",
        uri
      );
    }
    state.models.set(normalizePath(filePath), model);
    return model;
  }

  function normalizePath(p) {
    return String(p || "").replace(/\\/g, "/").toLowerCase();
  }

  function collectProblems() {
    const models = monaco.editor.getModels();
    const items = [];
    for (const model of models) {
      const uri = model.uri;
      const markers = monaco.editor.getModelMarkers({ resource: uri });
      for (const m of markers) {
        if (m.severity === monaco.MarkerSeverity.Hint) continue;
        items.push({
          resource: uri.toString(),
          path: uri.fsPath || uri.path,
          severity: m.severity,
          message: m.message,
          startLineNumber: m.startLineNumber,
          startColumn: m.startColumn,
          endLineNumber: m.endLineNumber,
          endColumn: m.endColumn,
          source: m.source || "",
          code: m.code || "",
        });
      }
    }
    // sort errors first
    items.sort((a, b) => {
      if (a.severity !== b.severity) return b.severity - a.severity;
      if (a.path !== b.path) return String(a.path).localeCompare(String(b.path));
      return a.startLineNumber - b.startLineNumber;
    });
    state.lastProblems = items;
    if (state.onProblems) state.onProblems(items);
    return items;
  }

  function wireMarkers() {
    if (state.markerSub) {
      state.markerSub.dispose?.();
      state.markerSub = null;
    }
    let timer = null;
    state.markerSub = monaco.editor.onDidChangeMarkers(() => {
      // 输入过程中诊断频繁变化：200ms 防抖合并
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        collectProblems();
      }, 200);
    });
  }

  async function applyWorkspaceTsconfig(root) {
    if (!root || !window.monaco?.languages?.typescript) return null;
    try {
      const tc = await emsoder.getTsconfig();
      if (tc?.compilerOptions) {
        applyCompilerOptions(tc.compilerOptions);
      }
      return tc;
    } catch (err) {
      console.warn("tsconfig load failed", err);
      return null;
    }
  }

  /** 并发受限的 map（用于索引时批量读文件，避免 300 次串行 IPC） */
  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (next < items.length) {
          const i = next++;
          results[i] = await fn(items[i], i);
        }
      }
    );
    await Promise.all(workers);
    return results;
  }

  async function indexWorkspace(root) {
    if (!root || !window.monaco) return { count: 0 };
    if (state.indexing) return { count: state.models.size, busy: true };
    state.indexing = true;
    state.indexedRoot = root;
    try {
      const tc = await applyWorkspaceTsconfig(root);
      const res = await emsoder.listCodeFiles({ maxFiles: 300 });
      if (!res?.ok) return { count: 0, error: res?.error, tsconfig: tc };
      let n = 0;
      // Prefer ts/js first
      const sorted = [...res.files].sort((a, b) => {
        const score = (f) =>
          f.ext === ".ts" || f.ext === ".tsx"
            ? 0
            : f.ext === ".js" || f.ext === ".jsx"
              ? 1
              : 2;
        return score(a) - score(b);
      });
      // 并行读文件（并发 8），串行建模型
      await mapLimit(sorted, 8, async (f) => {
        const lang = languageOf(f.path);
        if (!lang) return;
        try {
          // skip if already open with model
          if (state.models.has(normalizePath(f.path))) {
            n++;
            return;
          }
          const file = await emsoder.readFile(f.path);
          ensureModel(f.path, file.content, lang);
          n++;
        } catch {
          /* unreadable */
        }
      });
      collectProblems();
      return {
        count: n,
        totalCandidates: res.files.length,
        tsconfig: tc?.found ? tc.relative || tc.path : null,
      };
    } finally {
      state.indexing = false;
    }
  }

  /**
   * 切换工作区时释放索引模型（保留用户打开的 tab 模型），
   * 避免 Monaco 模型无限增长。
   */
  function disposeIndexedModels(keepPaths) {
    const keep = new Set((keepPaths || []).map(normalizePath));
    for (const [p, model] of state.models) {
      if (keep.has(p)) continue;
      try {
        model.dispose();
      } catch {
        /* ignore */
      }
      state.models.delete(p);
    }
    state.indexedRoot = "";
  }

  function rememberOpenFile(filePath, content) {
    const lang = languageOf(filePath);
    if (!lang) return;
    ensureModel(filePath, content, lang);
  }

  /** 标签页关闭后从 LSP 索引移除该文件（模型已在 editor-host 释放） */
  function forgetFile(filePath) {
    const key = normalizePath(filePath);
    const model = state.models.get(key);
    if (model) {
      try {
        model.dispose();
      } catch { /* ignore */ }
      state.models.delete(key);
    }
  }

  function updateOpenFile(filePath, content) {
    const model = state.models.get(normalizePath(filePath));
    if (model && typeof content === "string" && model.getValue() !== content) {
      model.setValue(content);
    }
  }

  async function goToDefinition(editor) {
    if (!editor) return false;
    const model = editor.getModel();
    if (!model) return false;
    // Monaco 内置 provider（TS/JS/JSON/CSS/HTML）直接走 action
    try {
      await editor.getAction("editor.action.revealDefinition")?.run();
      return true;
    } catch {
      return false;
    }
  }

  function installEditorActions(editor) {
    if (!editor || editor.__emsoderLspBound) return;
    editor.__emsoderLspBound = true;

    // F12 / Ctrl+Click already partially handled by Monaco for TS/JS
    editor.addCommand(monaco.KeyCode.F12, () => {
      editor.getAction("editor.action.revealDefinition")?.run();
    });
    editor.addCommand(
      monaco.KeyMod.Alt | monaco.KeyCode.F12,
      () => editor.getAction("editor.action.peekDefinition")?.run()
    );
    editor.addCommand(
      monaco.KeyMod.Shift | monaco.KeyCode.F12,
      () => editor.getAction("editor.action.goToReferences")?.run()
    );
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK,
      () => {} // placeholder keep chord free
    );
  }

  async function init() {
    if (state.ready || !window.monaco) return;
    configureTsJs();
    wireMarkers();
    state.ready = true;
  }

  function setProblemsHandler(fn) {
    state.onProblems = fn;
    if (state.lastProblems.length) fn(state.lastProblems);
  }

  function getProblems() {
    return state.lastProblems.slice();
  }

  function severityLabel(sev) {
    if (sev === monaco?.MarkerSeverity?.Error || sev === 8) return "Error";
    if (sev === monaco?.MarkerSeverity?.Warning || sev === 4) return "Warning";
    if (sev === monaco?.MarkerSeverity?.Info || sev === 2) return "Info";
    return "Hint";
  }

  window.EmsoderLsp = {
    init,
    indexWorkspace,
    disposeIndexedModels,
    applyWorkspaceTsconfig,
    rememberOpenFile,
    forgetFile,
    updateOpenFile,
    installEditorActions,
    setProblemsHandler,
    getProblems,
    collectProblems,
    severityLabel,
    goToDefinition,
    onNavigate: null,
  };
})();
