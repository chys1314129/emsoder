/**
 * Context window capacity + cache hit rate tracking for EMSoder desktop.
 * - Estimates local prompt size when providers don't return usage
 * - Records provider usage (prompt / completion / cached tokens)
 * - Computes rolling average cache hit rate
 */

const DEFAULT_CONTEXT_WINDOW = 128_000;
const HISTORY_MAX = 40;

/** Heuristic context windows by model name fragment (longest match wins later) */
const MODEL_CONTEXT_TABLE = [
  { match: /o3-mini|o4-mini|o1-mini/i, window: 200_000 },
  { match: /\bo3\b|\bo1\b/i, window: 200_000 },
  { match: /gpt-4o-mini|gpt-4\.1-mini|gpt-4\.1-nano/i, window: 128_000 },
  { match: /gpt-4o|gpt-4\.1|gpt-4-turbo|chatgpt-4o/i, window: 128_000 },
  { match: /gpt-4(?!o)/i, window: 8_192 },
  { match: /gpt-3\.5/i, window: 16_385 },
  { match: /claude-3-5-sonnet|claude-sonnet-4|claude-3-7|claude-opus-4/i, window: 200_000 },
  { match: /claude-3-5-haiku|claude-3-haiku|claude-haiku/i, window: 200_000 },
  { match: /claude/i, window: 200_000 },
  { match: /deepseek-reasoner|deepseek-r1|deepseek-chat/i, window: 64_000 },
  { match: /deepseek/i, window: 64_000 },
  { match: /qwen2\.5-coder:32b|qwen2\.5:32b|qwen2\.5-72b|qwen-plus|qwen-max/i, window: 128_000 },
  { match: /qwen2\.5-coder:14b|qwen2\.5:14b|qwen-turbo|qwen-coder-plus/i, window: 128_000 },
  { match: /qwen2\.5-coder:7b|qwen2\.5:7b|qwen2\.5-coder/i, window: 32_768 },
  { match: /qwen/i, window: 32_768 },
  { match: /llama3\.1:70b|llama3\.3|llama-3\.1-70/i, window: 128_000 },
  { match: /llama3\.1|llama3|llama-3/i, window: 128_000 },
  { match: /codellama|code-llama/i, window: 16_384 },
  { match: /gemini-2|gemini-1\.5|gemini-pro/i, window: 1_000_000 },
  { match: /moonshot|kimi/i, window: 128_000 },
  { match: /step-/i, window: 64_000 },
  { match: /mistral|mixtral/i, window: 32_768 },
];

function resolveContextWindow(model, cfg = {}) {
  if (cfg.contextWindow && Number(cfg.contextWindow) > 0) {
    return Number(cfg.contextWindow);
  }
  const map = cfg.modelContextWindows || {};
  const name = String(model || "");
  if (map[name] && Number(map[name]) > 0) return Number(map[name]);
  // fuzzy map keys
  for (const k of Object.keys(map)) {
    if (name.includes(k) || k.includes(name)) {
      const n = Number(map[k]);
      if (n > 0) return n;
    }
  }
  for (const row of MODEL_CONTEXT_TABLE) {
    if (row.match.test(name)) return row.window;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Rough token estimate for mixed CN/EN code.
 * ~1 token per 2 CJK chars, ~1 per 4 latin chars; floor 1.
 */
function estimateTextTokens(text) {
  const s = String(text || "");
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x3000 && c <= 0x303f) ||
      (c >= 0xff00 && c <= 0xffef)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.max(1, Math.ceil(cjk / 1.5 + other / 4));
}

function estimateMessagesTokens(messages, tools) {
  let total = 0;
  for (const m of messages || []) {
    total += 4; // role framing
    if (typeof m.content === "string") {
      total += estimateTextTokens(m.content);
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (typeof part === "string") total += estimateTextTokens(part);
        else if (part?.text) total += estimateTextTokens(part.text);
        else total += estimateTextTokens(JSON.stringify(part));
      }
    }
    if (m.tool_calls?.length) {
      total += estimateTextTokens(JSON.stringify(m.tool_calls));
    }
    if (m.name) total += estimateTextTokens(m.name);
  }
  if (tools?.length) {
    total += estimateTextTokens(JSON.stringify(tools));
  }
  return total;
}

