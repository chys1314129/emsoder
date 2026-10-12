/* global emsoder, require, monaco */
(function () {
  function languageFromPath(filePath) {
    const name = String(filePath || "").split(/[/\\]/).pop() || "";
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    const map = {
      js: "javascript",
      jsx: "javascript",
      mjs: "javascript",
      cjs: "javascript",
      ts: "typescript",
      tsx: "typescript",
      json: "json",
      html: "html",
      htm: "html",
      vue: "html",
      svelte: "html",
      css: "css",
      scss: "scss",
      less: "less",
      md: "markdown",
      markdown: "markdown",
      mdx: "markdown",
      py: "python",
      go: "go",
      rs: "rust",
      java: "java",
      // 注意：Monaco 没有独立 "c" 语言，.c/.h 走 cpp tokenizer
      c: "cpp",
      h: "cpp",
      cpp: "cpp",
      cc: "cpp",
      cxx: "cpp",
      hpp: "cpp",
      hh: "cpp",
      hxx: "cpp",
      cs: "csharp",
      php: "php",
      rb: "ruby",
      sh: "shell",
      bash: "shell",
      zsh: "shell",
      ps1: "powershell",
      bat: "bat",
      cmd: "bat",
      yml: "yaml",
      yaml: "yaml",
      xml: "xml",
      sql: "sql",
      toml: "ini",
      ini: "ini",
      conf: "ini",
      txt: "plaintext",
      // Monaco 已打包但此前未映射的语言（tokenizer 懒加载，零额外体积）
      dart: "dart",
      kotlin: "kotlin",
      kt: "kotlin",
      swift: "swift",
      lua: "lua",
      perl: "perl",
      pl: "perl",
      scala: "scala",
      clj: "clojure",
      cljs: "clojure",
      fsi: "fsharp",
      fs: "fsharp",
      fsx: "fsharp",
      r: "r",
      julia: "julia",
      dockerfile: "dockerfile",
      graphql: "graphql",
      gql: "graphql",
      proto: "protobuf",
      vb: "vb",
      m: "objective-c",
      mm: "objective-c",
      sol: "sol",
      pas: "pascal",
      hs: "haskell",
      ex: "elixir",
      exs: "elixir",
      erl: "erlang",
      nim: "nim",
      zig: "zig",
      tf: "hcl",
      hcl: "hcl",
      cmake: "cmake",
      groovy: "groovy",
    };
    // Dockerfile / Makefile / Jenkinsfile 等无扩展名文件按文件名识别
    if (!ext && /^dockerfile$/i.test(name)) return "dockerfile";
    if (!ext && /^makefile$/i.test(name)) return "makefile";
    return map[ext] || "plaintext";
  }

  function defineSkyTheme() {
    monaco.editor.defineTheme("emsoder-sky", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6d8099", fontStyle: "italic" },
        { token: "keyword", foreground: "7dd3fc" },
        { token: "string", foreground: "86efac" },
        { token: "number", foreground: "fbbf24" },
        { token: "type", foreground: "38bdf8" },
      ],
      colors: {
        "editor.background": "#0f1724",
        "editor.foreground": "#d7e3f4",
        "editorLineNumber.foreground": "#4b607a",
        "editorLineNumber.activeForeground": "#7dd3fc",
        "editor.selectionBackground": "#0ea5e955",
        "editor.inactiveSelectionBackground": "#0ea5e933",
        "editorCursor.foreground": "#38bdf8",
        "editor.lineHighlightBackground": "#38bdf812",
        "editorIndentGuide.background": "#1c2d45",
        "editorIndentGuide.activeBackground": "#38bdf844",
        "editorWidget.background": "#0e1a2b",
        "editorWidget.border": "#1c2d45",
        "input.background": "#111f33",
        "dropdown.background": "#0e1a2b",
        "list.activeSelectionBackground": "#0ea5e933",
        "list.hoverBackground": "#38bdf814",
        "scrollbarSlider.background": "#24374f88",
        "scrollbarSlider.hoverBackground": "#0369a1aa",
      },
    });
    // 白天模式：亮色编辑器主题
    monaco.editor.defineTheme("emsoder-light", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "comment", foreground: "8a8a8a", fontStyle: "italic" },
        { token: "keyword", foreground: "0d44a8" },
        { token: "string", foreground: "0a7c3a" },
        { token: "number", foreground: "b45309" },
        { token: "type", foreground: "7c3aed" },
      ],
      colors: {
        "editor.background": "#ffffff",
        "editor.foreground": "#1f1e1a",
        "editorLineNumber.foreground": "#b0b0b0",
        "editorLineNumber.activeForeground": "#0d44a8",
        "editor.selectionBackground": "#0ea5e933",
        "editor.inactiveSelectionBackground": "#0ea5e922",
        "editorCursor.foreground": "#0d44a8",
        "editor.lineHighlightBackground": "#0ea5e90d",
        "editorIndentGuide.background": "#e0e0e0",
        "editorIndentGuide.activeBackground": "#0ea5e944",
        "editorWidget.background": "#f8f8f5",
        "editorWidget.border": "#d0d0d0",
        "input.background": "#ffffff",
        "dropdown.background": "#ffffff",
        "list.activeSelectionBackground": "#0ea5e922",
        "list.hoverBackground": "#0ea5e90d",
        "scrollbarSlider.background": "#c0c0c088",
        "scrollbarSlider.hoverBackground": "#0d44a1aa",
      },
    });
  }

  function loadMonaco() {
    return new Promise((resolve, reject) => {
      if (window.monaco) {
        resolve(window.monaco);
        return;
      }
      const info = window.emsoder?.monaco;
      if (!info?.loaderUrl || !info?.vsUrl) {
        reject(new Error("Monaco path missing from preload"));
        return;
      }

      // Worker bootstrap via blob (file:// safe)
      const base = info.baseUrl;
      // Classic AMD worker bootstrap (file:// safe). One workerMain handles editor + ts.
      window.MonacoEnvironment = {
        getWorkerUrl: function (_moduleId, label) {
          // label may be: editorWorkerService | typescript | javascript | json | css | html
          void label;
          const body = `
            self.MonacoEnvironment = { baseUrl: ${JSON.stringify(base)} };
            importScripts(${JSON.stringify(info.vsUrl + "base/worker/workerMain.js")});
          `;
          return URL.createObjectURL(
            new Blob([body], { type: "text/javascript" })
          );
        },
      };

      window.require = { paths: { vs: info.vsUrl.replace(/\/$/, "") } };
      const script = document.createElement("script");
      script.src = info.loaderUrl;
      script.onload = () => {
        try {
          window.require(["vs/editor/editor.main"], () => {
            defineSkyTheme();
            // Monaco 加载后立即同步当前主题（applyTheme 可能先于此执行过）
            try {
              var t = document.body.getAttribute("data-theme") ||
                document.documentElement.getAttribute("data-theme");
              window.monaco.editor.setTheme(t === "light" ? "emsoder-light" : "emsoder-sky");
            } catch (e) { /* ignore */ }
            resolve(window.monaco);
          });
        } catch (err) {
          reject(err);
        }
      };
      script.onerror = () => reject(new Error("Failed to load Monaco loader"));
      document.head.appendChild(script);
    });
  }

  window.EmsoderMonaco = {
    load: loadMonaco,
    languageFromPath,
  };
})();
