import type { FlowerClient } from "@flower-js/sdk";
import { reconcile } from "@flower-js/sdk/worker";
import type { Claim, LeaseIdentity } from "@flower-js/sdk/temporal";
import type app from "../app/index.ts";
import type { Block, CompletionJob, CompletionOutcome, Delta, Prompt, ReviewJob, ReviewOutcome, ToolJob, ToolOutcome } from "../app/model.ts";
import { runPool, type PoolEvent } from "./pool.ts";

// A stand-in for the model and for computers, for load tests and for working on Trinity
// without credentials. Each turn makes a random number of tool-calling stops before it
// answers, with latencies shaped like a real model's and a real machine's but compressed
// in time. Everything is a pure function of the session, the user's message and the step,
// so a retried job answers exactly as the first attempt would have.

type Client = FlowerClient<typeof app>;

export interface SimProfile {
  /** How many times faster than a real model and machine everything runs. */
  readonly speedup: number;
  /** Mean tool-calling stops per turn. Each turn draws its own count. */
  readonly stops: number;
  readonly maxStops: number;
}

export const DEFAULT_PROFILE: SimProfile = { speedup: 20, stops: 3, maxStops: 12 };

/** Median and spread of each real-world quantity, before the speedup. */
const REAL = {
  firstTokenMs: [900, 0.35],
  tokensPerSecond: [75, 0.2],
  stepTokens: [90, 0.5],
  answerTokens: [350, 0.6],
  summaryTokens: [600, 0.3],
  titleMs: [400, 0.3],
  reviewMs: [350, 0.3],
  tools: { list_files: [30, 0.5], read_file: [40, 0.5], bash: [700, 1] },
} as const;

type SimTool = keyof typeof REAL.tools;

/** Computers the simulation serves. Load tests register these IDs in their organization. */
export const simComputers = (count: number) => Array.from({ length: count }, (_, index) => `sim-${index}`);

/** A turn's final answer ends with this, so a driver can tell simulated time from Trinity's overhead. */
export const SIMULATED = /Simulated: (\d+) stops?, (\d+) tool calls?, (\d+) ms\./;

// Randomness, seeded by what the step is

