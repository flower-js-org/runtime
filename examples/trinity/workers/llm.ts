import Anthropic from "@anthropic-ai/sdk";
import { FlowerError, type FlowerClient } from "@flower-js/sdk";
import type { Claim, LeaseIdentity } from "@flower-js/sdk/temporal";
import { runQueueWorker, type QueueWorkerEvent } from "@flower-js/sdk/worker";
import type app from "../app/index.ts";
import type { CompletionJob, CompletionOutcome, Delta, Event, Prompt, ToolDefinition } from "../app/model.ts";
import { classify, COMPACTION_PROMPT, modelOptions, normalize, render } from "./anthropic.ts";
import type { BlobStore } from "./blobs.ts";
import { readSegment } from "./segments.ts";

type Client = FlowerClient<typeof app>;
type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

export interface LlmWorkerOptions {
  readonly signal: AbortSignal;
  /** Completions this process streams at once. Default 4. */
  readonly lanes?: number;
  /** How often streamed deltas are stored. Default 250 ms. */
  readonly flushMs?: number;
  readonly maxTokens?: number;
  /** Where attachments and sealed log segments live. Without it, attachments render as unavailable. */
  readonly blobs?: BlobStore;
  readonly onEvent?: (event: QueueWorkerEvent) => void;
}

export function runLlmWorker(client: Client, anthropic: Anthropic, options: LlmWorkerOptions): Promise<void> {
  return runQueueWorker<CompletionJob, CompletionOutcome>(client, {
    queue: "completions",
    signal: options.signal,
    lanes: options.lanes ?? 4,
    leaseMs: 30_000,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    work: (job, signal) => complete(client, anthropic, job, signal, options),
  });
}

async function complete(client: Client, anthropic: Anthropic, job: Claim<CompletionJob>, signal: AbortSignal, options: LlmWorkerOptions): Promise<CompletionOutcome> {
  const { value: prompt } = await client.query("session.prompt", { session: job.payload.session, step: job.payload.step }, { signal, retry: true });
  // The step was halted or replaced; the job is gone and any report would be refused.
  if (prompt === null) throw new Error("The completion step is no longer current");

  const stop = new AbortController();
  const stream = anthropic.beta.messages.stream(await request(prompt, options), { signal: AbortSignal.any([signal, stop.signal]) });
  const lease: LeaseIdentity = { id: job.id, owner: job.owner, token: job.token, ...(job.history ? { history: job.history } : {}) };
  const flusher = new Flusher(client, lease, options.flushMs ?? 250, () => stop.abort());
  stream.on("streamEvent", (event) => flusher.observe(event));
  try {
    const message = normalize(await stream.finalMessage());
    // A summary is text; anything else the model produced is dropped.
    if (prompt.kind === "compact") message.blocks = message.blocks.filter((block) => block.type === "text");
    return { ok: true, message };
  } catch (error) {
    if (signal.aborted || stop.signal.aborted) throw error;
    return { ok: false, error: classify(error) };
  } finally {
    flusher.close();
  }
}

