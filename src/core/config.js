const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const DEFAULT_PROVIDERS = [
  {
    id: "ollama",
    name: "Ollama (Local Free)",
    type: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "ollama",
    models: ["qwen2.5-coder:7b", "qwen2.5-coder:14b", "llama3.1:8b"],
    enabled: true,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    type: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    models: ["deepseek-chat", "deepseek-reasoner"],
    enabled: true,
  },
  {
    id: "openai-compatible",
    name: "OpenAI Compatible",
    type: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    models: ["gpt-4o-mini", "gpt-4o", "o4-mini"],
    enabled: true,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    type: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "",
    models: ["claude-sonnet-4-20250514", "claude-3-5-haiku-latest"],
    enabled: true,
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    type: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: "",
    models: [
      "Qwen/Qwen2.5-Coder-32B-Instruct",
      "deepseek-ai/DeepSeek-V3",
    ],
    enabled: true,
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    type: "openai",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "lm-studio",
    models: ["local-model"],
    enabled: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    type: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "",
    models: [
      "openai/gpt-4o-mini",
      "qwen/qwen-2.5-coder-32b-instruct",
    ],
    enabled: false,
  },
  {
    id: "custom",
    name: "Custom Provider",
    type: "openai",
    baseUrl: "https://your-gateway.example.com/v1",
    apiKey: "",
    models: ["your-model-name"],
    enabled: true,
  },
];

/**
 * Provider preset templates for the "Add provider" wizard in the renderer.
 * Keyed by short id. models is a comma-joined string (UI displays it that way).
 * Kept here alongside DEFAULT_PROVIDERS so there is one source of truth.
 */
const PROVIDER_PRESETS = {
  ollama: {
    id: "ollama", name: "Ollama (Local Free)", type: "openai",
    baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama",
    models: "qwen2.5-coder:7b,qwen2.5-coder:14b,llama3.1:8b",
  },
  lmstudio: {
    id: "lmstudio", name: "LM Studio", type: "openai",
    baseUrl: "http://127.0.0.1:1234/v1", apiKey: "lm-studio",
    models: "local-model",
  },
  deepseek: {
    id: "deepseek", name: "DeepSeek", type: "openai",
    baseUrl: "https://api.deepseek.com/v1", apiKey: "",
    models: "deepseek-chat,deepseek-reasoner",
  },
  siliconflow: {
    id: "siliconflow", name: "SiliconFlow", type: "openai",
    baseUrl: "https://api.siliconflow.cn/v1", apiKey: "",
    models: "Qwen/Qwen2.5-Coder-32B-Instruct,deepseek-ai/DeepSeek-V3,Pro/deepseek-ai/DeepSeek-R1",
  },
  openrouter: {
    id: "openrouter", name: "OpenRouter", type: "openai",
    baseUrl: "https://openrouter.ai/api/v1", apiKey: "",
    models: "openai/gpt-4o-mini,anthropic/claude-3.5-sonnet,qwen/qwen-2.5-coder-32b-instruct",
  },
  moonshot: {
    id: "moonshot", name: "Moonshot / Kimi", type: "openai",
    baseUrl: "https://api.moonshot.cn/v1", apiKey: "",
    models: "moonshot-v1-8k,moonshot-v1-32k,moonshot-v1-128k",
  },
  dashscope: {
    id: "dashscope", name: "通义 DashScope 兼容", type: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "",
    models: "qwen-plus,qwen-turbo,qwen-coder-plus",
  },
  openai: {
    id: "openai-compatible", name: "OpenAI", type: "openai",
    baseUrl: "https://api.openai.com/v1", apiKey: "",
    models: "gpt-4o-mini,gpt-4o,o4-mini",
  },
  anthropic: {
    id: "anthropic", name: "Anthropic", type: "anthropic",
    baseUrl: "https://api.anthropic.com", apiKey: "",
    models: "claude-sonnet-4-20250514,claude-3-5-haiku-latest",
  },
  vllm: {
    id: "vllm", name: "vLLM / 自建", type: "openai",
    baseUrl: "http://127.0.0.1:8000/v1", apiKey: "",
    models: "your-served-model",
  },
  custom: {
    id: "custom", name: "Custom Gateway", type: "openai",
    baseUrl: "https://your-gateway.example.com/v1", apiKey: "",
    models: "your-model-name",
  },
};

