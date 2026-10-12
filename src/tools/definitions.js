const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file. Prefer paths relative to workspace root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a text file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Search/replace edit. old_string must match exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_diff",
      description:
        "Apply one or more exact search/replace hunks to a single file. Prefer this over write_file when changing several places. Each old_string must match exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to workspace" },
          hunks: {
            type: "array",
            description: "Ordered list of replacements (applied top to bottom)",
            items: {
              type: "object",
              properties: {
                old_string: { type: "string" },
                new_string: { type: "string" },
              },
              required: ["old_string", "new_string"],
            },
          },
          diff: {
            type: "string",
            description:
              "Optional multi-hunk text using <<<<<<< SEARCH / ======= / >>>>>>> REPLACE markers (alternative to hunks[])",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and directories.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          maxEntries: { type: "number" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_text",
      description: "Search text across workspace files.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          path: { type: "string" },
          maxResults: { type: "number" },
          glob: { type: "string" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_terminal",
      description:
        "Run a shell command in the workspace. For long tasks (image generation, builds, pip installs, ppt-master scripts) pass timeoutMs (up to 600000 = 10 minutes); default 60000 = 60s.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: {
            type: "string",
            description:
              "Working directory. Defaults to workspace root; skill script dirs are also allowed (use the absolute skill dir from load_skill).",
          },
          timeoutMs: {
            type: "number",
            description:
              "Optional timeout in milliseconds, 1000-600000. Default 60000. Pass a larger value for long-running commands (image gen, installs).",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_open_editors",
      description: "List open editor tabs and active file summary.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_git_diff",
      description: "Get git status and diff.",
      parameters: {
        type: "object",
        properties: { staged: { type: "boolean" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description:
        "Read an Office document as text: DOCX/WPS (.docx/.doc/.wps → text), XLSX/ET (.xlsx/.xls/.et → CSV per sheet), or CSV. Use this instead of read_file for binary Office files, which read_file cannot open. Returns extracted plain text/CSV.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the Office file, relative to workspace",
          },
          maxChars: {
            type: "number",
            description: "Optional cap on returned characters (default 40000)",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_images",
      description:
        "Search stock photos by keyword (Pexels or Unsplash, whichever is configured in settings). Returns a list of images with their download URL, size, description and author. Use this to find pictures for a PPT/PDF, then call download_image on the chosen url.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keywords, e.g. 'mountain sunrise'" },
          count: { type: "number", description: "How many results (1-30, default 8)" },
          orientation: {
            type: "string",
            description: "Optional: landscape | portrait | square",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "download_image",
      description:
        "Download an image URL (e.g. one returned by search_images) into the workspace, default exports/assets/. Returns the workspace-relative path for an installed PPT/PDF/document skill to use. Only http(s) image URLs, max 8MB.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "http(s) image URL" },
          name: { type: "string", description: "Optional base filename (a random suffix is added)" },
          dir: { type: "string", description: "Optional target dir under workspace (default exports/assets)" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web (DuckDuckGo, no API key needed) and return result titles, URLs and snippets. Use this whenever you need up-to-date information, docs, or facts you are not sure about. Follow up with web_fetch to read a result page in detail.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keywords" },
          count: { type: "number", description: "How many results to show (1-15, default 8)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch an http(s) web page and return its readable text content (HTML stripped). Use it to read docs, articles or pages found by web_search.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full http(s) URL" },
          maxChars: {
            type: "number",
            description: "Optional cap on returned characters (default 24000, max 100000)",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_subagent",
      description:
        "派出子代理并行完成子任务（独立上下文、独立轮数上限），返回每个子任务的结论。适合把互不依赖的研究/查找/编写子任务拆开并行做。tasks 数组最多 6 个；每个任务有独立上下文。",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "单个子任务描述（与 tasks 二选一）" },
          tasks: {
            type: "array",
            description: "多个子任务（最多 6 个，并行执行）",
            items: {
              type: "object",
              properties: {
                task: { type: "string", description: "子任务描述" },
                systemPrompt: { type: "string", description: "可选的子代理专属提示" },
              },
              required: ["task"],
            },
          },
          maxRounds: { type: "number", description: "每个子代理的轮数上限（默认 8，最大 24）" },
          systemPrompt: { type: "string", description: "所有子代理共用的提示（可选）" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_skills",
      description:
        "List installed Agent Skills (zcode-compatible SKILL.md under ~/.zcode/skills, ~/.agents/skills, workspace .emsoder/skills, optional plugin cache). Optional query filters by name/description.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional filter keyword",
          },
          includeDisabled: {
            type: "boolean",
            description: "Include skills disabled in settings (default false)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load_skill",
      description:
        "Load a skill's SKILL.md body (or a relative file under that skill directory) and follow its instructions. Prefer matching the user task to skill descriptions from the catalog or list_skills first.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Skill name or id (e.g. tavily-search, find-skills)",
          },
          file: {
            type: "string",
            description:
              "Optional relative path under the skill dir (e.g. rules/install.md). Empty = SKILL.md",
          },
          listFiles: {
            type: "boolean",
            description: "If true, list skill package files instead of reading body",
          },
        },
        required: ["name"],
      },
    },
  },
];

module.exports = { AGENT_TOOLS };
