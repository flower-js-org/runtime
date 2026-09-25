import Anthropic from "@anthropic-ai/sdk";
import type { FlowerClient, Json } from "@flower-js/sdk";
import { reconcile, runQueueWorker } from "@flower-js/sdk/worker";
import type app from "../app/index.ts";
import type { Event, ToolJob, ToolOutcome } from "../app/model.ts";
import type { BillingJob, OutboundJob, SealJob } from "../app/store.ts";
import type { BlobStore } from "./blobs.ts";
import { DeliveryError } from "./delivery.ts";
import { postGithubComment } from "./github.ts";
import { callMcpTool, listMcpTools, type SecretResolver } from "./mcp.ts";
import { offload, readOutput, truncate } from "./outputs.ts";
import { writeSegment } from "./segments.ts";
import { reportMeterEvent } from "./stripe.ts";

type Client = FlowerClient<typeof app>;

export const TITLE_MODEL = "claude-haiku-4-5";

export type Loop = "tools" | "sealing" | "titles" | "catalog" | "github" | "billing";

export interface ServiceOptions {
  readonly signal: AbortSignal;
  readonly secrets: SecretResolver;
  readonly blobs?: BlobStore;
  readonly anthropic?: Anthropic;
  /** Which loops to run. Default: every loop whose dependencies are configured. */
  readonly loops?: readonly Loop[];
  /** The web client's address, for links to sessions in GitHub comments. */
  readonly publicUrl?: string;
  readonly log?: (event: Record<string, Json>) => void;
}

/** A per-organization secret, falling back to a deployment-wide one: github_token_acme, then github_token. */
function secretFor(secrets: SecretResolver, name: string, org: string): string {
  const value = secrets(`${name}_${org}`) ?? secrets(name);
  if (value === undefined) throw new DeliveryError(`Secret ${name} is not configured for ${org}`, { retryable: false });
  return value;
}

/** Service-scope tool jobs: reading stored outputs and calling MCP servers. */
export async function runServiceTool(job: ToolJob, options: Pick<ServiceOptions, "secrets" | "blobs">, signal: AbortSignal): Promise<ToolOutcome> {
  const input = job.input as Record<string, any>;
  if (job.name === "read_output") {
    if (options.blobs === undefined) return { content: "Stored outputs are unavailable: no blob storage is configured.", isError: true };
    return readOutput(options.blobs, input.key, input.offset, input.limit);
  }
  if (job.mcp === null) return { content: `The service cannot run ${job.name}.`, isError: true };
  try {
    const outcome = await callMcpTool({ url: job.mcp.url, headers: job.mcp.headers }, options.secrets, job.mcp.tool, input, signal);
    return offload({ ...outcome, content: truncate(outcome.content) }, options.blobs);
  } catch (error) {
    if (signal.aborted) throw error;
    return { content: `The ${job.mcp.server} MCP server failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}

export async function generateTitle(anthropic: Anthropic, text: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: TITLE_MODEL,
    max_tokens: 64,
    system: "Reply with only a title of three to seven words for a work session that starts with the user's message. No quotes, no trailing punctuation.",
    messages: [{ role: "user", content: text }],
  });
  if (response.stop_reason === "refusal") return "Untitled session";
  const title = response.content
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/^["']|["'.]$/g, "")
    .trim();
  return title === "" ? "Untitled session" : title.slice(0, 200);
}

/** What a GitHub thread should say, if anything: answers, and prompts it cannot show as buttons. */
export function githubComment(job: OutboundJob, publicUrl: string | undefined): string | null {
  const { message } = job;
  if (message.kind === "reply") return message.text;
  if (message.kind !== "ask") return null;
  const questions = message.calls.filter((call) => call.approval === "elicitation").map((call) => call.prompt);
  const approvals = message.calls.filter((call) => call.approval === "permission").map((call) => `• ${call.prompt}`);
  if (approvals.length === 0) return questions.join("\n\n");
  const link = publicUrl ? `Open it in Trinity: ${publicUrl.replace(/\/$/, "")}/#/sessions/${encodeURIComponent(job.session)}` : "Open this session in Trinity to respond.";
  return [...questions, `I need approval before I continue:\n${approvals.join("\n")}`, link].join("\n\n");
}

async function deliver(job: OutboundJob, options: ServiceOptions, signal: AbortSignal): Promise<Json> {
  if (job.surface !== "github") throw new DeliveryError(`No delivery for surface ${job.surface}`, { retryable: false });
  const body = githubComment(job, options.publicUrl);
  if (body === null) return null;
  const meta = job.meta as Record<string, any>;
  const posted = await postGithubComment({ token: secretFor(options.secrets, "github_token", job.org), repo: meta.repo, number: meta.number, body, signal });
  return { id: posted.id, url: posted.url };
}

async function sealSegment(client: Client, blobs: BlobStore, job: SealJob) {
  const events: Event[] = [];
  for (let from = job.from; from <= job.to;) {
    const { value: page } = await client.query("session.events", { session: job.session, from, to: job.to, limit: 1_000 }, { retry: true });
    if (page.length === 0) break;
    events.push(...page);
    from = page.at(-1)!.seq + 1;
  }
  return writeSegment(blobs, events);
}

/** Run the background service loops until the signal aborts. */
export async function runService(client: Client, options: ServiceOptions): Promise<void> {
  const { signal, secrets, blobs, anthropic } = options;
  const log = options.log ?? (() => {});
  const report = (loop: Loop) => (event: { type: string }) => log({ loop, event: event.type });

  const loops: Record<Loop, (() => Promise<void>) | null> = {
    tools: () => runQueueWorker<ToolJob, ToolOutcome>(client, {
      queue: "tools", scope: "service", signal, lanes: 8, leaseMs: 60_000, onEvent: report("tools"),
      work: (job, jobSignal) => runServiceTool(job.payload, options, jobSignal),
    }),
    sealing: blobs === undefined ? null : () => runQueueWorker<SealJob>(client, {
      queue: "sealing", signal, lanes: 2, leaseMs: 60_000, onEvent: report("sealing"),
      work: (job) => sealSegment(client, blobs, job.payload),
    }),
    titles: anthropic === undefined ? null : () => reconcile<string, { text: string }, string>(client, {
      external: "titles", signal, lease: true, concurrency: 4, onEvent: report("titles"),
      compute: (input) => generateTitle(anthropic, input.text),
    }),
    catalog: () => reconcile<[string, string], { url: string; headers: Record<string, string> }, Json>(client, {
      external: "mcp.catalog", signal, lease: true, concurrency: 4, onEvent: report("catalog"),
      compute: async (input, _work, computeSignal) => (await listMcpTools(input, secrets, computeSignal)) as unknown as Json,
    }),
    github: () => runQueueWorker<OutboundJob, Json>(client, {
      queue: "outbound", scope: "github", signal, lanes: 4, leaseMs: 60_000, onEvent: report("github"),
      work: (job, jobSignal) => deliver(job.payload, options, jobSignal),
    }),
    billing: secrets("stripe_key") === undefined ? null : () => runQueueWorker<BillingJob, null>(client, {
      queue: "billing", signal, lanes: 2, leaseMs: 30_000, onEvent: report("billing"),
      async work({ payload }) {
        await reportMeterEvent({
          apiKey: secrets("stripe_key")!, eventName: payload.meter, customer: payload.customer,
          value: payload.value, identifier: payload.identifier, timestamp: payload.at,
        });
        return null;
      },
    }),
  };

  const wanted = options.loops ?? (Object.keys(loops) as Loop[]);
  await Promise.all(wanted.flatMap((name) => loops[name] === null ? [] : [loops[name]!()]));
}
