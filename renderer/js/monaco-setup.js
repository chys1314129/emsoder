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
      css: "css",
      scss: "scss",
      less: "less",
      md: "markdown",
      markdown: "markdown",
      py: "python",
      go: "go",
      rs: "rust",
      java: "java",
      c: "c",
      h: "c",
      cpp: "cpp",
      cc: "cpp",
      cxx: "cpp",
      hpp: "cpp",
      cs: "csharp",
      php: "php",
      rb: "ruby",
      sh: "shell",
      bash: "shell",
      zsh: "shell",
      ps1: "powershell",
      yml: "yaml",
      yaml: "yaml",
      xml: "xml",
      sql: "sql",
      toml: "ini",
      ini: "ini",
      conf: "ini",
      txt: "plaintext",
    };
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
