import { aggregate, collection, external, v, type Json } from "@flower-js/sdk";
import { queue } from "@flower-js/sdk/temporal";
import {
  id, type Approval, type CompletionJob, type CompletionOutcome, type Event, type Member, type Org, type PartialFlush, type PartialHead,
  type ReviewJob, type ReviewOutcome, type Segment, type Session, type ToolJob, type ToolOutcome,
} from "./model.ts";

// Sessions and their logs

export const sessions = collection<Session>("sessions").index("byOrg", ["org", "updatedAt"]);

export const events = collection<Event>("events")
  .key(v.tuple([id, v.int({ min: 1 })]))
  .index("bySession", ["session", "seq"]);

/** Streamed deltas of the running completion, one row per worker flush. */
export const partials = collection<PartialFlush>("partials")
  .key(v.tuple([id, v.int({ min: 0 })]))
  .index("bySession", ["session", "n"]);
export const partialHeads = collection<PartialHead>("partialHeads");

/** Log ranges moved to blob storage, oldest first. */
export const segments = collection<Segment>("segments")
  .key(v.tuple([id, v.int({ min: 1 })]))
  .index("bySession", ["session", "from"]);

/** Blobs a session's log refers to (attachments, stored outputs, segments), which its readers may fetch. */
export const blobRefs = collection<{ session: string; key: string }>("blobRefs").key(v.tuple([id, v.string({ min: 1, max: 256 })]));

// Organizations and usage

export const orgs = collection<Org>("orgs");

export const members = collection<Member>("members")
  .key(v.tuple([id, v.string({ min: 1, max: 256 })]))
  .index("bySubject", ["subject"])
  .index("byOrg", ["org"]);

export interface UsageRow {
  org: string;
  month: string;
  session: string;
  step: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costNanos: number;
  at: number;
}
export const usage = collection<UsageRow>("usage")
  .key(v.tuple([id, v.string(), id, v.int({ min: 0 })]))
  .index("byOrgMonth", ["org", "month"]);

export interface Spend { costNanos: number; input: number; output: number; completions: number }
/** Each organization's monthly totals, kept current as usage rows arrive. */
export const spend = aggregate("org.spend", {
  source: usage,
  index: "byOrgMonth",
  initial: (): Spend => ({ costNanos: 0, input: 0, output: 0, completions: 0 }),
  add: (total: Spend, row: UsageRow): Spend => ({
    costNanos: total.costNanos + row.costNanos,
    input: total.input + row.input,
    output: total.output + row.output,
    completions: total.completions + 1,
  }),
  remove: (total: Spend, row: UsageRow): Spend => ({
    costNanos: total.costNanos - row.costNanos,
    input: total.input - row.input,
    output: total.output - row.output,
    completions: total.completions - 1,
  }),
});

// What sessions work with

/**
 * A surface thread (a Slack thread, a GitHub issue) and the session answering it. `pending`
 * lists the thread's messages the running turn owes an answer, `acked` the message that last
 * got one, and `cards` the thread's prompts for calls still awaiting someone.
 */
/** Something said in a thread, as the session reads it: a message, an edit or deletion of one, or a count of messages left out. */
export type ThreadEntry =
  | {
    kind: "message" | "edited" | "deleted";
    /** The surface's ID for the message. */
    message: string;
    /** Who said it, as people in the thread know them. */
    name: string;
    text: string;
    /** The member (or surface account) who addressed the agent; absent for everything else said in the thread. */
    author?: string;
  }
  | { kind: "omitted"; count: number };

export interface Binding {
  surface: string;
  thread: string;
  org: string;
  session: string;
  meta: Json;
  pending?: string[];
  acked?: string | null;
  cards?: Record<string, string>;
  /** People told once that the agent answers only when mentioned. */
  nudged?: string[];
  /** What the thread said without addressing the agent, held for the next message that does. */
  held?: ThreadEntry[];
  /** The queued message the thread's entries join until the session takes it in. */
  batch?: string;
}
export const bindings = collection<Binding>("bindings").key(v.tuple([id, v.string({ min: 1, max: 512 })]));

/** A Slack workspace connected to an organization. The gateway seals the bot token; only workers unseal it. */
export interface SlackInstall {
  team: string;
  org: string;
  name: string;
  /** The workspace's address, like https://acme.slack.com/. */
  url: string;
  botUser: string;
  botId: string;
  token: string;
  installedBy: string;
  installedAt: number;
}
export const slackInstalls = collection<SlackInstall>("slackInstalls").index("byOrg", ["org"]);

/** A Slack user and the member they act as. */
export interface SlackLink { team: string; user: string; org: string; subject: string; linkedAt: number }
export const slackLinks = collection<SlackLink>("slackLinks")
  .key(v.tuple([id, id]))
  .index("bySubject", ["org", "subject"]);

/** Slack messages in bound threads, so a reaction on any of them finds its session. */
export const slackMessages = collection<{ thread: string }>("slackMessages").key(v.tuple([id, id, id]));

export interface McpServer { org: string; name: string; url: string; headers: Record<string, string>; trusted: boolean; enabled: boolean; updatedAt: number }
export const mcpServers = collection<McpServer>("mcpServers")
  .key(v.tuple([id, id]))
  .index("byOrg", ["org"]);

