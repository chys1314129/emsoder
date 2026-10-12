/**
 * Unit smoke for the MCP stdio client + manager.
 * Spawns a mock stdio MCP server (pure node, JSON-RPC over newline-delimited lines).
 * Usage: node scripts/test-mcp.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { McpStdioClient, McpHttpClient } = require("../src/mcp/client");
const { McpManager } = require("../src/mcp/manager");

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}

const MOCK_SERVER = `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
let inited = false;
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const respondError = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n");
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== "object") return;
  if (msg.method === "initialize") {
    inited = true;
    respond(msg.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0.0" } });
  } else if (msg.method === "tools/list") {
    respond(msg.id, { tools: [
      { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      { name: "fail", description: "Always fails", inputSchema: { type: "object", properties: {} } },
    ] });
  } else if (msg.method === "tools/call") {
    const name = msg.params?.name;
    if (name === "echo") {
      respond(msg.id, { content: [{ type: "text", text: "echo:" + (msg.params?.arguments?.text || "") }], isError: false });
    } else if (name === "fail") {
      respond(msg.id, { content: [{ type: "text", text: "boom" }], isError: true });
    } else {
      respondError(msg.id, -32602, "Unknown tool: " + name);
    }
  } else if (msg.method === "ping") {
    respond(msg.id, {});
  } else {
    respondError(msg.id, -32601, "Method not found: " + msg.method);
  }
});
`;

const HANG_SERVER = `
setInterval(() => {}, 1000); // never respond
`;

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emsoder-mcp-"));
  const mockPath = path.join(tmpDir, "mock-server.js");
  const hangPath = path.join(tmpDir, "hang-server.js");
  fs.writeFileSync(mockPath, MOCK_SERVER, "utf8");
  fs.writeFileSync(hangPath, HANG_SERVER, "utf8");

  const baseCfg = (script) => ({
    id: "mock",
    name: "Mock",
    command: process.execPath,
    args: [script],
    env: {},
    enabled: true,
  });

  // --- handshake + tools/list + call ---
  const client = new McpStdioClient(baseCfg(mockPath), {});
  await client.start();
  assert(client.status === "running", "client should be running after handshake");
  const tools = await client.refreshTools();
  assert(tools.length === 2, "tools/list should return 2 tools");
  assert(tools[0].name === "echo", "first tool is echo");

  const r1 = await client.callTool("echo", { text: "hi" });
  assert(r1.ok && r1.content === "echo:hi", "call echo should return text");
  const r2 = await client.callTool("fail", {});
  assert(r2.ok && r2.isError === true && r2.content === "boom", "isError should pass through");
  const r3 = await client.callTool("nope", {});
  assert(!r3.ok, "unknown tool should fail");
  assert(/Unknown tool/.test(r3.content), "unknown tool error message");
  client.stop();
  assert(client.status === "stopped", "stop should set stopped");

  // --- timeout: server never responds to initialize ---
  const hangClient = new McpStdioClient(baseCfg(hangPath), {});
  let hung = false;
  try {
    await hangClient.start();
  } catch {
    hung = true;
  }
  assert(hung, "hang server should time out initialize");
  assert(hangClient.status === "error", "hang server should go to error state");
  hangClient.stop();

  // --- manager: prefix routing + getTools ---
  const manager = new McpManager({});
  manager.reload({ mcpServers: [baseCfg(mockPath)] });
  await new Promise((r) => setTimeout(r, 800)); // wait async connect
  const servers = manager.list();
  assert(servers.length === 1, "manager should have 1 server");
  assert(servers[0].status === "running", "manager server should run");
  assert(servers[0].toolCount === 2, "manager toolCount should be 2");

  const tools2 = manager.getTools();
  assert(tools2.length === 2, "getTools should return 2");
  assert(tools2[0].function.name === "mcp__mock__echo", "tool name prefix mcp__<id>__<tool>");
  assert(tools2[0].function.parameters.type === "object", "inputSchema as parameters");

  const call1 = await manager.callTool("mcp__mock__echo", JSON.stringify({ text: "x" }));
  assert(call1.ok && call1.content === "echo:x", "manager routes callTool");
  const call2 = await manager.callTool("mcp__mock__nope", "{}");
  assert(!call2.ok, "manager unknown tool fails");
  const call3 = await manager.callTool("nope__x__y", "{}");
  assert(!call3.ok, "manager rejects bad prefix");

  manager.stopAll();
  assert(manager.list().length === 0, "stopAll clears servers");

  // --- streamable HTTP client (in-process mock server) ---
  let seenSessionIds = [];
  const httpServer = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("{}");
        return;
      }
      const respond = (result, status = 200) => {
        const headers = {
          "Content-Type": "application/json",
          "Mcp-Protocol-Version": "2024-11-05",
          "Mcp-Session-Id": "sess-123",
        };
        res.writeHead(status, headers);
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };
      if (msg.method === "initialize") {
        seenSessionIds.push(req.headers["mcp-session-id"] || "");
        respond({
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "http-mock", version: "1.0.0" },
        });
      } else if (msg.method === "tools/list") {
        respond({
          tools: [
            { name: "web_search", description: "Search the web", inputSchema: { type: "object", properties: {} } },
          ],
        });
      } else if (msg.method === "tools/call") {
        const name = msg.params?.name;
        if (name === "web_search") {
          respond({ content: [{ type: "text", text: "results for " + (msg.params?.arguments?.q || "") }], isError: false });
        } else {
          res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sess-123" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Unknown tool: " + name } }));
        }
      } else {
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sess-123" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }));
      }
    });
  });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = httpServer.address().port;
  const httpUrl = `http://127.0.0.1:${port}/mcp`;

  const httpClient = new McpHttpClient(
    { id: "web", name: "Web", type: "http", url: httpUrl, timeoutMs: 3000 },
    {}
  );
  await httpClient.start();
  assert(httpClient.status === "running", "http client should run after handshake");
  assert(httpClient.sessionId === "sess-123", "http client captures session id");
  const hTools = await httpClient.refreshTools();
  assert(hTools.length === 1 && hTools[0].name === "web_search", "http tools/list");
  const hCall = await httpClient.callTool("web_search", { q: "mcp" });
  assert(hCall.ok && hCall.content === "results for mcp", "http tools/call");
  const hBad = await httpClient.callTool("nope", {});
  assert(!hBad.ok && /Unknown tool/.test(hBad.content), "http unknown tool");
  httpClient.stop();
  assert(httpClient.status === "stopped", "http stop");

  // http timeout: server never responds → error state
  const slowServer = http.createServer(() => {
    /* never respond */
  });
  await new Promise((r) => slowServer.listen(0, "127.0.0.1", r));
  const slowPort = slowServer.address().port;
  const slowClient = new McpHttpClient(
    { id: "slow", name: "Slow", type: "http", url: `http://127.0.0.1:${slowPort}/mcp`, timeoutMs: 1000 },
    {}
  );
  let slowFailed = false;
  try {
    await slowClient.start();
  } catch {
    slowFailed = true;
  }
  assert(slowFailed, "http hang should time out");
  assert(slowClient.status === "error", "http hang -> error status");
  slowClient.stop();
  slowServer.close();

  // --- SSE 流：结果前混入 progress 通知 + ping，只取 id 匹配的响应 ---
  const sseServer = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      if (msg.method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "sse-mock", version: "1.0.0" } } }));
        return;
      }
      if (msg.method === "tools/list") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        // progress 通知（无 id）→ ping 通知 → 最终响应（多行 data + 末尾补一个多余事件）
        const events = [
          { event: "message", data: JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 0.5 } }) },
          { event: "message", data: JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } }) },
          { event: "message", data: "event: ping\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"ping\"}" },
          { event: "message", data: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "sse_tool", description: "SSE tool", inputSchema: { type: "object", properties: {} } }] } }) },
          // 结尾再来一个无关通知（旧实现会误取这一行）
          { event: "message", data: JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }) },
        ];
        let body2 = "";
        for (const ev of events) {
          body2 += `event: ${ev.event}\ndata: ${ev.data}\n\n`;
        }
        res.end(body2);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "sse-ok" }] } })}\n\n`);
    });
  });
  await new Promise((r) => sseServer.listen(0, "127.0.0.1", r));
  const ssePort = sseServer.address().port;
  const sseClient = new McpHttpClient(
    { id: "sse", name: "SSE", type: "http", url: `http://127.0.0.1:${ssePort}/mcp`, timeoutMs: 3000 },
    {}
  );
  await sseClient.start();
  assert(sseClient.status === "running", "sse client should run");
  const sseTools = await sseClient.refreshTools();
  assert(sseTools.length === 1 && sseTools[0].name === "sse_tool", "sse tools/list picks id-matched response");
  const sseCall = await sseClient.callTool("sse_tool", {});
  assert(sseCall.ok && sseCall.content === "sse-ok", "sse tools/call");
  sseClient.stop();
  assert(sseClient.status === "stopped", "sse stop");
  sseServer.close();
  slowClient.stop();
  slowServer.close();

  // manager with http server config
  const httpManager = new McpManager({});
  httpManager.reload({
    mcpServers: [
      { id: "web", name: "Web", type: "http", url: httpUrl, enabled: true, timeoutMs: 3000 },
    ],
  });
  await new Promise((r) => setTimeout(r, 400));
  const mSrv = httpManager.list();
  assert(mSrv.length === 1 && mSrv[0].status === "running", "manager http server runs");
  assert(mSrv[0].type === "http", "manager reports http type");
  const mTools = httpManager.getTools();
  assert(mTools.length === 1 && mTools[0].function.name === "mcp__web__web_search", "http tool naming");
  const mCall = await httpManager.callTool("mcp__web__web_search", JSON.stringify({ q: "x" }));
  assert(mCall.ok && mCall.content === "results for x", "manager http call");
  httpManager.stopAll();
  httpServer.close();

  // cleanup
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  console.log("OK mcp smoke test");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
