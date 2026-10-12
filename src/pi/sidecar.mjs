#!/usr/bin/env node
/** Pi sidecar using @earendil-works/pi-agent-core with EMSoder host proxy. */
import { createInterface } from "node:readline";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  estimateContextTokens,
  shouldCompact as piShouldCompact,
} from "@earendil-works/pi-agent-core";
import { Type, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { METHODS, parseLine, encode, response, errorResponse, notification } from "./protocol.js";

const runtimes = new Map();
const subRuntimes = new Map();
const pending = new Map();
const providerStreams = new Map();
let nextId = 1;

/** EMSoder 思考档位 → Pi thinkingLevel + 各档 token 预算（由主进程下发预算，这里做档位归一）。 */
function mapThinking(params = {}) {
  const level = String(params.thinkingLevel || "medium").toLowerCase();
  const piLevel =
    level === "off" ? "off"
    : level === "ultra" ? "high"
    : level === "low" || level === "high" ? level
    : "medium";
  const budgets =
    params.thinkingBudgets && typeof params.thinkingBudgets === "object"
      ? params.thinkingBudgets
      : undefined;
  return { thinkingLevel: piLevel, thinkingBudgets: budgets };
}

/** Pi 自估上下文占用，并决定是否需要压缩（完整接管压缩时机）。 */
function decideCompaction(runtime) {
  try {
    const messages = runtime.agent?.state?.messages || [];
    const { tokens } = estimateContextTokens(messages);
    const window = Number(runtime.model?.contextWindow) || 128000;
    const reserve = Math.max(4096, Math.floor(window * 0.2));
    const needed = piShouldCompact(tokens, window, {
      enabled: true,
      reserveTokens: reserve,
      keepRecentTokens: 20000,
    });
    return { tokens, window, needed };
  } catch {
    return { tokens: 0, window: 128000, needed: false };
  }
}

/** 取最近一条 assistant 消息的文本（plan_ready 事件用）。 */
function collectAssistantText(runtime) {
  const messages = runtime.agent?.state?.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") {
      const text = (m.content || [])
        .filter((b) => b?.type === "text")
        .map((b) => b.text || "")
        .join("");
      if (text) return text;
    }
  }
  return "";
}

/**
 * 请求主进程执行真实压缩（会话存储 + 摘要）。
 * returnContext=true 时（prepareNextTurn 内）返回替换 context 对象，不直接改状态；
 * 否则（手动 compact）直接把替换历史写回 agent state。
 */
async function compactViaHost(runtime, { manual = false, returnContext = false } = {}) {
  const result = await callParent(METHODS.compactHost, {
    sessionId: runtime.sessionId, turnId: runtime.turnId, manual,
  });
  if (!result?.compacted || !Array.isArray(result.history)) return returnContext ? undefined : false;
  emit(runtime, { type: "compaction_end", pathCount: result.pathCount, afterCount: result.afterCount });
  const state = runtime.agent.state;
  const messages = historyToMessages(result.history, runtime.model);
  if (returnContext) {
    return {
      context: {
        systemPrompt: state.systemPrompt,
        messages,
        tools: state.tools,
      },
    };
  }
  state.messages = messages;
  return true;
}