export interface Computer {
  id: string;
  org: string;
  owner: string;
  name: string;
  kind: "local" | "docker";
  image: string | null;
  /** For sandboxes, whether the provider runs one. Local computers are online while they heartbeat. */
  state: "stopped" | "starting" | "running" | "stopping";
  lastSeenAt: number | null;
  wantedUntil: number;
  createdAt: number;
}
export const computers = collection<Computer>("computers")
  .index("byOrg", ["org"])
  .index("byKindState", ["kind", "state"]);

export interface Automation {
  org: string;
  id: string;
  name: string;
  schedule: string;
  offsetMinutes: number;
  prompt: string;
  model: string | null;
  computer: string | null;
  enabled: boolean;
  createdBy: string;
  nextAt: number | null;
  lastRunAt: number | null;
  lastSession: string | null;
}
export const automations = collection<Automation>("automations")
  .key(v.tuple([id, id]))
  .index("byOrg", ["org"]);

export interface Memory { org: string; scope: string; path: string; content: string; updatedAt: number; updatedBy: string }
export const memories = collection<Memory>("memories")
  .key(v.tuple([id, v.string({ min: 1, max: 300 }), v.string({ min: 1, max: 512 })]))
  .index("byScope", ["org", "scope"]);

// Values workers keep current

/** Each session's first message, from which its title is generated. */
export const titleSources = collection<{ text: string }>("titleSources");
export const titles = external("session.title", {
  input: (ctx, session: string) => {
    const source = ctx.get(titleSources, session);
    return source && { recipe: "title-v1", text: source.text.slice(0, 4_000) };
  },
  result: v.string({ min: 1, max: 200 }),
  each: titleSources,
});

/** Each MCP server's tools, read again whenever its configuration changes. */
export const mcpCatalog = external("mcp.catalog", {
  input: (ctx, server: [string, string]) => {
    const found = ctx.get(mcpServers, server);
    return found?.enabled ? { url: found.url, headers: found.headers, updatedAt: found.updatedAt } : null;
  },
  result: v.array(v.object({ name: v.string({ min: 1, max: 256 }), description: v.string(), inputSchema: v.json() })),
  each: mcpServers,
});

// Work queues

// Attempt budgets are enforced by the claim methods, which can settle the owning
// session; the queues' own limits only bound runaway reclaims.
export const MAX_COMPLETION_ATTEMPTS = 5;
export const MAX_TOOL_ATTEMPTS = 3;
export const MAX_REVIEW_ATTEMPTS = 2;

export const completions = queue<CompletionJob, CompletionOutcome>("completions", {
  lease: { defaultMs: 30_000, maxMs: 120_000 },
  retry: { maxAttempts: 1_000, initialDelayMs: 500, maxDelayMs: 30_000 },
});

/** Tool calls, scoped by where they run: `computer:<id>` or `service`. */
export const toolJobs = queue<ToolJob, ToolOutcome>("toolJobs", {
  lease: { defaultMs: 30_000, maxMs: 300_000 },
  retry: { maxAttempts: 1_000, initialDelayMs: 1_000, maxDelayMs: 30_000 },
});

/** Permission requests for the reviewer, one job per response. A timer bounds how long they wait. */
export const reviews = queue<ReviewJob, ReviewOutcome>("reviews", {
  lease: { defaultMs: 15_000, maxMs: 60_000 },
  retry: { maxAttempts: 1_000, initialDelayMs: 500, maxDelayMs: 5_000 },
});

/** What a surface thread should show next. */
export type Outbound =
  | { kind: "reply"; text: string; error: boolean }
  | { kind: "ask"; calls: Array<{ id: string; approval: Approval; prompt: string }> }
  /** A prompt was answered, anywhere: the surface drops `card`, its message for it. */
  | { kind: "resolved"; call: string; card: string }
  /** The turn ended without an answer (a halt): only the marks change. */
  | { kind: "ended" };

/** Marks on the thread's messages: `pending` lose their working mark, and `done` takes the finished one from `previous`. */
export interface Marks { pending: string[]; done: string | null; previous: string | null }

export interface OutboundJob { org: string; surface: string; thread: string; meta: Json; session: string; seq: number; message: Outbound; marks: Marks | null }
/** Scoped by surface name. */
export const outbound = queue<OutboundJob>("outbound", {
  lease: { defaultMs: 30_000, maxMs: 120_000 },
  retry: { maxAttempts: 8, initialDelayMs: 2_000, maxDelayMs: 300_000 },
});

export interface ProvisionJob { computer: string; action: "start" | "stop"; kind: "docker"; image: string | null }
export const provision = queue<ProvisionJob>("provision", {
  lease: { defaultMs: 60_000, maxMs: 600_000 },
  retry: { maxAttempts: 5, initialDelayMs: 2_000, maxDelayMs: 60_000 },
});

export interface BillingJob { org: string; customer: string; meter: string; value: number; identifier: string; at: number }
export const billing = queue<BillingJob>("billing", {
  lease: { defaultMs: 30_000, maxMs: 120_000 },
  retry: { maxAttempts: 12, initialDelayMs: 5_000, maxDelayMs: 3_600_000 },
});

export interface SealJob { session: string; from: number; to: number }
export const sealing = queue<SealJob>("sealing", {
  lease: { defaultMs: 60_000, maxMs: 600_000 },
  retry: { maxAttempts: 10, initialDelayMs: 5_000, maxDelayMs: 600_000 },
});
