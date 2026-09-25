import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { callMcpTool, envSecrets, listMcpTools, resolveHeaders } from "../workers/mcp.ts";

const TOKEN = "t0ken";
const headers = { Authorization: "Bearer ${secret:TOKEN}" };
const secrets = envSecrets({ TRINITY_SECRET_TOKEN: TOKEN });
const signal = new AbortController().signal;

/** Two pages, the second with a tool that omits its description and input schema. */
const pages = [
  [
    { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "fail", inputSchema: { type: "object" } },
  ],
  [{ name: "media", description: "Non-text content", inputSchema: { type: "object" } }, { name: "wait" }],
];

function tools(hooks: { started: () => void; cancelled: () => void }): McpServer {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  server.registerTool("echo", { description: "Echo text", inputSchema: { text: z.string() } }, ({ text }) => ({
    content: [{ type: "text", text }, { type: "text", text: "done" }],
  }));
  server.registerTool("fail", {}, () => ({ content: [{ type: "text", text: "nope" }], isError: true }));
  server.registerTool("media", {}, () => ({
    content: [
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "resource_link", uri: "file:///a.txt", name: "a" },
      { type: "resource", resource: { uri: "file:///b.txt", text: "embedded" } },
      { type: "resource", resource: { uri: "file:///c.bin", blob: "AAEC", mimeType: "application/octet-stream" } },
    ],
    structuredContent: { ok: true },
  }));
  server.registerTool("wait", {}, (extra) => new Promise((resolve) => {
    extra.signal.addEventListener("abort", () => { hooks.cancelled(); resolve({ content: [] }); });
    hooks.started();
  }));
  server.server.setRequestHandler(ListToolsRequestSchema, (request) => {
    const page = Number(request.params?.cursor ?? 0);
    return { tools: pages[page], ...(page + 1 < pages.length ? { nextCursor: String(page + 1) } : {}) } as never;
  });
  return server;
}

/** Streamable HTTP with sessions at /mcp, the older HTTP+SSE transport at /sse, both behind a bearer token. */
async function serve(t: TestContext) {
  const hooks = { started: () => {}, cancelled: () => {} };
  const started = new Promise<void>((resolve) => { hooks.started = resolve; });
  const cancelled = new Promise<void>((resolve) => { hooks.cancelled = resolve; });
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const legacy = new Map<string, SSEServerTransport>();
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
    const { pathname, searchParams } = new URL(req.url ?? "/", "http://localhost");
    if (pathname === "/mcp") {
      const id = req.headers["mcp-session-id"];
      let transport = typeof id === "string" ? sessions.get(id) : undefined;
      if (!transport) {
        if (id !== undefined) return void res.writeHead(404).end();
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (session) => void sessions.set(session, created),
          onsessionclosed: (session) => void sessions.delete(session),
        });
        await tools(hooks).connect(created);
        transport = created;
      }
      await transport.handleRequest(req, res);
    } else if (pathname === "/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/messages", res);
      legacy.set(transport.sessionId, transport);
      res.on("close", () => legacy.delete(transport.sessionId));
      await tools(hooks).connect(transport);
    } else if (pathname === "/messages" && req.method === "POST") {
      const transport = legacy.get(searchParams.get("sessionId") ?? "");
      if (!transport) return void res.writeHead(404).end();
      await transport.handlePostMessage(req, res);
    } else {
      res.writeHead(405).end();
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    http.closeAllConnections();
    http.close();
  });
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return { url: `${base}/mcp`, legacyUrl: `${base}/sse`, sessions, started, cancelled };
}

test("header secrets resolve from TRINITY_SECRET_ variables", () => {
  const env = envSecrets({ TRINITY_SECRET_MY_TOKEN: "abc", TRINITY_SECRET_ORG: "o1" });
  assert.deepEqual(resolveHeaders({ Authorization: "Bearer ${secret:my-token}", "X-Org": "${secret:org}/${secret:ORG}", Plain: "x" }, env),
    { Authorization: "Bearer abc", "X-Org": "o1/o1", Plain: "x" });
  assert.deepEqual(resolveHeaders(undefined, env), {});
  assert.throws(() => resolveHeaders(headers, env), { message: "Secret TOKEN for MCP header Authorization is not set" });
  const injected = envSecrets({ TRINITY_SECRET_TOKEN: "abc\r\nX-Evil: 1" });
  assert.throws(() => resolveHeaders(headers, injected), (error: Error) => !error.message.includes("abc") && error.message.includes("TOKEN"));
});

test("lists every page of tools, with defaults, and ends its session", async (t) => {
  const server = await serve(t);
  assert.deepEqual(await listMcpTools({ url: server.url, headers }, secrets), [
    { name: "echo", description: "Echo text", inputSchema: pages[0]![0]!.inputSchema },
    { name: "fail", description: "", inputSchema: { type: "object" } },
    { name: "media", description: "Non-text content", inputSchema: { type: "object" } },
    { name: "wait", description: "", inputSchema: { type: "object" } },
  ]);
  assert.equal(server.sessions.size, 0);
});

test("calls tools and reports their error results", async (t) => {
  const server = await serve(t);
  const config = { url: server.url, headers };
  assert.deepEqual(await callMcpTool(config, secrets, "echo", { text: "hi" }, signal), { content: "hi\ndone", isError: false });
  assert.deepEqual(await callMcpTool(config, secrets, "fail", {}, signal), { content: "nope", isError: true });
  assert.deepEqual(await callMcpTool(config, secrets, "media", {}, signal), {
    content: [
      '{"ok":true}',
      "[image image/png, 8 bytes base64]",
      "[resource file:///a.txt]",
      "embedded",
      "[resource file:///c.bin application/octet-stream, 4 bytes base64]",
    ].join("\n"),
    isError: false,
  });
  assert.equal(server.sessions.size, 0);
});

test("falls back to HTTP+SSE when the server refuses Streamable HTTP", async (t) => {
  const server = await serve(t);
  const config = { url: server.legacyUrl, headers };
  assert.equal((await listMcpTools(config, secrets)).length, 4);
  assert.deepEqual(await callMcpTool(config, secrets, "echo", { text: "old" }, signal), { content: "old\ndone", isError: false });
});

test("missing secrets and refused credentials fail without a fallback", async (t) => {
  const server = await serve(t);
  await assert.rejects(listMcpTools({ url: server.url, headers }, () => undefined), { message: "Secret TOKEN for MCP header Authorization is not set" });
  await assert.rejects(listMcpTools({ url: server.url, headers }, envSecrets({ TRINITY_SECRET_TOKEN: "wrong" })), { code: 401 });
});

test("aborting a call rejects with the reason and cancels the tool", async (t) => {
  const server = await serve(t);
  const reason = new Error("lease lost");
  await assert.rejects(callMcpTool({ url: server.url, headers }, secrets, "wait", {}, AbortSignal.abort(reason)), (error) => error === reason);
  const stop = new AbortController();
  const call = callMcpTool({ url: server.url, headers }, secrets, "wait", {}, stop.signal);
  await server.started;
  stop.abort(reason);
  await assert.rejects(call, (error) => error === reason);
  await server.cancelled;
});