function write(msg) { process.stdout.write(encode(msg)); }
function callParent(method, params = {}) {
  const id = `host-${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(String(id), { resolve, reject });
    write({ jsonrpc: "2.0", id, method, params });
  });
}
function emit(runtime, event) {
  write(notification(METHODS.agentEvent, {
    sessionId: runtime.sessionId,
    ...(runtime.subSessionId ? { subSessionId: runtime.subSessionId } : {}),
    turnId: runtime.turnId || undefined,
    ts: Date.now(),
    event,
  }));
}
function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
function textContent(text) { return [{ type: "text", text: String(text || "") }]; }
function makeModel(provider = {}, modelId = "") {
  const id = String(modelId || provider.model || provider.modelId || "").trim() || "emsoder-model";
  return {
    id, name: id,
    api: provider.api || (provider.type === "anthropic" ? "anthropic-messages" : "openai-completions"),
    provider: provider.id || "emsoder",
    baseUrl: provider.baseUrl || "",
    reasoning: provider.reasoning !== false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number(provider.contextWindow) || 128000,
    maxTokens: Number(provider.maxTokens) || 16384,
  };
}
function historyToMessages(history, model) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const ts = Number(m?.createdAt) || Date.now();
    if (m?.role === "tool" || m?.role === "toolResult") continue;
    if (m?.role === "user") {
      out.push({ role: "user", content: String(m.content || ""), timestamp: ts });
      continue;
    }
    if (m?.role !== "assistant") continue;
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (!calls.length) {
      out.push({
        role: "assistant", content: textContent(m.content), api: model.api,
        provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "stop", timestamp: ts,
      });
      continue;
    }
    const expected = new Set();
    const content = [];
    const text = typeof m.content === "string" ? m.content : "";
    if (text) content.push({ type: "text", text });
    let malformed = false;
    for (const c of calls) {
      const id = String(c?.id || "");
      if (!id || expected.has(id)) { malformed = true; break; }
      expected.add(id);
      let args = c?.function?.arguments ?? c?.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
      content.push({ type: "toolCall", id, name: String(c?.function?.name || c?.name || "tool"), arguments: args && typeof args === "object" ? args : {} });
    }
    const results = [];
    const seen = new Set();
    let j = i + 1;
    while (j < history.length && (history[j]?.role === "tool" || history[j]?.role === "toolResult")) {
      const r = history[j]; const id = String(r.toolCallId || r.tool_call_id || "");
      if (!expected.has(id) || seen.has(id)) malformed = true;
      else { seen.add(id); results.push({ role: "toolResult", toolCallId: id, toolName: r.toolName || "tool", content: textContent(r.content), isError: false, timestamp: Number(r.createdAt) || ts }); }
      j++;
    }
    if (!malformed && seen.size === expected.size) {
      out.push({ role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "toolUse", timestamp: ts }, ...results);
    }
    i = j - 1;
  }
  return out;
}
function argsToSchemaTools(tools) {
  return Array.isArray(tools) ? tools : [];
}

/** Build Pi AgentTool descriptors that proxy tool execution back to the host. */
function makeTools(runtime, schemas) {
  return (schemas || []).map((tool) => ({
    name: tool.name, label: tool.label || tool.name,
    description: tool.description || "",
    // Parent sends the real JSON schema to the Provider; Type.Any keeps Pi's
    // validation permissive for EMSoder's existing JSON-schema definitions.
    parameters: Type.Any(),
    execute: async (toolCallId, args, signal) => {
      if (signal?.aborted) throw new Error("aborted");
      const result = await callParent(METHODS.toolInvoke, {
        sessionId: runtime.sessionId, turnId: runtime.turnId, callId: toolCallId,
        ...(runtime.subSessionId ? { subSessionId: runtime.subSessionId } : {}),
        name: tool.name, arguments: args,
      });
      if (!result?.ok) {
        const error = new Error(String(result?.content || result?.error || "tool failed"));
        error.toolResult = result;
        throw error;
      }
      return { content: textContent(result.content), details: result.details || {} };
    },
  }));
}

function buildRuntime(params) {
  const sessionId = String(params.sessionId || "");
  const provider = params.provider || {};
  const model = makeModel(provider, params.model || provider.model);
  const thinking = mapThinking(params);
  const runtime = { sessionId, turnId: params.turnId || null, provider, model,
    toolSchemas: argsToSchemaTools(params.tools), agent: null,
    thinkingLevel: thinking.thinkingLevel, thinkingBudgets: thinking.thinkingBudgets,
    runMode: params.runMode === "plan" || params.runMode === "goal" ? params.runMode : "auto",
    planApproved: params.planApproved === true, planTurnSeen: false };

  const streamFn = async (_model, context, options = {}) => {
    const stream = createAssistantMessageEventStream();
    const requestId = `provider-${nextId++}`;
    providerStreams.set(requestId, stream);
    const signal = options.signal;
    const onAbort = () => {
      callParent("provider.abort", { sessionId, turnId: runtime.turnId, requestId }).catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    callParent(METHODS.providerStream, {
      requestId, sessionId, turnId: runtime.turnId,
      provider: { ...provider, apiKey: undefined },
      model, context: { ...context, tools: runtime.toolSchemas },
      reasoning: options.reasoning,
      thinkingBudgets: options.thinkingBudgets,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    }).then((result) => {
      const base = result?.final || {
        role: "assistant", content: [], api: model.api, provider: model.provider,
        model: model.id, usage: zeroUsage(), stopReason: "pending", timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: base });
      for (const chunk of result?.events || []) {
        if (chunk.type === "text") {
          stream.push({ type: "text_delta", contentIndex: 0, delta: String(chunk.text || ""), partial: result.final || {} });
        } else if (chunk.type === "reasoning") {
          stream.push({ type: "thinking_delta", contentIndex: 0, delta: String(chunk.text || ""), partial: result.final || {} });
        } else if (chunk.type === "tool_call") {
          const call = chunk.call || {};
          stream.push({ type: "toolcall_end", contentIndex: Number(call.index) || 0, toolCall: {
            type: "toolCall", id: String(call.id || `call-${Date.now()}`),
            name: String(call.name || ""),
            arguments: typeof call.arguments === "object" ? call.arguments : (() => { try { return JSON.parse(call.arguments || "{}"); } catch { return {}; } })(),
          }, partial: result.final || {} });
        }
      }
      const final = result?.final;
      if (final) stream.push({
        type: final.stopReason === "error" || final.stopReason === "aborted" ? "error" : "done",
        reason: final.stopReason === "aborted" ? "aborted" : final.stopReason === "error" ? "error" : (final.stopReason === "toolUse" ? "toolUse" : "stop"),
        ...(final.stopReason === "error" || final.stopReason === "aborted" ? { error: final } : { message: final }),
      });
      stream.end(final);
    }).catch((error) => {
      stream.push({ type: "error", reason: "error", error: {
        role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: zeroUsage(), stopReason: "error", errorMessage: String(error?.message || error), timestamp: Date.now(),
      } });
      stream.end();
    }).finally(() => signal?.removeEventListener("abort", onAbort));
    return stream;
  };

  const tools = makeTools(runtime, params.tools);

  runtime.agent = new Agent({
    sessionId,
    streamFn,
    initialState: {
      systemPrompt: String(params.systemPrompt || ""),
      model,
      thinkingLevel: thinking.thinkingLevel,
      messages: historyToMessages(params.history, model),
      tools,
    },
    thinkingBudgets: thinking.thinkingBudgets,
    // OAuth：Pi 自行解析鉴权时经主进程取当前 access token（自动刷新）。
    // 800ms 内主进程未应答（例如测试宿主/旧宿主）视为无 token，绝不阻塞 Agent。
    getApiKey: async (providerId) => {
      try {
        const r = await Promise.race([
          callParent(METHODS.oauthToken, { provider: providerId, sessionId }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("oauth.token timeout")), 800)),
        ]);
        return typeof r?.token === "string" ? r.token : undefined;
      } catch { return undefined; }
    },
    beforeToolCall: async ({ toolCall }, signal) => {
      if (signal?.aborted) return { block: true, reason: "已停止", terminate: true };
      // plan 模式未批准前：不允许执行任何工具，把计划交回给用户
      if (runtime.runMode === "plan" && !runtime.planApproved) {
        emit(runtime, {
          type: "plan_ready",
          planText: collectAssistantText(runtime),
          note: "计划模式：已阻止工具调用，等待用户批准计划",
        });
        return { block: true, reason: "等待计划批准", terminate: true };
      }
      return undefined;
    },
    afterToolCall: async ({ toolCall, result }) => {
      emit(runtime, { type: "tool_result", toolCallId: toolCall.id, toolName: toolCall.name, result });
      return undefined;
    },
    // plan 模式：第一轮只产出计划（无工具）即停，交给用户审批；
    // goal 模式：不设提前停止，由主进程决定是否续跑。
    shouldStopAfterTurn: ({ message, context }) => {
      if (runtime.runMode === "plan" && !runtime.planApproved && !runtime.planTurnSeen) {
        runtime.planTurnSeen = true;
        emit(runtime, { type: "plan_ready", planText: collectAssistantText(runtime), note: "计划已生成，等待用户批准" });
        return true;
      }
      return false;
    },
    // Pi 完整接管压缩时机：每轮前用 Pi 自己的 token 估算 + 模型上下文窗口
    // 决策，命中阈值时请主进程执行真实压缩并替换下一轮上下文。
    prepareNextTurn: async () => {
      const decision = decideCompaction(runtime);
      if (decision.needed) {
        emit(runtime, { type: "compaction_start", tokens: decision.tokens, window: decision.window });
        try {
          const replacement = await compactViaHost(runtime, { returnContext: true });
          if (replacement) return replacement;
        } catch { /* 压缩失败不阻断本轮 */ }
      }
      return undefined;
    },
    toolExecution: "sequential",
  });
  runtime.agent.subscribe(async (event) => {
    if (event.type === "agent_start") emit(runtime, { type: "agent_start" });
    else if (event.type === "agent_end") emit(runtime, { type: "agent_end", messages: event.messages || [] });
    else if (event.type === "turn_start") emit(runtime, { type: "turn_start" });
    else if (event.type === "turn_end") emit(runtime, { type: "turn_end" });
    else if (event.type === "message_start") emit(runtime, { type: "message_start", message: event.message });
    else if (event.type === "message_update") {
      const a = event.assistantMessageEvent;
      emit(runtime, { type: "message_update",
        deltaText: a?.type === "text_delta" ? a.delta : undefined,
        deltaThinking: a?.type === "thinking_delta" ? a.delta : undefined });
    } else if (event.type === "message_end") emit(runtime, { type: "message_end", message: event.message });
    else if (event.type === "tool_execution_start") {
      emit(runtime, { type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
    } else if (event.type === "tool_execution_update") {
      emit(runtime, { type: "tool_update", toolCallId: event.toolCallId, toolName: event.toolName, partialResult: event.partialResult });
    } else if (event.type === "tool_execution_end") {
      emit(runtime, { type: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError });
    }
  });
  return runtime;
}

/** Refresh a cached runtime with the latest prompt config (skills, tools, model, history). */
function configureRuntime(runtime, params) {
  const provider = params.provider || {};
  const model = makeModel(provider, params.model || provider.model);
  const schemas = argsToSchemaTools(params.tools);
  const thinking = mapThinking(params);
  runtime.provider = { ...runtime.provider, ...provider };
  runtime.model = model;
  runtime.toolSchemas = schemas;
  runtime.thinkingLevel = thinking.thinkingLevel;
  runtime.thinkingBudgets = thinking.thinkingBudgets;
  if (params.runMode === "plan" || params.runMode === "goal") runtime.runMode = params.runMode;
  else runtime.runMode = "auto";
  if (params.planApproved === true) { runtime.planApproved = true; runtime.planTurnSeen = false; }
  const state = runtime.agent.state;
  state.systemPrompt = String(params.systemPrompt || state.systemPrompt || "");
  state.model = model;
  state.thinkingLevel = thinking.thinkingLevel;
  state.tools = makeTools(runtime, schemas);
  if (Array.isArray(params.history)) {
    state.messages = historyToMessages(params.history, model);
  }
}

function handleProviderNotification(params = {}) {
  const stream = providerStreams.get(String(params.requestId || ""));
  if (!stream) return;
  const chunk = params.chunk || {};
  const model = params.model || {};
  if (chunk.type === "text") stream.push({ type: "text_delta", contentIndex: 0, delta: String(chunk.text || ""), partial: params.partial || {} });
  else if (chunk.type === "reasoning") stream.push({ type: "thinking_delta", contentIndex: 0, delta: String(chunk.text || ""), partial: params.partial || {} });
  else if (chunk.type === "tool_call") {
    const call = chunk.call || chunk.toolCall || {};
    stream.push({ type: "toolcall_end", contentIndex: Number(call.index) || 0, toolCall: {
      type: "toolCall", id: String(call.id || `call-${Date.now()}`),
      name: String(call.name || call.function?.name || ""),
      arguments: typeof call.arguments === "object" ? call.arguments : (() => { try { return JSON.parse(call.arguments || call.function?.arguments || "{}"); } catch { return {}; } })(),
    }, partial: params.partial || {} });
  }
  else if (chunk.type === "done") {
    providerStreams.delete(String(params.requestId));
    stream.push({ type: "done", reason: "stop", message: params.message || {
      role: "assistant", content: textContent(params.text || ""), api: model.api || "openai-completions",
      provider: model.provider || "emsoder", model: model.id || "emsoder-model", usage: zeroUsage(), stopReason: "stop", timestamp: Date.now(),
    } });
    stream.end(params.message);
  } else if (chunk.type === "error") {
    providerStreams.delete(String(params.requestId));
    stream.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api || "openai-completions", provider: model.provider || "emsoder", model: model.id || "emsoder-model", usage: zeroUsage(), stopReason: "error", errorMessage: chunk.error || "provider error", timestamp: Date.now() } });
    stream.end();
  }
}

/**
 * 子 Agent runtime：同一 sidecar 进程内的独立 Agent 实例（独立上下文/工具子集/
 * 轮数上限），供主 Agent 通过 spawn_subagent 工具并行调用。文件变更归属父会话。
 */
function buildSubRuntime(params) {
  const parentSessionId = String(params.sessionId || "");
  const subSessionId = String(params.subSessionId || `sub-${nextId++}`);
  const provider = params.provider || {};
  const model = makeModel(provider, params.model || provider.model);
  const thinking = mapThinking(params);
  const maxRounds = Math.min(24, Math.max(1, Number(params.maxRounds) || 8));
  const runtime = {
    sessionId: parentSessionId, subSessionId, turnId: params.turnId || null,
    provider, model, toolSchemas: argsToSchemaTools(params.tools), agent: null,
    thinkingLevel: thinking.thinkingLevel, thinkingBudgets: thinking.thinkingBudgets,
    runMode: "auto", planApproved: true, turnCount: 0, maxRounds,
  };
  const tools = makeTools(runtime, params.tools);
  const streamFn = async (_model, context, options = {}) => {
    const stream = createAssistantMessageEventStream();
    const requestId = `subprovider-${nextId++}`;
    providerStreams.set(requestId, stream);
    const signal = options.signal;
    const onAbort = () => {
      callParent("provider.abort", { sessionId: parentSessionId, subSessionId, turnId: runtime.turnId, requestId }).catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    callParent(METHODS.providerStream, {
      requestId, sessionId: parentSessionId, subSessionId, turnId: runtime.turnId,
      provider: { ...provider, apiKey: undefined },
      model, context: { ...context, tools: runtime.toolSchemas },
      reasoning: options.reasoning,
      thinkingBudgets: options.thinkingBudgets,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    }).then((result) => {
      const base = result?.final || {
        role: "assistant", content: [], api: model.api, provider: model.provider,
        model: model.id, usage: zeroUsage(), stopReason: "pending", timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: base });
      for (const chunk of result?.events || []) {
        if (chunk.type === "text") stream.push({ type: "text_delta", contentIndex: 0, delta: String(chunk.text || ""), partial: result.final || {} });
        else if (chunk.type === "reasoning") stream.push({ type: "thinking_delta", contentIndex: 0, delta: String(chunk.text || ""), partial: result.final || {} });
        else if (chunk.type === "tool_call") {
          const call = chunk.call || {};
          stream.push({ type: "toolcall_end", contentIndex: Number(call.index) || 0, toolCall: {
            type: "toolCall", id: String(call.id || `call-${Date.now()}`),
            name: String(call.name || ""),
            arguments: typeof call.arguments === "object" ? call.arguments : (() => { try { return JSON.parse(call.arguments || "{}"); } catch { return {}; } })(),
          }, partial: result.final || {} });
        }
      }
      const final = result?.final;
      if (final) stream.push({
        type: final.stopReason === "error" || final.stopReason === "aborted" ? "error" : "done",
        reason: final.stopReason === "aborted" ? "aborted" : final.stopReason === "error" ? "error" : (final.stopReason === "toolUse" ? "toolUse" : "stop"),
        ...(final.stopReason === "error" || final.stopReason === "aborted" ? { error: final } : { message: final }),
      });
      stream.end(final);
    }).catch((error) => {
      stream.push({ type: "error", reason: "error", error: {
        role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: zeroUsage(), stopReason: "error", errorMessage: String(error?.message || error), timestamp: Date.now(),
      } });
      stream.end();
    }).finally(() => signal?.removeEventListener("abort", onAbort));
    return stream;
  };

  runtime.agent = new Agent({
    sessionId: subSessionId,
    streamFn,
    initialState: {
      systemPrompt: String(params.systemPrompt || ""),
      model,
      thinkingLevel: thinking.thinkingLevel,
      messages: [{
        role: "user",
        content: [{ type: "text", text: String(params.task || params.content || "") }],
        timestamp: Date.now(),
      }],
      tools,
    },
    thinkingBudgets: thinking.thinkingBudgets,
    beforeToolCall: async (_ctx, signal) =>
      signal?.aborted ? { block: true, reason: "已停止", terminate: true } : undefined,
    afterToolCall: async ({ toolCall, result }) => {
      emit(runtime, { type: "tool_result", toolCallId: toolCall.id, toolName: toolCall.name, result });
      return undefined;
    },
    shouldStopAfterTurn: () => {
      runtime.turnCount += 1;
      if (runtime.turnCount >= runtime.maxRounds) {
        emit(runtime, { type: "subagent_status", note: `子代理达到轮数上限 ${runtime.maxRounds}，提前收尾` });
        return true;
      }
      return false;
    },
    toolExecution: "sequential",
  });
  const done = new Promise((resolve) => { runtime.resolveDone = resolve; });
  runtime.done = done;
  runtime.agent.subscribe(async (event) => {
    if (event.type === "agent_start") emit(runtime, { type: "agent_start" });
    else if (event.type === "agent_end") {
      emit(runtime, { type: "agent_end", messages: event.messages || [] });
      runtime.resolveDone?.();
    } else if (event.type === "turn_start") emit(runtime, { type: "turn_start" });
    else if (event.type === "turn_end") emit(runtime, { type: "turn_end" });
    else if (event.type === "message_update") {
      const a = event.assistantMessageEvent;
      emit(runtime, { type: "message_update", deltaText: a?.type === "text_delta" ? a.delta : undefined, deltaThinking: a?.type === "thinking_delta" ? a.delta : undefined });
    } else if (event.type === "tool_execution_start") {
      emit(runtime, { type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
    } else if (event.type === "tool_execution_end") {
      emit(runtime, { type: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError });
    }
  });
  return runtime;
}

async function handle(method, params = {}) {
  if (method === METHODS.configure) return { ok: true, mode: "host-proxy", version: "emsoder-pi-bridge-0.1" };
  if (method === METHODS.health) return { ok: true, runtimes: runtimes.size };
  if (method === METHODS.prompt) {
    const sessionId = String(params.sessionId || "");
    if (!sessionId) throw new Error("sessionId required");
    let runtime = runtimes.get(sessionId);
    if (!runtime) { runtime = buildRuntime(params); runtimes.set(sessionId, runtime); }
    else configureRuntime(runtime, params);
    runtime.turnId = params.turnId || runtime.turnId;
    void runtime.agent.prompt(String(params.content || "")).catch((error) => emit(runtime, { type: "error", error: String(error?.message || error) }));
    return { accepted: true, turnId: runtime.turnId };
  }
  if (method === METHODS.abort || method === METHODS.stop) {
    const sessionId = String(params.sessionId || "");
    const runtime = runtimes.get(sessionId);
    // 停止父会话时连带终止其子代理，避免孤儿子代理继续占用 provider
    for (const [subId, sub] of subRuntimes) {
      if (sub.sessionId === sessionId) {
        try { sub.agent.abort(); } catch { /* ignore */ }
        subRuntimes.delete(subId);
      }
    }
    if (!runtime) return { ok: true, requested: false };
    if (method === METHODS.abort) runtime.agent.abort(); else runtime.agent.clearAllQueues();
    return { ok: true, requested: true };
  }
  if (method === METHODS.status) {
    const runtime = runtimes.get(String(params.sessionId || ""));
    return { status: runtime ? { sessionId: runtime.sessionId, currentTurnId: runtime.turnId, isRunning: runtime.agent.state.isStreaming, pendingToolConfirmations: 0, runMode: runtime.runMode, planApproved: runtime.planApproved } : { sessionId: String(params.sessionId || ""), isRunning: false, pendingToolConfirmations: 0 } };
  }
  // Pi 完整接管压缩：手动「压缩上下文」也走同一条 Pi 决策→主进程执行链路。
  if (method === METHODS.compact) {
    const runtime = runtimes.get(String(params.sessionId || ""));
    if (!runtime) return { ok: false, error: "无活动会话" };
    emit(runtime, { type: "compaction_start", manual: true });
    try {
      const applied = await compactViaHost(runtime, { manual: true });
      if (!applied) return { ok: false, error: "压缩未执行（主进程判定不需要或会话过短）" };
      return { ok: true, manual: true };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }
  // 子代理：主 Agent 的 spawn_subagent 工具调到这里，阻塞等待子代理完成并返回最终文本。
  if (method === METHODS.subagentRun) {
    const parentId = String(params.sessionId || "");
    const subSessionId = String(params.subSessionId || `sub-${nextId++}`);
    if (!parentId) throw new Error("sessionId required");
    const sub = buildSubRuntime({ ...params, sessionId: parentId, subSessionId });
    subRuntimes.set(subSessionId, sub);
    try {
      void sub.agent.prompt(String(params.task || params.content || "")).catch((error) => emit(sub, { type: "error", error: String(error?.message || error) }));
      await sub.done;
      const text = collectAssistantText(sub);
      const state = sub.agent.state;
      return {
        ok: true, subSessionId,
        content: text || "(子代理未产出文本)",
        usage: state.messages?.at(-1)?.usage || zeroUsage(),
        messageCount: state.messages?.length || 0,
      };
    } finally {
      subRuntimes.delete(subSessionId);
    }
  }
  if (method === METHODS.dispose) {
    const id = String(params.sessionId || ""); const runtime = runtimes.get(id);
    if (runtime) { runtime.agent.abort(); runtime.agent.reset(); runtimes.delete(id); }
    return { ok: true };
  }
  throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const msg = parseLine(line); if (!msg) return;
  if (msg.id != null && !msg.method) {
    const p = pending.get(String(msg.id)); if (!p) return; pending.delete(String(msg.id));
    if (msg.error) p.reject(new Error(msg.error.message || "parent error")); else p.resolve(msg.result); return;
  }
  if (msg.method === "provider.chunk") { handleProviderNotification(msg.params || {}); return; }
  if (!msg.method || msg.id == null) return;
  try { write(response(msg.id, await handle(msg.method, msg.params || {}))); }
  catch (error) { write(errorResponse(msg.id, error.code || -32000, String(error.message || error))); }
});
process.stderr.write("[emsoder-pi-sidecar] ready\n");
