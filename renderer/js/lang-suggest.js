/* global monaco */
/**
 * 全语言关键词/语句骨架补全（零依赖）。
 * 只覆盖 Monaco 无内置 suggest provider 的语言（TS/JS/JSON/CSS/HTML 等
 * 有 worker 的语言不注册，避免干扰内置建议）。
 * 用法：EmsoderLangSuggest.init() 在 monaco ready 后调用。
 */
(function () {
  const KEYWORDS = {
    python: [
      { k: "def", s: "def ${1:name}(${2:args}):\n\t${0:pass}" },
      { k: "class", s: "class ${1:Name}:\n\t${0:pass}" },
      { k: "import", s: "import ${1:module}" },
      { k: "from", s: "from ${1:module} import ${2:name}" },
      { k: "if", s: "if ${1:cond}:\n\t${0:pass}" },
      { k: "elif", s: "elif ${1:cond}:\n\t${0:pass}" },
      { k: "else", s: "else:\n\t${0:pass}" },
      { k: "for", s: "for ${1:i} in ${2:range}:\n\t${0:pass}" },
      { k: "while", s: "while ${1:cond}:\n\t${0:pass}" },
      { k: "try", s: "try:\n\t${0:pass}\nexcept ${1:Exception}:" },
      { k: "with", s: "with ${1:open}() as ${2:f}:" },
      { k: "lambda" }, { k: "return" }, { k: "yield" }, { k: "async" }, { k: "await" },
      { k: "None" }, { k: "True" }, { k: "False" }, { k: "self" },
    ],
    rust: [
      { k: "fn", s: "fn ${1:name}(${2:args}) {\n\t${0}\n}" },
      { k: "let", s: "let ${1:mut x} = ${2:value};" },
      { k: "match", s: "match ${1:value} {\n\t${2:pattern} => ${0},\n}" },
      { k: "if", s: "if ${1:cond} {\n\t${0}\n}" },
      { k: "else" }, { k: "loop" }, { k: "while" }, { k: "for" },
      { k: "struct", s: "struct ${1:Name} {\n\t${0}\n}" },
      { k: "enum" }, { k: "impl", s: "impl ${1:Type} {\n\t${0}\n}" },
      { k: "pub" }, { k: "use" }, { k: "mod" }, { k: "mut" }, { k: "ref" },
      { k: "async" }, { k: "await" }, { k: "return" }, { k: "Self" }, { k: "Self" },
    ],
    go: [
      { k: "func", s: "func ${1:name}(${2:args}) ${3:error} {\n\t${0}\n}" },
      { k: "package", s: "package ${1:main}" },
      { k: "import", s: "import \"${1:fmt}\"" },
      { k: "var", s: "var ${1:x} = ${2:value}" },
      { k: "const" }, { k: "type", s: "type ${1:Name} struct {\n\t${0}\n}" },
      { k: "if" }, { k: "else" }, { k: "for" }, { k: "range" }, { k: "switch" },
      { k: "case" }, { k: "default" }, { k: "go" }, { k: "defer" }, { k: "return" },
      { k: "nil" }, { k: "true" }, { k: "false" }, { k: "error" },
    ],
    java: [
      { k: "public", s: "public ${1:static} ${2:void} ${3:main}(${4:String[] args})" },
      { k: "private" }, { k: "protected" }, { k: "class", s: "class ${1:Name} {\n\t${0}\n}" },
      { k: "interface" }, { k: "extends" }, { k: "implements" }, { k: "import" },
      { k: "package" }, { k: "new" }, { k: "return" }, { k: "void" }, { k: "int" },
      { k: "boolean" }, { k: "String" }, { k: "List" }, { k: "Map" }, { k: "try" },
      { k: "catch" }, { k: "finally" }, { k: "throw" }, { k: "throws" }, { k: "if" },
      { k: "else" }, { k: "for" }, { k: "while" }, { k: "switch" }, { k: "this" },
      { k: "super" }, { k: "null" }, { k: "true" }, { k: "false" },
    ],
    cpp: [
      { k: "#include", s: "#include <${1:iostream}>" },
      { k: "using", s: "using namespace ${1:std};" },
      { k: "int", s: "int ${1:main}() {\n\t${0}\n}" },
      { k: "return" }, { k: "if" }, { k: "else" }, { k: "for" }, { k: "while" },
      { k: "class", s: "class ${1:Name} {\npublic:\n\t${0}\n};" },
      { k: "struct" }, { k: "enum" }, { k: "namespace" }, { k: "template" },
      { k: "typename" }, { k: "const" }, { k: "static" }, { k: "virtual" },
      { k: "void" }, { k: "bool" }, { k: "true" }, { k: "false" }, { k: "nullptr" },
      { k: "new" }, { k: "delete" }, { k: "this" }, { k: "auto" },
    ],
    csharp: [
      { k: "using", s: "using ${1:System};" },
      { k: "namespace", s: "namespace ${1:App} {\n\t${0}\n}" },
      { k: "class", s: "class ${1:Name}\n{\n\t${0}\n}" },
      { k: "public" }, { k: "private" }, { k: "protected" }, { k: "static" },
      { k: "void" }, { k: "var" }, { k: "new" }, { k: "return" }, { k: "if" },
      { k: "else" }, { k: "for" }, { k: "foreach" }, { k: "while" }, { k: "switch" },
      { k: "try" }, { k: "catch" }, { k: "finally" }, { k: "async" }, { k: "await" },
      { k: "this" }, { k: "null" }, { k: "true" }, { k: "false" },
    ],
    php: [
      { k: "<?php", s: "<?php\n${0}" },
      { k: "function", s: "function ${1:name}(${2:args}) {\n\t${0}\n}" },
      { k: "class", s: "class ${1:Name} {\n\t${0}\n}" },
      { k: "echo", s: "echo ${1:'text'};" },
      { k: "namespace" }, { k: "use" }, { k: "public" }, { k: "private" },
      { k: "static" }, { k: "if" }, { k: "else" }, { k: "foreach" }, { k: "for" },
      { k: "while" }, { k: "return" }, { k: "new" }, { k: "null" }, { k: "true" },
      { k: "false" }, { k: "array" }, { k: "isset" }, { k: "empty" },
    ],
    ruby: [
      { k: "def", s: "def ${1:name}\n\t${0}\nend" },
      { k: "class", s: "class ${1:Name}\n\t${0}\nend" },
      { k: "module" }, { k: "require" }, { k: "include" }, { k: "attr_accessor" },
      { k: "if" }, { k: "elsif" }, { k: "else" }, { k: "unless" }, { k: "case" },
      { k: "when" }, { k: "while" }, { k: "until" }, { k: "each" }, { k: "do" },
      { k: "end" }, { k: "return" }, { k: "nil" }, { k: "true" }, { k: "false" },
    ],
    sql: [
      { k: "SELECT", s: "SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:cond};" },
      { k: "INSERT", s: "INSERT INTO ${1:table} (${2:cols}) VALUES (${3:vals});" },
      { k: "UPDATE", s: "UPDATE ${1:table} SET ${2:col} = ${3:val} WHERE ${4:cond};" },
      { k: "DELETE", s: "DELETE FROM ${1:table} WHERE ${2:cond};" },
      { k: "CREATE", s: "CREATE TABLE ${1:name} (\n\t${0}\n);" },
      { k: "FROM" }, { k: "WHERE" }, { k: "JOIN" }, { k: "LEFT" }, { k: "RIGHT" },
      { k: "INNER" }, { k: "GROUP" }, { k: "BY" }, { k: "ORDER" }, { k: "HAVING" },
      { k: "LIMIT" }, { k: "OFFSET" }, { k: "DISTINCT" }, { k: "AS" }, { k: "IN" },
      { k: "BETWEEN" }, { k: "LIKE" }, { k: "AND" }, { k: "OR" }, { k: "NOT" },
      { k: "NULL" }, { k: "PRIMARY" }, { k: "KEY" }, { k: "FOREIGN" }, { k: "REFERENCES" },
    ],
    shell: [
      { k: "if", s: "if [ ${1:cond} ]; then\n\t${0}\nfi" },
      { k: "for", s: "for ${1:i} in ${2:list}; do\n\t${0}\ndone" },
      { k: "while", s: "while [ ${1:cond} ]; do\n\t${0}\ndone" },
      { k: "case" }, { k: "function" }, { k: "echo", s: "echo \"${1:text}\"" },
      { k: "export", s: "export ${1:VAR}=${2:value}" }, { k: "source" },
      { k: "cd" }, { k: "mkdir" }, { k: "rm" }, { k: "cp" }, { k: "mv" },
      { k: "grep" }, { k: "find" }, { k: "curl" }, { k: "exit" }, { k: "then" },
      { k: "fi" }, { k: "do" }, { k: "done" },
    ],
  };

  /** 有内置 suggest provider 的语言（不注册通用补全，避免干扰） */
  const EXCLUDED = new Set([
    "typescript", "javascript", "json", "css", "scss", "less", "html",
    "markdown", "yaml", "xml", "plaintext",
  ]);

  function registerFor(langId, words) {
    if (!words?.length) return;
    const items = words.map((w) => ({
      label: w.k,
      kind: monaco.languages.CompletionItemKind.Keyword,
      insertText: w.s || w.k,
      insertTextRules: w.s
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
      detail: "keyword",
      sortText: "0" + w.k,
    }));
    monaco.languages.registerCompletionItemProvider(langId, {
      triggerCharacters: [".", " ", "(", "#", ":"],
      provideCompletionItems(model, position) {
        // 只在行首/词边界给出关键词，避免满屏噪声
        const word = model.getWordUntilPosition(position);
        const prefix = word?.word || "";
        const matches = items.filter(
          (it) =>
            it.label.startsWith(prefix.toLowerCase()) ||
            it.label.startsWith(prefix)
        );
        if (!matches.length) return { suggestions: [] };
        return { suggestions: matches };
      },
    });
  }

  function init() {
    if (!window.monaco?.languages) return false;
    let any = false;
    for (const [langId, words] of Object.entries(KEYWORDS)) {
      if (EXCLUDED.has(langId)) continue;
      try {
        registerFor(langId, words);
        any = true;
      } catch {
        /* 语言未注册时忽略（Monaco 懒加载，仍可注册） */
      }
    }
    return any;
  }

  window.EmsoderLangSuggest = { init };
})();
