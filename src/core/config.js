const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { executionEnv } = require("../tools/skillRuntime");
const { sealConfig, unsealConfig } = require("./secretStore");
const { POLLINATIONS_PROVIDER } = require("../providers/pollinations");

const DEFAULT_PROVIDERS = [
  structuredClone(POLLINATIONS_PROVIDER),
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
  pollinations: { ...POLLINATIONS_PROVIDER, models: "openai" },
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
  activeProviderId: "pollinations-keyless",
  activeModel: "openai",
  providers: DEFAULT_PROVIDERS,
  /** Opt-in only: failures may send the same conversation to Pollinations. */
  keylessFallbackEnabled: false,
  pollinationsProviderMigrated: true,
  /** Agent runtime backend: pi (default sidecar) | emsoder (legacy fallback) */
  agentBackend: "pi",
  agentMode: true,
  /**
   * 权限模式：
   * confirm       变更前确认 — 改文件前先问
   * auto_edit     自动编辑   — 自动改文件
   * plan          计划模式   — 编辑前先出计划，不直接改
   * full          高危才询问 — 自动改文件 + 安全命令自动，仅高危仍问
   * unrestricted  完全授权   — 不问用户，文件和终端都自动执行
   */
  permissionMode: "auto_edit",
  /** Chat 默认折叠工具调用与思考过程，只突出最终回答 */
  collapseProcess: true,
  terminalRunMode: "askEveryTime",
  commandDenyList:
    "rm -rf,format,mkfs,dd if=,shutdown,reboot,del /s,Remove-Item -Recurse",
  /** User variables for terminal / run_terminal / skill child processes only. */
  executionEnv: {},
  maxTokens: 0,
  temperature: 0.2,
  /**
   * 模型思考强度：off / low / medium / high / ultra（关闭/低/中/高/超高）。
   * off 不发送 reasoning_effort、reasoning 或 thinking 参数；其余档位按 Provider 映射。
   * 不支持的模型/网关会忽略该字段。
   */
  reasoningEffort: "medium",
  /**
   * 运行模式（Pi plan/goal）：auto = 直接执行；plan = 先出计划等用户批准再执行；
   * goal = 目标模式，自动续跑直到完成。旧后端 auto 行为不受影响。
   */
  runMode: "auto",
  /**
   * Agent 单次对话内「模型回复 ↔ 工具」循环上限。
   * 0 / 不填 = 不限制，直到模型不再调工具或用户点停止。
   */
  agentMaxRounds: 0,
  /**
   * 模型提前收口时自动再跑的次数。
   * -1 / 不填 = 不限制；0 = 关。
   */
  agentAutoContinue: -1,
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
  /** 上下文窗口容量覆盖：>0 时对所有模型强制该 token 上限；0 = 按模型自动判断 */
  contextWindow: 0,
  /** 按模型名指定上下文窗口：{ "模型名或片段": token数 } */
  modelContextWindows: {},
  /** 上下文占用达到该百分比时任务中自动压缩（40–99）；见 compress.js */
  autoCompressAt: 80,
  /** 完成提示音：任务做完（发送键恢复可点）时响一声 */
  soundEnabled: true,
  /** 完成提示音音量 0–1 */
  soundVolume: 1.0,
  /** 桌面悬浮球：常驻置顶显示任务状态 */
  floatingBallEnabled: false,
  /** 图片搜索来源：pexels | unsplash */
  imageProvider: "pexels",
  /** Pexels API Key（免费申请：https://www.pexels.com/api/） */
  pexelsApiKey: "",
  /** Unsplash Access Key（免费申请：https://unsplash.com/developers） */
  unsplashApiKey: "",
  /** ppt-master AI 图片生成后端 */
  imageGenBackend: "modelscope",
  /** 可选覆盖后端默认模型 */
  imageGenModel: "",
  /** OpenAI-compatible / 自建图片后端的可选 Base URL */
  imageGenBaseUrl: "",
  /** AI 图片生成 API Key，仅本机用户配置保存，不进入公开配置 */
  imageGenApiKey: "",
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
    Array.isArray(raw.providers)
      ? raw.providers.filter(
          (p) => p && typeof p.id === "string" && typeof p.baseUrl === "string"
        )
      : [];
  if (!Array.isArray(raw.providers)) out.providers = structuredClone(DEFAULT_PROVIDERS);
  // Other arrays
  out.skillsDirs = Array.isArray(raw.skillsDirs) ? raw.skillsDirs.filter((s) => typeof s === "string") : [];
  out.skillsDisabled = Array.isArray(raw.skillsDisabled) ? raw.skillsDisabled.filter((s) => typeof s === "string") : [];
  out.executionEnv = executionEnv({ executionEnv: raw.executionEnv });
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
      // 敏感字段静态解密（旧明文配置原样返回，下次保存自动加密）
      const data = unsealConfig(raw);
      const cfg = { ...DEFAULT_CONFIG, ...sanitizeConfig(data) };
      // Add the built-in lane once without replacing the user's active provider.
      if (!data.pollinationsProviderMigrated) {
        if (!cfg.providers.some((p) => p.id === POLLINATIONS_PROVIDER.id)) {
          cfg.providers = [...cfg.providers, structuredClone(POLLINATIONS_PROVIDER)];
        }
        cfg.pollinationsProviderMigrated = true;
        saveConfig(cfg);
      }
      // 一次性迁移：旧配置 autoRunTools/autoApproveSafe -> permissionMode
      if (!cfg.permissionMode || cfg.permissionMode === "auto_edit") {
        if (raw.autoRunTools === true) cfg.permissionMode = "full";
        else if (raw.autoApproveSafe === true) cfg.permissionMode = "auto_edit";
        else if (raw.autoApproveSafe === false && !raw.permissionMode) cfg.permissionMode = "confirm";
      }
      // 旧默认 32/2/48/5 对长任务仍会中途停：未手动改成 0/-1 的配置改为不限制
      const rounds = Number(raw.agentMaxRounds);
      if (raw.agentMaxRounds == null || rounds === 32 || rounds === 48) {
        cfg.agentMaxRounds = 0;
      }
      const cont = Number(raw.agentAutoContinue);
      if (raw.agentAutoContinue == null || cont === 2 || cont === 5) {
        cfg.agentAutoContinue = -1;
      }
      return cfg;
    }
  } catch (e) {
    console.error("loadConfig", e);
  }
  return structuredClone(DEFAULT_CONFIG);
}

function saveConfig(cfg) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(sealConfig(cfg), null, 2), "utf8");
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
    keyless: p.keyless === true,
    timeoutMs: p.timeoutMs,
    oauth: p.oauth && typeof p.oauth === "object" ? p.oauth : undefined,
    oauthConfigured: !!(p.oauth?.clientId && p.oauth?.authorizeUrl && p.oauth?.tokenUrl),
    oauthConnected: !!(p.oauthTokens?.accessToken),
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