function stablePrefixHash(messages) {
  // Hash first system + first 2 messages as "cacheable prefix" for local hit rate
  const parts = [];
  let n = 0;
  for (const m of messages || []) {
    if (m.role === "system" || n < 2) {
      parts.push(m.role + ":" + String(m.content || "").slice(0, 4000));
      if (m.role !== "system") n++;
    }
    if (parts.length >= 4) break;
  }
  const s = parts.join("\n");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

class ContextStatsTracker {
  constructor() {
    /** @type {Array<{ts:number, prompt:number, completion:number, cached:number, source:string}>} */
    this.history = [];
    this.last = null;
    this.lastEstimate = null;
    this._prevPrefixHash = null;
    this._prevPrefixTokens = 0;
  }

  /**
   * Before a request: estimate local context fill + local prefix reuse.
   */
  beginRequest({ model, cfg, messages, tools }) {
    const window = resolveContextWindow(model, cfg);
    const estimated = estimateMessagesTokens(messages, tools);
    const hash = stablePrefixHash(messages);
    let localCached = 0;
    if (this._prevPrefixHash && hash === this._prevPrefixHash) {
      // approximate reusable prefix tokens
      localCached = Math.min(this._prevPrefixTokens, estimated);
    }
    // update prefix baseline (system-heavy portion ~ min(estimated*0.35, first chunks))
    const prefixTokens = Math.min(
      estimated,
      Math.max(
        estimateTextTokens(
          (messages || [])
            .filter((m) => m.role === "system")
            .map((m) => m.content || "")
            .join("\n")
        ),
        Math.floor(estimated * 0.25)
      )
    );
    this._prevPrefixHash = hash;
    this._prevPrefixTokens = prefixTokens;

    this.lastEstimate = {
      ts: Date.now(),
      model: model || "",
      contextWindow: window,
      estimatedPromptTokens: estimated,
      localCachedTokens: localCached,
      fillRatio: window > 0 ? estimated / window : 0,
    };
    return this.getSnapshot();
  }

  /**
   * After provider returns usage (preferred over estimate for hit rate).
   */
  recordUsage(usage = {}, meta = {}) {
    const prompt = num(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens);
    const completion = num(
      usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens
    );
    let cached = num(
      usage.cached_tokens ??
        usage.cache_read_input_tokens ??
        usage.cache_read_tokens ??
        usage.prompt_tokens_details?.cached_tokens ??
        usage.input_tokens_details?.cached_tokens
    );
    // DeepSeek / some gateways
    if (!cached && usage.prompt_cache_hit_tokens != null) {
      cached = num(usage.prompt_cache_hit_tokens);
    }
    if (!cached && meta.localCachedTokens) {
      cached = num(meta.localCachedTokens);
    }

    const row = {
      ts: Date.now(),
      prompt: prompt || this.lastEstimate?.estimatedPromptTokens || 0,
      completion,
      cached,
      source: usage._source || meta.source || "api",
      model: meta.model || this.lastEstimate?.model || "",
      contextWindow:
        meta.contextWindow ||
        this.lastEstimate?.contextWindow ||
        DEFAULT_CONTEXT_WINDOW,
    };
    this.history.push(row);
    if (this.history.length > HISTORY_MAX) {
      this.history = this.history.slice(-HISTORY_MAX);
    }
    this.last = row;
    return this.getSnapshot();
  }

  /** If API gave no usage, commit local estimate as a sample */
  commitEstimateAsUsage(extra = {}) {
    if (!this.lastEstimate) return this.getSnapshot();
    return this.recordUsage(
      {
        prompt_tokens: this.lastEstimate.estimatedPromptTokens,
        completion_tokens: extra.completionTokens || 0,
        cached_tokens: this.lastEstimate.localCachedTokens || 0,
        _source: "estimate",
      },
      {
        source: "estimate",
        model: this.lastEstimate.model,
        contextWindow: this.lastEstimate.contextWindow,
        localCachedTokens: this.lastEstimate.localCachedTokens,
      }
    );
  }

  getSnapshot() {
    const window =
      this.last?.contextWindow ||
      this.lastEstimate?.contextWindow ||
      DEFAULT_CONTEXT_WINDOW;
    const used =
      this.last?.prompt ||
      this.lastEstimate?.estimatedPromptTokens ||
      0;
    const completion = this.last?.completion || 0;
    // rolling avg cache hit = sum(cached) / sum(prompt)
    let sumPrompt = 0;
    let sumCached = 0;
    for (const h of this.history) {
      sumPrompt += h.prompt || 0;
      sumCached += Math.min(h.cached || 0, h.prompt || 0);
    }
    const avgCacheHitRate = sumPrompt > 0 ? sumCached / sumPrompt : 0;
    const lastHit =
      used > 0 ? Math.min(1, (this.last?.cached || 0) / used) : 0;
    const fillRatio = window > 0 ? Math.min(1.5, used / window) : 0;

    return {
      contextWindow: window,
      usedTokens: used,
      completionTokens: completion,
      cachedTokens: this.last?.cached || 0,
      fillRatio,
      fillPercent: Math.round(fillRatio * 1000) / 10,
      avgCacheHitRate,
      avgCacheHitPercent: Math.round(avgCacheHitRate * 1000) / 10,
      lastCacheHitRate: lastHit,
      lastCacheHitPercent: Math.round(lastHit * 1000) / 10,
      samples: this.history.length,
      lastSource: this.last?.source || this.lastEstimate ? "estimate" : "none",
      model: this.last?.model || this.lastEstimate?.model || "",
      estimated: !!this.lastEstimate && !this.last,
    };
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 10_000) return Math.round(v / 1000) + "k";
  if (v >= 1000) return (v / 1000).toFixed(1) + "k";
  return String(Math.round(v));
}

function formatContextLabel(snap) {
  if (!snap) return "ctx —";
  const used = formatTokens(snap.usedTokens);
  const win = formatTokens(snap.contextWindow);
  const pct = snap.fillPercent != null ? snap.fillPercent : 0;
  return `ctx ${used}/${win} (${pct}%)`;
}

function formatCacheLabel(snap) {
  if (!snap || !snap.samples) return "cache —";
  return `cache ${snap.avgCacheHitPercent}%`;
}

// singleton for main process
const tracker = new ContextStatsTracker();

module.exports = {
  DEFAULT_CONTEXT_WINDOW,
  resolveContextWindow,
  estimateTextTokens,
  estimateMessagesTokens,
  ContextStatsTracker,
  tracker,
  formatTokens,
  formatContextLabel,
  formatCacheLabel,
};
