import { v, type Json } from "@flower-js/sdk";

// The log

/** Assistant content in a provider-neutral form. Thinking signatures and provider blocks are replayed verbatim. */
export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_call"; id: string; name: string; input: Json }
  /** Server-side tool traffic (web search, web fetch) that only its provider can interpret. */
  | { type: "provider"; provider: "anthropic"; block: Json };

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Role = "user" | "worker" | "computer" | "service";
export type Status = "idle" | "working" | "waiting_on_user" | "halted" | "error";
export type Approval = "permission" | "elicitation";
export type Resolution = "approved" | "denied" | "answered" | "preempted" | "cancelled" | "timed_out";

export interface Attachment { blob: string; name: string; mediaType: string; size: number }

export type Body =
  | { type: "user"; message: string; text: string; attachments: Attachment[]; author: string | null }
  | { type: "assistant"; blocks: Block[]; model: string; stopReason: string | null; usage: Usage | null; costNanos: number; interrupted: boolean }
  | { type: "tool_result"; call: string; content: string; isError: boolean; blob: string | null }
  | { type: "tool_awaiting"; call: string; kind: Approval; prompt: string }
  | { type: "tool_resolved"; call: string; resolution: Resolution; by?: string }
  | { type: "background_result"; call: string; content: string; isError: boolean; blob: string | null }
  | { type: "subagent"; call: string; session: string }
  | { type: "compact"; summary: string }
  | { type: "error"; code: string; message: string; retryInMs: number | null }
  | { type: "status"; status: Status }
  | { type: "interrupted" }
  | { type: "title"; title: string };

export interface Event { session: string; seq: number; at: number; body: Body }

// Sessions

/** A tool call of the current batch. Resolved calls stay until the next completion starts. */
export interface Call {
  id: string;
  name: string;
  input: Json;
  state: "awaiting" | "running" | "done";
  approval: Approval | null;
  /** What the user is asked, while awaiting. */
  prompt: string | null;
  /** The tool job running it, or the subagent session answering it. */
  job: { id: string; scope: string } | null;
  child: string | null;
}

export interface Turn {
  /** The message that opened the turn. */
  message: string;
  /** A completion is due once no call is outstanding. */
  owed: boolean;
  calls: Record<string, Call>;
  completion: { step: number; job: string; uptoSeq: number; kind: CompletionKind } | null;
  /** A halt waiting for running tools to finish within the grace window. */
  halting: { until: number } | null;
  /** The previous completion's kind, so a compaction is never followed by another. */
  lastKind: CompletionKind | null;
}

export interface Queued {
  id: string;
  text: string;
  steer: boolean;
  at: number;
  attachments: Attachment[];
  author: string | null;
  /** A background call's result, admitted like a steer. */
  result: { call: string; content: string; isError: boolean; blob: string | null } | null;
}

export interface Session {
  id: string;
  org: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  title: string | null;
  model: string;
  system: string | null;
  /** The computer whose tool scope runs this session's computer tools. */
  computer: string | null;
  private: boolean;
  parent: { session: string; call: string } | null;
  source: Source | null;
  status: Status;
  seq: number;
  steps: number;
  turn: Turn | null;
  queued: Queued[];
  /** Tools that run without asking. */
  allow: string[];
  webTools: boolean;
  graceMs: number;
  /** Compact the log before a completion whose request would exceed this estimate. */
  contextTokens: number;
  /** Estimated input tokens of the next request. */
  contextEstimate: number;
  /** The latest compact event; requests start there. */
  compactSeq: number;
  /** Events up to here were moved to segments in blob storage. */
  sealedThrough: number;
  /** Sealing requested while a seal job was already running. */
  sealWanted: number;
  /** Background calls still running, by call ID. */
  background: Record<string, { id: string; scope: string; name: string }>;
  memory: string | null;
  lastText: string | null;
  usage: Usage;
  costNanos: number;
  archived: boolean;
}

/** Where a surface session's conversation lives: a Slack thread, a GitHub issue. */
export interface Source {
  surface: string;
  thread: string;
  /** A link to the thread, for people switching between the surface and the web. */
  url?: string;
  /** How to name the thread, like "#eng" or "a direct message". */
  label?: string;
}

// Organizations

