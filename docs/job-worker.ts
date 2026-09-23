import { FlowerClient, FlowerError } from "@flower-js/sdk";
import type { Json } from "@flower-js/sdk";
import type { Claim } from "@flower-js/sdk/temporal";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// A worker for the job queue in examples/workers.ts. Start as many copies as
// you like, on as many machines as you like: they share the queue, and when
// one dies, the others finish its jobs once its leases run out.

// Your job goes here. It can run more than once (a worker can die after doing
// the work but before reporting it), so pass job.id to external services as an
// idempotency key. Stop when `signal` aborts: the lease is about to end.
export async function work(job: Claim, signal: AbortSignal): Promise<Json> {
  await sleep(1_000 + Math.random() * 2_000, undefined, { signal }); // Pretend to call an API.
  return { handledBy: job.owner, attempt: job.attempt };
}

export interface WorkerOptions {
  owner: string;   // Unique per process; shown on each job it holds.
  lanes: number;   // Jobs this process runs at the same time.
  leaseMs: number; // Longer than your slowest job. Leases can't be extended.
  work: typeof work;
  log?: (line: string) => void;
}

type Client = Pick<FlowerClient, "mutate" | "watch">;
const MARGIN_MS = 1_000;    // Finish this long before the lease ends.
const REQUEST_MS = 10_000;  // Timeout for each request to Flower.

// Network errors, timeouts, 429 and 5xx are worth retrying; 4xx answers are final.
const transient = (error: unknown) => !(error instanceof FlowerError) ||
  [408, 425, 429].includes(error.status) || error.status >= 500;
const backoff = (attempt: number) => Math.min(30_000, 250 * 2 ** Math.min(attempt, 7)) * (0.5 + Math.random() / 2);
const reason = (error: unknown) => String((error as { cause?: { code?: string } })?.cause?.code ?? (error as Error)?.message ?? error);

// Runs until `stop` aborts, then finishes the jobs it holds and returns.
export async function runWorker(client: Client, options: WorkerOptions, stop: AbortSignal) {
  const { owner, leaseMs, log = console.log } = options;

  // Retry one request with the SAME request ID, so a lost reply can't apply it twice.
  async function send<T>(name: string, args: object, until: number): Promise<T> {
    const requestId = randomUUID();
    for (let attempt = 0; ; attempt++) {
      try {
        return (await client.mutate<object, T>(name, args, { requestId, signal: AbortSignal.timeout(REQUEST_MS) })).value;
      } catch (error) {
        if (!transient(error) || Date.now() + backoff(attempt) >= until) throw error;
        await sleep(backoff(attempt));
      }
    }
  }

  // Wait until jobs.ready is true. A fresh watch starts with a fresh snapshot,
  // so work that arrived while this lane was busy is never missed.
  async function waitForWork(): Promise<void> {
    for (let attempt = 0; !stop.aborted; attempt++) {
      try {
        const connection = AbortSignal.any([stop, AbortSignal.timeout(60_000)]); // Also repairs silent stalls.
        for await (const { value } of client.watch<null, boolean>("jobs.ready", null, { signal: connection })) {
          if (value) return; // Leaving the loop closes the watch.
          attempt = 0;
        }
      } catch (error) {
        if (stop.aborted) return;
        if (!transient(error)) throw error;
      }
      await sleep(backoff(attempt), undefined, { signal: stop }).catch(() => {});
    }
  }

  async function runJob(lane: number, job: Claim, deadline: number): Promise<void> {
    const lease = { id: job.id, owner: job.owner, token: job.token, ...(job.history && { history: job.history }) };
    const timeLeft = deadline - Date.now();
    if (timeLeft <= 0) return log(`lane ${lane}: skipped ${job.id}, its lease ran out before it started`);
    log(`lane ${lane}: working on ${job.id} (attempt ${job.attempt})`);
    const timeout = AbortSignal.timeout(timeLeft);
    let outcome: [string, object];
    try {
      outcome = ["jobs.complete", { ...lease, result: await options.work(job, timeout) }];
    } catch (error) {
      const message = timeout.aborted ? `Ran out of time after ${timeLeft} ms; raise the lease or split the job` : reason(error);
      outcome = ["jobs.fail", { ...lease, error: { message } }];
    }
    try {
      await send(outcome[0], outcome[1], deadline + MARGIN_MS);
      log(`lane ${lane}: ${outcome[0] === "jobs.complete" ? "completed" : "failed"} ${job.id}`);
    } catch (error) {
      if (error instanceof FlowerError && /LEASE_LOST/.test(error.message)) {
        log(`lane ${lane}: lost ${job.id}, its lease ran out first; another worker will redo it`);
      } else {
        log(`lane ${lane}: couldn't report ${job.id} (${reason(error)}); if it wasn't saved, it runs again after its lease`);
      }
    }
  }

  async function lane(lane: number): Promise<void> {
    for (let failures = 0; !stop.aborted;) {
      await waitForWork();
      // Claim until the queue is empty, then go back to waiting.
      while (!stop.aborted) {
        const sentAt = Date.now(); // The lease can't have started before this.
        let job: Claim | null;
        try {
          job = await send<Claim | null>("jobs.claim", { owner, leaseMs }, sentAt + leaseMs);
          failures = 0;
        } catch (error) {
          if (!transient(error)) throw error; // A bad setting or a missing method: fix it, don't spin.
          log(`lane ${lane}: claim failed (${reason(error)}); retrying soon`);
          await sleep(backoff(failures++), undefined, { signal: stop }).catch(() => {});
          break;
        }
        if (job === null) break;
        await runJob(lane, job, sentAt + leaseMs - MARGIN_MS); // Finish what we claimed, even when stopping.
      }
    }
  }

  await Promise.all(Array.from({ length: options.lanes }, (_, i) => lane(i + 1)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stop = new AbortController();
  const options: WorkerOptions = {
    owner: process.env.WORKER_ID ?? `${hostname()}-${process.pid}`,
    lanes: Number(process.env.WORKER_LANES ?? 4),
    leaseMs: Number(process.env.WORKER_LEASE_MS ?? 10_000),
    work,
    log: (line) => console.log(`${new Date().toTimeString().slice(0, 8)} ${line}`),
  };
  if (!(Number.isInteger(options.lanes) && options.lanes > 0 && Number.isInteger(options.leaseMs) && options.leaseMs > MARGIN_MS)) {
    throw new Error("WORKER_LANES must be a positive integer, and WORKER_LEASE_MS an integer above 1000");
  }
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    process.on(name, () => {
      if (stop.signal.aborted) process.exit(130); // Second signal: quit now; leases expire and others take over.
      console.log("Stopping: finishing held jobs. Press Ctrl+C again to quit now.");
      stop.abort();
    });
  }
  console.log(`Worker ${options.owner} (pid ${process.pid}) running ${options.lanes} lane${options.lanes === 1 ? "" : "s"}`);
  const client = new FlowerClient(process.env.FLOWER_URL ?? "http://127.0.0.1:7101");
  await runWorker(client, options, stop.signal);
}
