/** Pi sidecar NDJSON JSON-RPC protocol constants and small validators. */
const METHODS = Object.freeze({
  configure: "sidecar.configure",
  health: "sidecar.health",
  prompt: "agent.prompt",
  abort: "agent.abort",
  stop: "agent.stop",
  status: "agent.getStatus",
  compact: "agent.compact",
  dispose: "agent.disposeSession",
  toolInvoke: "tool.invoke",
  providerStream: "provider.stream",
  prepareTurn: "agent.prepareTurn",
  compactHost: "agent.compactHost",
  subagentRun: "agent.subagentRun",
  oauthToken: "oauth.token",
  agentEvent: "agent.event",
  hostProxy: "host.proxy",
});

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseLine(line) {
  if (!String(line || "").trim()) return null;
  try {
    const value = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function encode(message) {
  return JSON.stringify(message) + "\n";
}

function request(id, method, params = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function notification(method, params = {}) {
  return { jsonrpc: "2.0", method, params };
}

module.exports = {
  METHODS,
  parseLine,
  encode,
  request,
  response,
  errorResponse,
  notification,
  isObject,
};