async function request(prompt: Prompt, options: LlmWorkerOptions): Promise<StreamParams> {
  const events = await requestEvents(prompt, options.blobs);
  const messages = render(events, await attachmentBodies(events, options.blobs));
  const compact = prompt.kind === "compact";
  if (compact) messages.push({ role: "user", content: [{ type: "text", text: COMPACTION_PROMPT }] });
  const supports = modelOptions(prompt.model);
  return {
    model: prompt.model,
    max_tokens: compact ? 32_000 : options.maxTokens ?? 64_000,
    system: prompt.system,
    messages,
    tools: prompt.tools.map(toolParam),
    ...(compact ? { tool_choice: { type: "none" as const } } : {}),
    ...(supports.thinking ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
    cache_control: { type: "ephemeral" },
    ...(supports.fallbacks ? { fallbacks: "default" as const, betas: ["server-side-fallback-2026-07-01"] } : {}),
  };
}

/** Sealed events the request still needs, then the live ones. */
async function requestEvents(prompt: Prompt, blobs: BlobStore | undefined): Promise<Event[]> {
  if (prompt.segments.length === 0) return prompt.events;
  if (blobs === undefined) throw new Error("This session's log is partly in blob storage; configure TRINITY_BLOBS");
  const live = new Set(prompt.events.map((event) => event.seq));
  const sealed: Event[] = [];
  for (const segment of prompt.segments) {
    for (const event of await readSegment(blobs, segment.key)) {
      if (event.seq >= prompt.start && !live.has(event.seq)) sealed.push(event);
    }
  }
  return [...sealed, ...prompt.events];
}

async function attachmentBodies(events: readonly Event[], blobs: BlobStore | undefined): Promise<Map<string, Uint8Array>> {
  const bodies = new Map<string, Uint8Array>();
  if (blobs === undefined) return bodies;
  const keys = new Set(events.flatMap(({ body }) => body.type === "user" ? body.attachments.map((attachment) => attachment.blob) : []));
  for (const key of keys) {
    const found = await blobs.get(key);
    if (found !== null) bodies.set(key, found.body);
  }
  return bodies;
}

function toolParam(tool: ToolDefinition): Anthropic.Beta.BetaToolUnion {
  // Provider-run tools (web search, web fetch) pass through as declared.
  if (!("input_schema" in tool)) return tool as unknown as Anthropic.Beta.BetaToolUnion;
  return {
    name: tool.name,
    description: tool.description as string,
    input_schema: tool.input_schema as Anthropic.Beta.BetaTool.InputSchema,
    // Inputs stream as they are written; the session validates each one before it runs.
    eager_input_streaming: true,
  };
}

/** Stores streamed deltas at most once per interval, one request at a time, and stops the stream once the step is unwanted. */
class Flusher {
  private pending: Delta[] = [];
  private readonly toolNames = new Map<number, string>();
  private sending = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly client: Client;
  private readonly lease: LeaseIdentity;
  private readonly stop: () => void;

  constructor(client: Client, lease: LeaseIdentity, flushMs: number, stop: () => void) {
    this.client = client;
    this.lease = lease;
    this.stop = stop;
    this.timer = setInterval(() => void this.flush(), flushMs);
  }

  observe(event: Anthropic.Beta.BetaRawMessageStreamEvent): void {
    if (event.type === "content_block_start" && event.content_block.type === "tool_use") this.toolNames.set(event.index, event.content_block.name);
    if (event.type !== "content_block_delta") return;
    const { delta, index } = event;
    if (delta.type === "text_delta") this.add(index, "text", delta.text);
    else if (delta.type === "thinking_delta") this.add(index, "thinking", delta.thinking);
    else if (delta.type === "input_json_delta") this.add(index, "tool_call", delta.partial_json, this.toolNames.get(index));
  }

  close(): void {
    clearInterval(this.timer);
  }

  private add(index: number, type: Delta["type"], text: string, name?: string): void {
    const last = this.pending.at(-1);
    if (last?.index === index && last.type === type) last.text += text;
    else this.pending.push({ index, type, text, ...(name === undefined ? {} : { name }) });
  }

  private async flush(): Promise<void> {
    if (this.sending || this.pending.length === 0) return;
    this.sending = true;
    const deltas = this.pending;
    this.pending = [];
    try {
      // Partials only serve live views, so a batch that cannot land in time is dropped rather than resent.
      const { value } = await this.client.mutate("completions.progress", { ...this.lease, deltas }, { retry: { attempts: 3, timeoutMs: 5_000 } });
      if (value.stop) this.stop();
    } catch (error) {
      if (error instanceof FlowerError && error.failure?.code === "LEASE_LOST") this.stop();
    } finally {
      this.sending = false;
    }
  }
}
