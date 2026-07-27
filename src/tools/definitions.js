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
      description: "Run a shell command in the workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
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
      name: "create_document",
      description:
        "Generate a document file in the workspace: DOCX (Word), PDF, or PPTX (PowerPoint). Prefer relative path under workspace (e.g. exports/report.docx). For pptx provide slides[{title,bullets[]}] or markdown split by ---.",
      parameters: {
        type: "object",
        properties: {
          format: {
            type: "string",
            description: "docx | pdf | pptx (aliases: doc, ppt, word, powerpoint)",
          },
          path: {
            type: "string",
            description: "Output path relative to workspace",
          },
          title: { type: "string" },
          author: { type: "string" },
          content: {
            type: "string",
            description:
              "Body text for docx/pdf, or markdown for pptx (slides split by ---)",
          },
          paragraphs: {
            type: "array",
            items: { type: "string" },
            description: "Optional paragraphs array for docx/pdf",
          },
          slides: {
            type: "array",
            description: "For pptx: list of slides",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                bullets: {
                  type: "array",
                  items: { type: "string" },
                },
                notes: { type: "string" },
              },
            },
          },
        },
        required: ["format"],
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
