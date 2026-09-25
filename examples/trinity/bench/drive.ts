// Many people using Trinity at once. Each simulated user owns a session, sends a message,
// watches the session until the turn ends, pauses, and sends the next one. Run it against a
// stack whose model is simulated (`dev --sim`), which reports how long each turn spent in
// the model and the tools, so the rest is Trinity's own overhead.
//
//   npm run bench -- --sessions 10000 --turns 3
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { FlowerClient, FlowerError } from "@flower-js/sdk";
import type app from "../app/index.ts";
import { loadSigningKey, signToken, type TokenClaims } from "../workers/auth.ts";
import { http2Connections } from "../workers/pool.ts";
import { SIMULATED, simComputers } from "../workers/sim.ts";

const { values: flags } = parseArgs({
  options: {
    sessions: { type: "string", default: "10000" },
    turns: { type: "string", default: "3" },
    "think-ms": { type: "string", default: "2000" },
    "ramp-s": { type: "string", default: "10" },
    org: { type: "string", default: "bench" },
    computers: { type: "string", default: "16" },
    "context-tokens": { type: "string" },
    "setup-concurrency": { type: "string", default: "256" },
    "streams-per-connection": { type: "string", default: "100" },
    "turn-timeout-s": { type: "string", default: "300" },
    "idle-watches": { type: "string", default: "0" },
    json: { type: "string" },
    help: { type: "boolean" },
  },
});

if (flags.help) {
  console.log(`Usage: npm run bench -- [options]   (FLOWER_URL, TRINITY_AUTH_KEY from the environment)
  --sessions N              concurrent sessions, one simulated user each (10000)
  --turns N                 messages each user sends (3)
  --think-ms MS             mean pause between a reply and the next message (2000)
  --ramp-s S                spread the first messages over this long (10)
  --org ID                  organization to create or reuse (bench)
  --computers N             sim computers to spread sessions over; match \`trinity sim --computers\` (16)
  --context-tokens N        a small context budget makes sessions compact and seal (off)
  --idle-watches N          also watch N sessions nobody uses, as open browser tabs would (0)
  --json FILE               also write the results as JSON`);
  process.exit(0);
}

const count = (name: keyof typeof flags) => Number(flags[name]);
const sessions = count("sessions");
const turns = count("turns");
const thinkMs = count("think-ms");
const rampMs = count("ramp-s") * 1_000;
const org = flags.org!;
const computers = simComputers(count("computers"));
const turnTimeoutMs = count("turn-timeout-s") * 1_000;
const idleWatches = count("idle-watches");
const flowerUrl = process.env.FLOWER_URL ?? "http://127.0.0.1:7301";
const root = new URL("..", import.meta.url).pathname;
const key = await loadSigningKey(process.env.TRINITY_AUTH_KEY ?? join(root, ".dev", "auth.pem"));

// Every open watch holds a stream, and a connection carries a bounded number of them.
const connections = http2Connections(Math.ceil((sessions + idleWatches) / count("streams-per-connection")) + 1);
const clientAs = (claims: TokenClaims) => {
  const token = signToken(key, claims, 12 * 3_600);
  return new FlowerClient<typeof app>(flowerUrl, { fetch: connections.fetch, credentials: { token } });
};

const stop = new AbortController();
process.once("SIGINT", () => {
  console.error("\nStopping: finishing turns in progress. Press Ctrl-C again to quit at once.");
  stop.abort();
  process.once("SIGINT", () => process.exit(130));
});

// Setup: an organization, its sim computers, and the sessions

const failure = (error: unknown) => error instanceof FlowerError ? error.failure?.code ?? error.code : error instanceof Error ? error.name : "ERROR";

try {
  await clientAs({ sub: "bench", role: "user" }).mutate("org.create", { id: org, name: "Load test" }, { retry: true });
} catch (error) {
  if (failure(error) !== "ORG_EXISTS") throw error;
}
const user = clientAs({ sub: "bench", role: "user", org });
const worker = clientAs({ sub: "bench", role: "worker" });
for (const computer of computers) {
  try {
    await user.mutate("computer.register", { id: computer, name: `Simulated ${computer}` }, { retry: true });
  } catch (error) {
    if (failure(error) !== "COMPUTER_EXISTS") throw error;
    // Computer IDs are global, so the simulated computers serve the first organization that registered them.
    console.error(`${computer} belongs to another organization. Run the bench with that organization's --org.`);
    process.exit(2);
  }
}