const DEFAULT_CONFIG = {
  activeProviderId: "ollama",
  activeModel: "qwen2.5-coder:7b",
  providers: DEFAULT_PROVIDERS,
  agentMode: true,
  autoRunTools: false,
  /**
   * 自识别授权：文件读写、安全终端等操作自动放行，不弹确认；
   * 仅高危险终端命令（非 git/npm/ls 等白名单）仍询问。
   * autoRunTools 可以额外跳过危险命令。
   */
  autoApproveSafe: true,
  /** Chat 默认折叠工具调用与思考过程，只突出最终回答 */
  collapseProcess: true,
  terminalRunMode: "askEveryTime",
  commandDenyList:
    "rm -rf,format,mkfs,dd if=,shutdown,reboot,del /s,Remove-Item -Recurse",
  maxTokens: 8192,
  temperature: 0.2,
  /**
   * Agent 单次对话内「模型回复 ↔ 工具」循环上限。
   * 过小会中途停住，用户只能再发「继续」。
   */
  agentMaxRounds: 32,
  /** 触达上限或模型提前收口时，自动塞「继续」再跑的次数（0=关） */
  agentAutoContinue: 2,
  systemPrompt: "",
  responseLanguage: "zh-cn",
  theme: "sky-dark",
  lastWorkspace: "",
  windowBounds: { width: 1440, height: 900 },
  sidebarWidth: 380,
  showSidebar: true,
  showBottomPanel: true,
  bottomPanelHeight: 220,
  bottomPanelTab: "terminal",
  completionEnabled: true,
  completionDebounceMs: 400,
  fontSize: 14,
  tabSize: 2,
  wordWrap: "off",
  minimap: false,
  /** Load zcode-compatible skills (~/.zcode/skills, ~/.agents/skills, workspace) */
  skillsEnabled: true,
  /** Skills copied into the app at pack time (resources/bundled-skills) */
  skillsIncludeBundled: true,
  /** Also scan ~/.zcode/cli/plugins/cache for packaged SKILL.md */
  skillsIncludePlugins: true,
  /** Extra absolute skill root directories */
  skillsDirs: [],
  /** Skill ids/names to hide from catalog */
  skillsDisabled: [],
  /** Long-term memory: extract facts/preferences from past turns, retrieve by current context */
  memoriesEnabled: false,
  /** Max memories to keep (LRU by importance + recency) */
  memoriesMaxCount: 500,
  /** MCP servers (stdio): { id, name, command, args: [], env: {}, enabled } */
  mcpServers: [],
};

function configPath() {
  return path.join(app.getPath("userData"), "emsoder-config.json");
}

function sessionsPath() {
  return path.join(app.getPath("userData"), "emsoder-sessions.json");
}

function memoriesPath() {
  return path.join(app.getPath("userData"), "emsoder-memories.json");
}

