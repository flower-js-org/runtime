import { backoff, isTransient, type FlowerClient, type FlowerFetch, type Json } from "@flower-js/sdk";
import { createHttp2Transport } from "@flower-js/sdk/http2";
import type { Claim } from "@flower-js/sdk/temporal";

// runQueueWorker gives each lane its own readiness watch, which suits a handful of lanes.
// A pool runs thousands of short jobs at once behind one watch per queue scope: a few
// claimers take jobs while there is room and the queue has work, and go back to the
// shared watch when a claim comes back empty.

export interface PoolOptions<P, R> {
  /** The queue's method prefix: claim, complete, fail and ready. */
  readonly queue: string;
  readonly scope?: string;
  readonly signal: AbortSignal;
  /** Jobs in progress at once. */
  readonly concurrency: number;
  /** Claims in flight at once. Default 16. */
  readonly claimers?: number;
  /** Leases are not renewed, so jobs must finish well within this. Default 60 s. */
  readonly leaseMs?: number;
  readonly owner?: string;
  readonly work: (job: Claim<P>, signal: AbortSignal) => Promise<R>;
  readonly onEvent?: (event: PoolEvent) => void;
}

export type PoolEvent =
  | { readonly type: "completed" | "failed" | "lost"; readonly id: string }
  | { readonly type: "waiting"; readonly error: string };

/** Claim and run jobs until the signal fires, then let held jobs finish and report. */
export async function runPool<P, R>(client: FlowerClient<any>, options: PoolOptions<P, R>): Promise<void> {
  const untyped = client as FlowerClient;
  const { queue, signal, concurrency, leaseMs = 60_000, onEvent = () => {} } = options;
  const owner = options.owner ?? `pool-${crypto.randomUUID()}`;
  const scope: Record<string, Json> = options.scope === undefined ? {} : { scope: options.scope };
  const running = new Set<Promise<void>>();
  const roomWaiters: Array<() => void> = [];
  let claiming = 0;
  let ready: Promise<void> | null = null;
  let failures = 0;

  const room = async () => {
    while (running.size + claiming >= concurrency) await new Promise<void>((done) => roomWaiters.push(done));
  };

  /** Resolves once the queue has shown work since the last empty claim. One watch serves every claimer. */
  const whenReady = () => ready ??= (async () => {
    for (;;) {
      try {
        await untyped.waitUntil(`${queue}.ready`, options.scope === undefined ? null : scope, Boolean, { signal });
        return;
      } catch (error) {
        if (signal.aborted) return;
        if (!isTransient(error)) throw error;
        onEvent({ type: "waiting", error: String(error) });
        await pause(backoff(failures++), signal);
      }
    }
  })();

  function start(job: Claim<P>, claimedAt: number): void {
    const identity = { id: job.id, owner: job.owner, token: job.token, ...(job.history ? { history: job.history } : {}), ...scope };
    const reportBy = claimedAt + leaseMs;
    const stop = AbortSignal.timeout(Math.max(0, reportBy - Date.now() - Math.min(5_000, leaseMs / 5)));
    const task = (async () => {
      let method: "complete" | "fail";
      let body: Record<string, unknown>;
      try {
        body = { ...identity, result: await options.work(job, stop) };
        method = "complete";
      } catch (error) {
        body = { ...identity, error: { message: error instanceof Error ? error.message : String(error) } };
        method = "fail";
      }
      try {
        await untyped.mutate(`${queue}.${method}`, body as Json, { retry: { until: reportBy } });
        onEvent({ type: method === "complete" ? "completed" : "failed", id: job.id });
      } catch {
        // Refused (the lease moved on) or never answered: either way the queue hands the job out again once the lease ends.
        onEvent({ type: "lost", id: job.id });
      }
    })().finally(() => {
      running.delete(task);
      roomWaiters.shift()?.();
    });
    running.add(task);
  }

  async function claimer(): Promise<void> {
    while (!signal.aborted) {
      await room();
      await whenReady();
      if (signal.aborted) return;
      claiming += 1;
      const claimedAt = Date.now();
      let job: Claim<P> | null;
      try {
        job = (await untyped.mutate(`${queue}.claim`, { owner, leaseMs, ...scope }, { retry: { until: claimedAt + leaseMs } })).value as Claim<P> | null;
        failures = 0;
      } catch (error) {
        if (!isTransient(error)) throw error;
        onEvent({ type: "waiting", error: String(error) });
        await pause(backoff(failures++), signal);
        continue;
      } finally {
        claiming -= 1;
        roomWaiters.shift()?.();
      }
      if (job === null) ready = null;
      else start(job, claimedAt);
    }
  }

  const claimers = Math.max(1, Math.min(options.claimers ?? 16, concurrency));
  try {
    await Promise.all(Array.from({ length: claimers }, claimer));
  } finally {
    await Promise.allSettled(running);
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) return done();
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      done();
    }
  });
}

/**
 * HTTP/2 over several connections, taken in turn. One connection carries only as many
 * concurrent streams as the server allows, and every open watch holds one.
 */
export function http2Connections(count: number): { fetch: FlowerFetch; close(): Promise<void> } {
  const transports = Array.from({ length: count }, () => createHttp2Transport({ requestTimeoutMs: 120_000 }));
  let next = 0;
  return {
    fetch: (url, init) => transports[next++ % count]!.fetch(url, init),
    close: async () => { await Promise.all(transports.map((transport) => transport.close())); },
  };
}