async function inParallel<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !stop.signal.aborted) await run(items[next++]!);
  }));
}

const run = Date.now().toString(36);
const ids = Array.from({ length: sessions }, (_, index) => `${org}-${run}-${index}`);
const contextTokens = flags["context-tokens"] === undefined ? {} : { contextTokens: Number(flags["context-tokens"]) };
console.log(`Creating ${sessions.toLocaleString("en-US")} sessions in ${org} on ${flowerUrl}…`);
const setupStarted = performance.now();
await inParallel(ids.map((id, index) => ({ id, index })), count("setup-concurrency"), async ({ id, index }) => {
  await user.mutate("session.create", { id, computer: computers[index % computers.length]!, allow: ["bash"], ...contextTokens }, { requestId: `create-${id}`, retry: true });
});
const setupSeconds = (performance.now() - setupStarted) / 1_000;
console.log(`Created them in ${setupSeconds.toFixed(1)} s (${Math.round(sessions / setupSeconds).toLocaleString("en-US")}/s).`);

// Sessions that stay idle but watched, like tabs left open: they show what each open watch costs every commit.
const idle = new AbortController();
if (idleWatches > 0) {
  const quiet = Array.from({ length: idleWatches }, (_, index) => `${org}-${run}-idle-${index}`);
  await inParallel(quiet, count("setup-concurrency"), async (id) => {
    await user.mutate("session.create", { id, computer: computers[0]! }, { requestId: `create-${id}`, retry: true });
  });
  let opened = 0;
  for (const id of quiet) {
    void (async () => {
      try {
        for await (const _ of user.subscribe("session.get", { session: id }, { signal: idle.signal })) opened += 1;
      } catch {}
    })();
  }
  while (opened < idleWatches && !stop.signal.aborted) await delay(100);
  console.log(`Watching ${idleWatches.toLocaleString("en-US")} idle sessions.`);
}
console.log(`Driving ${turns} turns each…\n`);

// The load: one loop per user

interface Turn { latencyMs: number; simulatedMs: number; stops: number; calls: number; completions: number }
const finished: Turn[] = [];
const errors = new Map<string, number>();
let inTurn = 0;
let peakInTurn = 0;

const PROMPTS = [
  "What does this project do?", "Find where sessions are created and explain it.", "Why is the test suite failing?",
  "Add a --verbose flag to the CLI.", "Summarize the recent changes.", "Is there dead code in src/?",
];

async function person(index: number): Promise<void> {
  const session = ids[index]!;
  await delay((rampMs * index) / sessions);
  let steps = 0;
  for (let turn = 0; turn < turns && !stop.signal.aborted; turn++) {
    if (turn > 0) await delay(-thinkMs * Math.log(1 - Math.random()));
    const message = `m${turn}`;
    const sentAt = performance.now();
    inTurn += 1;
    peakInTurn = Math.max(peakInTurn, inTurn);
    try {
      const { value: sent } = await user.mutate("session.send", { session, message, text: PROMPTS[(index + turn) % PROMPTS.length]! }, { requestId: `${session}-${message}`, retry: true });
      const { value: after } = await user.waitUntil("session.get", { session }, (value) => value !== null && value.turn === null && value.seq > sent.seq, {
        signal: AbortSignal.timeout(turnTimeoutMs),
      });
      const latencyMs = performance.now() - sentAt;
      const simulated = SIMULATED.exec(after!.lastText ?? "");
      if (simulated === null) {
        errors.set(`ended ${after!.status}`, (errors.get(`ended ${after!.status}`) ?? 0) + 1);
      } else {
        finished.push({
          latencyMs, simulatedMs: Number(simulated[3]), stops: Number(simulated[1]), calls: Number(simulated[2]), completions: after!.steps - steps,
        });
      }
      steps = after!.steps;
    } catch (error) {
      const kind = failure(error);
      errors.set(kind, (errors.get(kind) ?? 0) + 1);
    } finally {
      inTurn -= 1;
    }
  }
}