export interface OrgSettings {
  model: string;
  /** The computer new sessions use unless they pick one: automations, surfaces, and users who don't choose. */
  computer: string | null;
  webTools: boolean;
  graceMs: number;
  contextTokens: number;
  /** Monthly spending limit in nanodollars. */
  budgetNanos: number | null;
  stripeCustomer: string | null;
  stripeMeter: string;
}
export interface Org { id: string; name: string; createdAt: number; createdBy: string; settings: OrgSettings }
export interface Member { org: string; subject: string; role: "admin" | "member"; name: string | null; joinedAt: number }

// Work for workers

export interface Delta { index: number; type: "text" | "thinking" | "tool_call"; name?: string; text: string }
export interface PartialFlush { session: string; n: number; deltas: Delta[] }
export interface PartialHead { step: number; token: number; next: number }

export type CompletionKind = "respond" | "compact";
export interface CompletionJob { session: string; step: number; uptoSeq: number; kind: CompletionKind }
export interface CompletionMessage { blocks: Block[]; model: string; stopReason: string | null; usage: Usage }
export type CompletionOutcome =
  | { ok: true; message: CompletionMessage }
  | { ok: false; error: { code: string; message: string; retryable: boolean; retryAfterMs?: number } };

export interface McpCall { server: string; tool: string; url: string; headers: Record<string, string> }
export interface ToolJob { session: string; call: string; name: string; input: Json; background: boolean; mcp: McpCall | null }
export interface ToolOutcome { content: string; isError: boolean; blob?: string }

export type ToolDefinition =
  | { name: string; description: string; input_schema: Json }
  /** A provider-run tool, passed through as declared. */
  | { type: string; name: string; [option: string]: Json };

export interface Segment { session: string; from: number; to: number; key: string; count: number }

export interface Prompt {
  kind: CompletionKind;
  /** The first log position the request includes: the latest compact event, or 1. */
  start: number;
  model: string;
  system: string;
  tools: ToolDefinition[];
  /** Sealed events the request needs, oldest first, before `events`. */
  segments: Segment[];
  events: Event[];
}

// Schemas for what callers and workers send

export const id = v.string({ min: 1, max: 128 });
const blobKey = v.string({ min: 1, max: 256 });

export const blockSchema = v.union(
  v.object({ type: v.literal("text"), text: v.string() }),
  v.object({ type: v.literal("thinking"), thinking: v.string(), signature: v.string() }),
  v.object({ type: v.literal("redacted_thinking"), data: v.string() }),
  v.object({ type: v.literal("tool_call"), id: v.string({ min: 1, max: 256 }), name: v.string({ min: 1, max: 128 }), input: v.json() }),
  v.object({ type: v.literal("provider"), provider: v.literal("anthropic"), block: v.json() }),
);

const count = v.int({ min: 0 });
export const usageSchema = v.object({ input: count, output: count, cacheRead: count, cacheWrite: count });

export const outcomeSchema = v.union(
  v.object({
    ok: v.literal(true),
    message: v.object({ blocks: v.array(blockSchema), model: v.string({ min: 1 }), stopReason: v.nullable(v.string()), usage: usageSchema }),
  }),
  v.object({
    ok: v.literal(false),
    error: v.object({ code: v.string({ min: 1 }), message: v.string(), retryable: v.boolean(), retryAfterMs: v.optional(count) }),
  }),
);

export const deltaSchema = v.object({
  index: count,
  type: v.enum(["text", "thinking", "tool_call"]),
  name: v.optional(v.string()),
  text: v.string(),
});

export const attachmentSchema = v.object({
  blob: blobKey,
  name: v.string({ min: 1, max: 512 }),
  mediaType: v.string({ min: 1, max: 128 }),
  size: count,
});

export const toolOutcomeSchema = v.object({ content: v.string({ max: 4_000_000 }), isError: v.boolean(), blob: v.optional(blobKey) });

/** The claim identity a worker sends back unchanged. */
export const lease = {
  id: v.string({ min: 1 }),
  owner: v.string({ min: 1 }),
  token: v.int({ min: 1 }),
  history: v.optional(v.object({ database: v.string(), incarnation: v.string() })),
};

export const workerError = v.object({ message: v.string() }, { rest: v.json() });

// Helpers

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A 53-bit string hash (cyrb53). Detects accidental mismatches between a worker's copy and the log; not a security boundary. */
export function checksum(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}