/** Strip unknown keys and coerce types to match DEFAULT_CONFIG schema. */
function sanitizeConfig(raw) {
  const out = {};
  for (const [k, def] of Object.entries(DEFAULT_CONFIG)) {
    if (!(k in raw)) continue;
    const v = raw[k];
    const t = typeof def;
    // Arrays keep their own validation below; skip type-check for them
    if (Array.isArray(def)) continue;
    // Accept only same primitive type; silently drop wrong-type values
    if (t !== "object" && typeof v !== t) continue;
    out[k] = v;
  }
  // Providers: validate each entry has at least id + baseUrl
  out.providers =
    Array.isArray(raw.providers) && raw.providers.length
      ? raw.providers.filter(
          (p) => p && typeof p.id === "string" && typeof p.baseUrl === "string"
        )
      : [];
  if (!out.providers.length) out.providers = DEFAULT_PROVIDERS;
  // Other arrays
  out.skillsDirs = Array.isArray(raw.skillsDirs) ? raw.skillsDirs.filter((s) => typeof s === "string") : [];
  out.skillsDisabled = Array.isArray(raw.skillsDisabled) ? raw.skillsDisabled.filter((s) => typeof s === "string") : [];
  // MCP servers: keep entries with id + (command or url); infer type like zcode
  out.mcpServers = Array.isArray(raw.mcpServers)
    ? raw.mcpServers
        .filter(
          (s) =>
            s &&
            typeof s.id === "string" &&
            (typeof s.command === "string" || typeof s.url === "string")
        )
        .map((s) => {
          const hasCmd = typeof s.command === "string" && s.command.trim() !== "";
          const hasUrl = typeof s.url === "string" && s.url.trim() !== "";
          const type =
            s.type === "http" || s.type === "stdio"
              ? s.type
              : hasUrl && !hasCmd
                ? "http"
                : hasCmd && !hasUrl
                  ? "stdio"
                  : "http"; // 两者都有时 http 优先
          const timeoutMs = Number(s.timeoutMs);
          return {
            id: s.id,
            name: typeof s.name === "string" && s.name ? s.name : s.id,
            type,
            command: type === "stdio" ? String(s.command || "") : "",
            args: Array.isArray(s.args) ? s.args.filter((a) => typeof a === "string") : [],
            cwd: typeof s.cwd === "string" ? s.cwd : "",
            env: s.env && typeof s.env === "object" && !Array.isArray(s.env) ? s.env : {},
            url: type === "http" ? String(s.url || "") : "",
            headers:
              s.headers && typeof s.headers === "object" && !Array.isArray(s.headers)
                ? s.headers
                : {},
            enabled: s.enabled !== false,
            timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0
              ? Math.min(300_000, Math.max(1_000, Math.round(timeoutMs)))
              : 30_000,
          };
        })
    : [];
  return out;
}

function loadConfig() {
  try {
    const p = configPath();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      return { ...DEFAULT_CONFIG, ...sanitizeConfig(raw) };
    }
  } catch (e) {
    console.error("loadConfig", e);
  }
  return structuredClone(DEFAULT_CONFIG);
}

function saveConfig(cfg) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
}

function getProviders(cfg) {
  return (cfg.providers || []).map((p) => ({
    id: p.id,
    name: p.name || p.id,
    type: p.type === "anthropic" ? "anthropic" : "openai",
    baseUrl: String(p.baseUrl || "").replace(/\/+$/, ""),
    apiKey: p.apiKey || "",
    models: Array.isArray(p.models) ? p.models : [],
    enabled: p.enabled !== false,
    headers: p.headers,
    chatPath: p.chatPath,
  }));
}

function getEnabledProviders(cfg) {
  return getProviders(cfg).filter((p) => p.enabled);
}

function getActiveProvider(cfg) {
  const list = getEnabledProviders(cfg);
  return list.find((p) => p.id === cfg.activeProviderId) || list[0];
}

function getActiveModel(cfg) {
  const provider = getActiveProvider(cfg);
  if (!provider) return cfg.activeModel || "";
  if (cfg.activeModel && provider.models.includes(cfg.activeModel)) {
    return cfg.activeModel;
  }
  return provider.models[0] || cfg.activeModel || "";
}

function getCommandDenyList(cfg) {
  return String(cfg.commandDenyList || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_PROVIDERS,
  PROVIDER_PRESETS,
  configPath,
  sessionsPath,
  memoriesPath,
  loadConfig,
  saveConfig,
  getProviders,
  getEnabledProviders,
  getActiveProvider,
  getActiveModel,
  getCommandDenyList,
};