// Reporting

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}
const seconds = (ms: number) => Number.isNaN(ms) ? "–" : `${(ms / 1_000).toFixed(2)} s`;
const number = (value: number) => Math.round(value).toLocaleString("en-US");
const sum = (turns: readonly Turn[], field: keyof Turn) => turns.reduce((total, turn) => total + turn[field], 0);

const driveStarted = performance.now();
let reported = 0;
const progress = setInterval(async () => {
  const window = finished.slice(reported);
  reported = finished.length;
  const latencies = window.map((turn) => turn.latencyMs).sort((a, b) => a - b);
  const overheads = window.map((turn) => turn.latencyMs - turn.simulatedMs).sort((a, b) => a - b);
  let waiting = "";
  try {
    const { value: stats } = await worker.query("completions.stats", null, { signal: AbortSignal.timeout(1_000) });
    if (stats.oldestReadyAt !== null) waiting = `, completions queued ${seconds(Date.now() - stats.oldestReadyAt)}`;
  } catch {}
  const failed = [...errors.values()].reduce((total, value) => total + value, 0);
  console.log(
    `${String(Math.round((performance.now() - driveStarted) / 1_000)).padStart(4)} s  ${number(inTurn).padStart(6)} in a turn  ` +
    `${number(finished.length).padStart(7)} turns (${number(window.length / 2)}/s)  p50 ${seconds(percentile(latencies, 0.5))}  p99 ${seconds(percentile(latencies, 0.99))}  ` +
    `overhead p50 ${seconds(percentile(overheads, 0.5))}  ${failed} failed${waiting}`,
  );
  if (finished.length === 0 && performance.now() - driveStarted > 15_000 && waiting !== "") {
    console.log("      No turn has finished and completions are waiting: is the simulated model running (`dev --sim`, or `trinity sim`)?");
  }
}, 2_000);

await Promise.all(ids.map((_, index) => person(index)));
clearInterval(progress);
idle.abort();
const driveSeconds = (performance.now() - driveStarted) / 1_000;
await connections.close();

const latencies = finished.map((turn) => turn.latencyMs).sort((a, b) => a - b);
const simulated = finished.map((turn) => turn.simulatedMs).sort((a, b) => a - b);
const overheads = finished.map((turn) => turn.latencyMs - turn.simulatedMs).sort((a, b) => a - b);
const failed = [...errors.values()].reduce((total, value) => total + value, 0);
const completions = sum(finished, "completions");
const calls = sum(finished, "calls");
const spread = (sorted: readonly number[]) => ({ p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), p99: percentile(sorted, 0.99), max: sorted.at(-1) ?? NaN });
const line = (sorted: readonly number[]) => {
  const { p50, p90, p99, max } = spread(sorted);
  return `p50 ${seconds(p50)}  p90 ${seconds(p90)}  p99 ${seconds(p99)}  max ${seconds(max)}`;
};

console.log(`
${number(sessions)} sessions × ${turns} turns against ${flowerUrl}
  setup      ${number(sessions)} sessions created in ${setupSeconds.toFixed(1)} s (${number(sessions / setupSeconds)}/s)
  turns      ${number(finished.length)} finished, ${failed} failed, in ${driveSeconds.toFixed(1)} s (${number(finished.length / driveSeconds)}/s); at most ${number(peakInTurn)} at once
  work       ${(completions / finished.length).toFixed(1)} completions and ${(calls / finished.length).toFixed(1)} tool calls per turn: ${number(completions / driveSeconds)} completions/s, ${number(calls / driveSeconds)} tool calls/s
  latency    ${line(latencies)}
  simulated  ${line(simulated)}   (time the model and tools took)
  overhead   ${line(overheads)}   (the rest: queues, claims, commits, watches)`);
if (failed > 0) console.log(`  failures   ${[...errors].map(([kind, value]) => `${kind} ×${value}`).join(", ")}`);

if (flags.json) {
  await writeFile(flags.json, JSON.stringify({
    flowerUrl, sessions, turns, thinkMs, rampMs, computers: computers.length, idleWatches,
    setupSeconds, driveSeconds, finished: finished.length, failed, errors: Object.fromEntries(errors), peakInTurn,
    completions, toolCalls: calls,
    latencyMs: spread(latencies), simulatedMs: spread(simulated), overheadMs: spread(overheads),
  }, null, 2));
  console.log(`\nWrote ${flags.json}`);
}
process.exit(failed > 0 ? 1 : 0);
