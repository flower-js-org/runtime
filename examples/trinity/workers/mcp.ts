import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import type { ToolOutcome } from "../app/model.ts";

export interface McpServerConfig { url: string; headers?: Record<string, string> }
export type SecretResolver = (name: string) => string | undefined;
export interface McpToolInfo { name: string; description: string; inputSchema: Record<string, unknown> }

const CLIENT = { name: "trinity", version: "1.0.0" };
/** The SDK times requests out after 60 s by default, too soon for slow tools. The caller's signal bounds the rest. */
const CALL_TIMEOUT_MS = 10 * 60_000;
const TERMINATE_MS = 1_000;
const SECRET = /\$\{secret:([^}]+)\}/g;

/** Looser than the SDK's schema, which refuses the whole list over one tool without an input schema. */
const toolPage = z.object({
  tools: z.array(z.object({
    name: z.string(),
    description: z.string().nullish(),
    inputSchema: z.record(z.string(), z.unknown()).nullish(),
  })),
  nextCursor: z.string().nullish(),
});

/** TRINITY_SECRET_<NAME> from the environment (name upper-cased, non-alphanumerics → _). */
export function envSecrets(env: NodeJS.ProcessEnv = process.env): SecretResolver {
  return (name) => env[`TRINITY_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
}

/** Replace every `${secret:NAME}` in header values; throw an Error naming the missing secret (never its value). */
export function resolveHeaders(headers: Record<string, string> | undefined, secrets: SecretResolver): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, template] of Object.entries(headers ?? {})) {
    resolved[key] = template.replace(SECRET, (_, name: string) => {
      const value = secrets(name);
      if (value === undefined) throw new Error(`Secret ${name} for MCP header ${key} is not set`);
      // fetch would refuse these with an error that quotes the whole value.
      if (/[\r\n\0]/.test(value)) throw new Error(`Secret ${name} for MCP header ${key} is not a valid header value`);
      return value;
    });
  }
  return resolved;
}

export function listMcpTools(server: McpServerConfig, secrets: SecretResolver, signal?: AbortSignal): Promise<McpToolInfo[]> {
  return withClient(server, secrets, signal, async (client) => {
    const tools: McpToolInfo[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.request({ method: "tools/list", params: cursor === undefined ? {} : { cursor } }, toolPage, { signal });
      for (const tool of page.tools) {
        tools.push({ name: tool.name, description: tool.description ?? "", inputSchema: { type: "object", ...tool.inputSchema } });
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor !== undefined && cursors.has(cursor)) throw new Error(`MCP server repeated tools/list cursor ${cursor}`);
      if (cursor !== undefined) cursors.add(cursor);
    } while (cursor !== undefined);
    return tools;
  });
}

/** A tool's own failure is an error result; transport and protocol failures (including McpError responses) throw. */
export function callMcpTool(
  server: McpServerConfig, secrets: SecretResolver, tool: string, args: Record<string, unknown>, signal: AbortSignal,
): Promise<ToolOutcome> {
  return withClient(server, secrets, signal, async (client) => {
    const result = await client.request(
      { method: "tools/call", params: { name: tool, arguments: args } }, CallToolResultSchema, { signal, timeout: CALL_TIMEOUT_MS },
    );
    return { content: render(result), isError: result.isError ?? false };
  });
}

function render({ content, structuredContent }: CallToolResult): string {
  const parts = content.map((part) => {
    switch (part.type) {
      case "text": return part.text;
      case "image":
      case "audio": return `[${part.type} ${part.mimeType}, ${part.data.length} bytes base64]`;
      case "resource_link": return `[resource ${part.uri}]`;
      case "resource": {
        const { resource } = part;
        if ("text" in resource) return resource.text;
        return `[resource ${resource.uri}${resource.mimeType ? ` ${resource.mimeType}` : ""}, ${resource.blob.length} bytes base64]`;
      }
    }
  });
  if (structuredContent !== undefined && !content.some((part) => part.type === "text")) parts.unshift(JSON.stringify(structuredContent));
  return parts.join("\n");
}

/** Connect over Streamable HTTP, or the older HTTP+SSE transport for servers that refuse it, and always disconnect. */
async function withClient<T>(
  server: McpServerConfig, secrets: SecretResolver, signal: AbortSignal | undefined, use: (client: Client) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const url = new URL(server.url);
  const requestInit: RequestInit = { headers: resolveHeaders(server.headers, secrets) };
  const streamable = new StreamableHTTPClientTransport(url, { requestInit });
  let client = new Client(CLIENT);
  try {
    try {
      await abortable(client.connect(streamable, { signal }), signal);
    } catch (error) {
      if (signal?.aborted || !refusesStreamable(error)) throw error;
      client = new Client(CLIENT);
      try {
        await abortable(client.connect(new SSEClientTransport(url, { requestInit }), { signal }), signal);
      } catch (fallback) {
        if (signal?.aborted) throw fallback;
        throw new AggregateError([error, fallback], `${describe(error)}; SSE fallback: ${describe(fallback)}`);
      }
    }
    return await abortable(use(client), signal);
  } finally {
    // Each operation opens its own session; stateful servers keep it until told otherwise.
    if (streamable.sessionId !== undefined) await within(TERMINATE_MS, streamable.terminateSession());
    await client.close();
  }
}

/** Servers that only speak HTTP+SSE answer the initializing POST with a 4xx. Refused credentials are not that. */
function refusesStreamable(error: unknown): boolean {
  if (!(error instanceof StreamableHTTPError) || error.code === undefined) return false;
  return error.code >= 400 && error.code < 500 && error.code !== 401 && error.code !== 403;
}

/** The SDK ignores the signal while a transport starts, so every step races it; closing the client cleans up. */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

async function within(ms: number, work: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([work.catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