function seeded(key: string): () => number {
  let state = 1_779_033_703 ^ key.length;
  for (let index = 0; index < key.length; index++) {
    state = Math.imul(state ^ key.charCodeAt(index), 3_432_918_353);
    state = (state << 13) | (state >>> 19);
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Log-normal around a median: most values near it, a long tail above. */
function around(random: () => number, [median, spread]: readonly [number, number]): number {
  const normal = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  return median * Math.exp(spread * normal);
}

const pick = <T>(random: () => number, choices: readonly T[]): T => choices[Math.floor(random() * choices.length)]!;

// The model

const WORDS = "the a session tool file change test build function value log state worker queue step turn call result error config module import export return type check read write list run and then so it this that we next".split(" ");
const PATHS = ["README.md", "package.json", "src/main.ts", "src/server.ts", "src/loop.ts", "test/loop.test.ts", "docs/design.md"];
const DIRECTORIES = [".", "src", "test", "docs"];
const COMMANDS = ["git status --short", "ls -la", "git log --oneline -5", "grep -rn TODO . | head -20", "wc -l README.md", "date"];

function prose(random: () => number, tokens: number): string {
  const words: string[] = [];
  for (let count = 0; count < tokens * 0.75; count++) words.push(pick(random, WORDS));
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

interface Step {
  readonly blocks: Block[];
  readonly calls: ReadonlyArray<{ id: string; name: SimTool }>;
  readonly firstTokenMs: number;
  readonly streamMs: number;
  readonly outputTokens: number;
}

/** One response of a turn: tool calls before the turn's last stop, the answer after. */
function planStep(profile: SimProfile, session: string, turn: string, step: number, stops: number, tools: ReadonlySet<string>): Step {
  const random = seeded(`${session}/${turn}/${step}`);
  const firstTokenMs = around(random, REAL.firstTokenMs) / profile.speedup;
  const perSecond = around(random, REAL.tokensPerSecond) * profile.speedup;
  const usable = (["read_file", "list_files", "bash"] as const).filter((name) => tools.has(name));
  const answering = step >= stops || usable.length === 0;
  const outputTokens = Math.ceil(around(random, answering ? REAL.answerTokens : REAL.stepTokens));
  const streamMs = (outputTokens / perSecond) * 1_000;
  if (answering) return { blocks: [{ type: "text", text: prose(random, outputTokens) }], calls: [], firstTokenMs, streamMs, outputTokens };

  const count = random() < 0.7 ? 1 : random() < 0.66 ? 2 : 3;
  const calls = Array.from({ length: count }, (_, index) => ({ id: `sim_${turnKey(turn)}_${step}_${index}`, name: pick(random, usable) }));
  const blocks: Block[] = [{ type: "text", text: prose(random, outputTokens / 2) }];
  for (const call of calls) {
    const input: Record<string, string> = call.name === "read_file" ? { path: pick(random, PATHS) }
      : call.name === "list_files" ? { path: pick(random, DIRECTORIES) }
      : { command: pick(random, COMMANDS) };
    blocks.push({ type: "tool_call", id: call.id, name: call.name, input });
  }
  return { blocks, calls, firstTokenMs, streamMs, outputTokens };
}

/** Call IDs stay short and within the provider's alphabet whatever the message ID is. */
function turnKey(turn: string): string {
  return Math.floor(seeded(turn)() * 2 ** 32).toString(36);
}

function toolMs(profile: SimProfile, session: string, call: string, name: string): number {
  const shape = REAL.tools[name as SimTool] ?? REAL.tools.bash;
  return Math.min(60_000, around(seeded(`${session}/${call}`), shape)) / profile.speedup;
}

interface Response { blocks: Block[]; stopReason: string; firstTokenMs: number; streamMs: number; outputTokens: number }

/** What the model says next, from the prompt a completion job sees. */
export function respond(profile: SimProfile, session: string, prompt: Prompt): Response {
  const { events } = prompt;
  if (prompt.kind === "compact") {
    const random = seeded(`${session}/compact/${events.at(-1)?.seq ?? 0}`);
    const outputTokens = Math.ceil(around(random, REAL.summaryTokens));
    const streamMs = (outputTokens / (around(random, REAL.tokensPerSecond) * profile.speedup)) * 1_000;
    return { blocks: [{ type: "text", text: `Summary: ${prose(random, outputTokens)}` }], stopReason: "end_turn", firstTokenMs: around(random, REAL.firstTokenMs) / profile.speedup, streamMs, outputTokens };
  }

  // The turn starts at its user message, or at the summary when compaction happened mid-turn.
  let anchor = events.length - 1;
  while (anchor > 0 && events[anchor]!.body.type !== "user") anchor -= 1;
  const opening = events[anchor]?.body;
  const turn = opening?.type === "user" ? opening.message : `from-${events[anchor]?.seq ?? 0}`;
  const step = events.slice(anchor + 1).filter((event) => event.body.type === "assistant").length;
  const random = seeded(`${session}/${turn}`);
  const drawn = Math.floor(Math.log(1 - random()) / Math.log(profile.stops / (profile.stops + 1)));
  const stops = Math.min(profile.maxStops, drawn);
  const tools = new Set(prompt.tools.map((tool) => tool.name));

  const current = planStep(profile, session, turn, step, stops, tools);
  if (current.calls.length > 0) return { ...current, stopReason: "tool_use" };

  // The answer reports the whole turn's simulated time: every response, and the slowest call of each stop.
  let simulatedMs = 0;
  let calls = 0;
  for (let earlier = 0; earlier <= step; earlier++) {
    const planned = earlier === step ? current : planStep(profile, session, turn, earlier, stops, tools);
    simulatedMs += planned.firstTokenMs + planned.streamMs;
    simulatedMs += Math.max(0, ...planned.calls.map((call) => toolMs(profile, session, call.id, call.name)));
    calls += planned.calls.length;
  }
  const text = `${(current.blocks[0] as { text: string }).text}\n\nSimulated: ${step} stops, ${calls} tool calls, ${Math.round(simulatedMs)} ms.`;
  return { ...current, blocks: [{ type: "text", text }], stopReason: "end_turn" };
}

// The computer

/** Run a tool call on a machine that does not exist: plausible output after a plausible wait. */
export async function simulateTool(profile: SimProfile, job: ToolJob, signal: AbortSignal): Promise<ToolOutcome> {
  await sleep(toolMs(profile, job.session, job.call, job.name), signal);
  const random = seeded(`${job.session}/${job.call}/output`);
  const input = job.input as Record<string, string>;
  switch (job.name) {
    case "list_files": {
      const entries = Array.from({ length: 8 + Math.floor(random() * 24) }, (_, index) => `${pick(random, WORDS)}-${index}${random() < 0.2 ? "/" : ".ts"}`);
      return { content: entries.join("\n"), isError: false };
    }
    case "read_file": {
      const lines = Math.min(400, Math.ceil(around(random, [120, 0.6])));
      const body = Array.from({ length: lines }, (_, index) => `${index + 1}\t${index % 7 === 0 ? `export function ${pick(random, WORDS)}${index}() {` : `  ${prose(random, 6)}`}`);
      return { content: `${input.path}\n${body.join("\n")}`, isError: false };
    }
    case "bash": {
      const lines = Array.from({ length: Math.floor(random() * 40) }, () => prose(random, 8));
      return { content: `exit 0\n${lines.join("\n")}`.trimEnd(), isError: false };
    }
    default:
      return { content: `The simulated computer cannot run ${job.name}.`, isError: true };
  }
}

/** A title from the first words of the message, after a small model's wait. */
export async function simulateTitle(profile: SimProfile, text: string, signal: AbortSignal): Promise<string> {
  await sleep(around(seeded(text), REAL.titleMs) / profile.speedup, signal);
  const words = text.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
  return words === "" ? "Untitled session" : words.slice(0, 200);
}

/** The reviewer's verdicts after a classifier's wait: most calls run without asking, some ask. */
export async function simulateReview(profile: SimProfile, job: ReviewJob, signal: AbortSignal): Promise<ReviewOutcome> {
  await sleep(around(seeded(`${job.session}/${job.step}/review`), REAL.reviewMs) / profile.speedup, signal);
  return {
    verdicts: Object.fromEntries(job.calls.map((call) => {
      const safe = Math.round((0.75 + 0.25 * seeded(`${job.session}/${call}/review`)()) * 1_000) / 1_000;
      return [call, { approved: safe >= 0.8, reviewer: "sim", scores: { safe }, note: null }];
    })),
  };
}

// The workers

export interface SimOptions {
  readonly signal: AbortSignal;
  readonly profile?: Partial<SimProfile>;
  /** Computers whose tools this process runs, as `sim-0`, `sim-1`, … Default 16. */
  readonly computers?: number;
  /** Completions in progress at once. Default 2048. */
  readonly concurrency?: number;
  /** Tool calls in progress at once, across all computers. Default 2048. */
  readonly toolConcurrency?: number;
  /** Claims in flight at once for completions, and for each computer's tools. Default 64 and 8. */
  readonly claimers?: number;
  /** How often streamed text is stored. Default the real worker's 250 ms, sped up like everything else. */
  readonly flushMs?: number;
  /** Also generate session titles, in place of the service's title model. Default true. */
  readonly titles?: boolean;
  /** Also review permission requests, in place of the service's reviewer. Default true. */
  readonly reviews?: boolean;
  readonly onStats?: (stats: SimStats) => void;
  readonly statsMs?: number;
}

export interface SimStats {
  readonly seconds: number;
  readonly completions: number;
  readonly tools: number;
  readonly flushes: number;
  readonly inFlight: number;
  readonly lost: number;
  readonly failed: number;
}

/** Serve completions, and the sim computers' tool calls, until the signal fires. */
export async function runSim(client: Client, options: SimOptions): Promise<void> {
  const profile = { ...DEFAULT_PROFILE, ...options.profile };
  const flushMs = options.flushMs ?? 250 / profile.speedup;
  const computers = simComputers(options.computers ?? 16);
  const toolLanes = Math.max(1, Math.ceil((options.toolConcurrency ?? 2_048) / computers.length));
  const counts = { completions: 0, tools: 0, flushes: 0, inFlight: 0, lost: 0, failed: 0 };
  const tally = (kind: "completions" | "tools") => (event: PoolEvent) => {
    if (event.type === "completed") counts[kind] += 1;
    else if (event.type === "lost") counts.lost += 1;
    else if (event.type === "failed") counts.failed += 1;
  };

  let last = { at: Date.now(), ...counts };
  const report = setInterval(() => {
    const now = Date.now();
    const seconds = (now - last.at) / 1_000;
    options.onStats?.({
      seconds,
      completions: counts.completions - last.completions,
      tools: counts.tools - last.tools,
      flushes: counts.flushes - last.flushes,
      inFlight: counts.inFlight,
      lost: counts.lost - last.lost,
      failed: counts.failed - last.failed,
    });
    last = { at: now, ...counts };
  }, options.statsMs ?? 5_000);

  async function complete(job: Claim<CompletionJob>, signal: AbortSignal): Promise<CompletionOutcome> {
    counts.inFlight += 1;
    try {
      const { value: prompt } = await client.query("session.prompt", { session: job.payload.session, step: job.payload.step }, { signal, retry: true });
      if (prompt === null) throw new Error("The completion step is no longer current");
      const response = respond(profile, job.payload.session, prompt);
      const lease: LeaseIdentity = { id: job.id, owner: job.owner, token: job.token, ...(job.history ? { history: job.history } : {}) };
      await stream(client, lease, response, flushMs, signal, () => { counts.flushes += 1; });
      const context = 3_000 + Math.ceil(JSON.stringify(prompt.events).length / 4);
      const cached = prompt.kind === "compact" ? 0 : Math.floor(context * 0.9);
      return {
        ok: true,
        message: {
          blocks: response.blocks,
          model: prompt.model,
          stopReason: response.stopReason,
          usage: { input: context - cached, output: response.outputTokens, cacheRead: cached, cacheWrite: 0 },
        },
      };
    } finally {
      counts.inFlight -= 1;
    }
  }

  try {
    await Promise.all([
      runPool<CompletionJob, CompletionOutcome>(client, {
        queue: "completions", signal: options.signal, concurrency: options.concurrency ?? 2_048, claimers: options.claimers ?? 64,
        work: complete, onEvent: tally("completions"),
      }),
      ...computers.map((computer) => runPool<ToolJob, ToolOutcome>(client, {
        queue: "tools", scope: `computer:${computer}`, signal: options.signal, concurrency: toolLanes,
        claimers: Math.max(1, Math.round((options.claimers ?? 64) / 8)),
        work: (job, signal) => simulateTool(profile, job.payload, signal), onEvent: tally("tools"),
      })),
      ...(options.titles === false ? [] : [reconcile<string, { text: string }, string>(client, {
        external: "titles", signal: options.signal, lease: true, concurrency: 64,
        compute: (input, _work, signal) => simulateTitle(profile, input.text, signal),
      })]),
      ...(options.reviews === false ? [] : [runPool<ReviewJob, ReviewOutcome>(client, {
        queue: "reviews", signal: options.signal, concurrency: 256, claimers: 4,
        work: (job, signal) => simulateReview(profile, job.payload, signal),
      })]),
    ]);
  } finally {
    clearInterval(report);
  }
}

/**
 * Stream a response the way the LLM worker does: nothing until the first token, then the
 * text so far every flush interval, one write at a time. Deltas still unsent when the
 * response ends travel with the complete message instead.
 */
async function stream(client: Client, lease: LeaseIdentity, response: Response, flushMs: number, signal: AbortSignal, flushed: () => void): Promise<void> {
  await sleep(response.firstTokenMs, signal);
  const pieces: Delta[] = response.blocks.map((block, index) =>
    block.type === "tool_call" ? { index, type: "tool_call", name: block.name, text: JSON.stringify(block.input) }
    : { index, type: "text", text: block.type === "text" ? block.text : "" });
  const total = pieces.reduce((sum, piece) => sum + piece.text.length, 0);
  const started = Date.now();
  const end = started + response.streamMs;
  let sent = 0;
  for (;;) {
    await sleep(Math.min(flushMs, end - Date.now()), signal);
    if (Date.now() >= end) return;
    const upto = Math.floor((total * (Date.now() - started)) / response.streamMs);
    if (upto <= sent) continue;
    const { value } = await client.mutate("completions.progress", { ...lease, deltas: slice(pieces, sent, upto) }, { signal, retry: { attempts: 3, timeoutMs: 5_000 } });
    flushed();
    sent = upto;
    if (value.stop) throw new Error("The completion step is no longer wanted");
  }
}

/** The part of the streamed text between two offsets, as deltas. */
function slice(pieces: readonly Delta[], from: number, to: number): Delta[] {
  const deltas: Delta[] = [];
  let offset = 0;
  for (const piece of pieces) {
    const start = Math.max(from, offset);
    const stop = Math.min(to, offset + piece.text.length);
    if (start < stop) deltas.push({ ...piece, text: piece.text.slice(start - offset, stop - offset) });
    offset += piece.text.length;
  }
  return deltas;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((done, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); done(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}
