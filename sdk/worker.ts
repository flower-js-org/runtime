import { backoff, FlowerClient, FlowerError, isTransient } from "./client.ts";
import type { RetryPolicy } from "./client.ts";
import type { ExternalWork } from "./external.ts";
import type { Json } from "./json.ts";
import type { Claim } from "./temporal.ts";

export type QueueWorkerEvent =
  | { readonly type: "claimed"; readonly lane: number; readonly job: Claim<Json> }
  | { readonly type: "completed"; readonly lane: number; readonly id: string }
  | { readonly type: "failed"; readonly lane: number; readonly id: string; readonly error: string }
  | { readonly type: "lost"; readonly lane: number; readonly id: string }
  | { readonly type: "unreported"; readonly lane: number; readonly id: string; readonly error: string }
  | { readonly type: "waiting"; readonly lane: number; readonly error: string };

export interface QueueWorkerOptions<P = Json, R = Json> {
  /** The queue.http() prefix; the worker uses its claim, renew, complete, fail and ready methods. */
  readonly queue: string;
  /** Do the job. It can run again after a crash, so give external services job.id as an idempotency key. */
  readonly work: (job: Claim<P>, signal: AbortSignal) => R | Promise<R>;
  /** Stop claiming, finish held jobs, then resolve. */
  readonly signal: AbortSignal;
  /** Unique per process. Defaults to a random identifier. */
  readonly owner?: string;
  /** Jobs this process runs at once. Default 1. */
  readonly lanes?: number;
  /** Lease length requested per claim and renewal. Default 30000. */
  readonly leaseMs?: number;
  /** Extend leases while work runs, so leases can stay short. Needs the renew method. Default true. */
  readonly renew?: boolean;
  /** Stop working this long before a lease ends. Default a fifth of leaseMs. */
  readonly marginMs?: number;
  /** For queue.http(prefix, { scope: "argument" }). */
  readonly scope?: string;
  readonly retry?: RetryPolicy;
  readonly onEvent?: (event: QueueWorkerEvent) => void;
}

function message(error: unknown): string {
  if (error instanceof FlowerError) return error.failure ? `${error.failure.code}: ${error.failure.message}` : `${error.code}: ${error.message}`;
  return String((error as { cause?: { code?: string } })?.cause?.code ?? (error as Error)?.message ?? error);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Run jobs from a queue until stopped: wait for readiness, claim, work within the
 * lease (renewing it), then complete or fail with retries that keep one request ID.
 */
export async function runQueueWorker<P = Json, R = Json>(client: FlowerClient<any>, options: QueueWorkerOptions<P, R>): Promise<void> {
  const untyped = client as FlowerClient;
  const { queue, work, lanes = 1, leaseMs = 30_000, renew = true, onEvent = () => {} } = options;
  // A lane's permanent error stops the other lanes from claiming too; they finish held jobs first.
  const halt = new AbortController();
  const signal = AbortSignal.any([options.signal, halt.signal]);
  const owner = options.owner ?? `worker-${crypto.randomUUID()}`;
  const marginMs = options.marginMs ?? Math.floor(leaseMs / 5);
  if (!Number.isSafeInteger(lanes) || lanes < 1) throw new TypeError("lanes must be a positive safe integer");
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= marginMs || marginMs < 0) throw new TypeError("leaseMs must exceed marginMs");
  const scope: Record<string, Json> = options.scope === undefined ? {} : { scope: options.scope };
  const send = async <T>(method: string, args: Json, until: number): Promise<T> =>
    (await untyped.mutate(`${queue}.${method}`, args, { retry: { ...options.retry, until } })).value as T;

  async function runJob(lane: number, job: Claim<P>, sentAt: number): Promise<void> {
    const identity = { id: job.id, owner: job.owner, token: job.token, ...(job.history ? { history: job.history } : {}), ...scope } as unknown as Json;
    let deadline = sentAt + leaseMs - marginMs;
    if (deadline <= Date.now()) return onEvent({ type: "lost", lane, id: job.id });
    const stop = new AbortController();
    let finished = false;
    let timer = setTimeout(() => stop.abort(new Error("The lease ran out")), deadline - Date.now());
    let renewal: ReturnType<typeof setInterval> | undefined;
    if (renew) {
      renewal = setInterval(async () => {
        const renewedAt = Date.now();
        try {
          await send("renew", { ...(identity as object), leaseMs } as Json, deadline);
          if (finished) return;
          deadline = renewedAt + leaseMs - marginMs;
          clearTimeout(timer);
          timer = setTimeout(() => stop.abort(new Error("The lease ran out")), deadline - Date.now());
        } catch (error) {
          if (error instanceof FlowerError && error.failure?.code === "LEASE_LOST") stop.abort(new Error("The lease was lost"));
        }
      }, Math.max(1, Math.floor((leaseMs - marginMs) / 3)));
    }
    let outcome: [string, Json];
    try {
      const result = await work(job, stop.signal);
      if (stop.signal.aborted) throw stop.signal.reason;
      outcome = ["complete", { ...(identity as object), result: result as Json } as Json];
    } catch (error) {
      // Abortable APIs reject with a generic AbortError; the lease's reason says why.
      outcome = ["fail", { ...(identity as object), error: { message: message(stop.signal.aborted ? stop.signal.reason : error) } } as Json];
    } finally {
      finished = true;
      clearTimeout(timer);
      clearInterval(renewal);
    }
    try {
      await send(outcome[0], outcome[1], deadline + marginMs);
      onEvent(outcome[0] === "complete" ? { type: "completed", lane, id: job.id } : { type: "failed", lane, id: job.id, error: String((outcome[1] as { error: { message: string } }).error.message) });
    } catch (error) {
      if (error instanceof FlowerError && error.failure?.code === "LEASE_LOST") onEvent({ type: "lost", lane, id: job.id });
      else onEvent({ type: "unreported", lane, id: job.id, error: message(error) });
    }
  }

  async function lane(index: number): Promise<void> {
    for (let failures = 0; !signal.aborted;) {
      try {
        await untyped.waitUntil(`${queue}.ready`, options.scope === undefined ? null : scope, Boolean, { signal });
      } catch (error) {
        if (signal.aborted) return;
        if (!isTransient(error)) throw error;
        onEvent({ type: "waiting", lane: index, error: message(error) });
        await pause(backoff(failures++), signal);
        continue;
      }
      while (!signal.aborted) {
        const sentAt = Date.now();
        let job: Claim<P> | null;
        try {
          job = await send<Claim<P> | null>("claim", { owner, leaseMs, ...scope }, sentAt + leaseMs);
          failures = 0;
        } catch (error) {
          if (!isTransient(error)) throw error;
          onEvent({ type: "waiting", lane: index, error: message(error) });
          await pause(backoff(failures++), signal);
          break;
        }
        if (job === null) break;
        onEvent({ type: "claimed", lane: index, job: job as Claim<Json> });
        await runJob(index, job, sentAt);
      }
    }
  }

  let failed: { error: unknown } | undefined;
  await Promise.all(Array.from({ length: lanes }, (_, index) => lane(index + 1).catch((error) => { failed ??= { error }; halt.abort(); })));
  if (failed) throw failed.error;
}

export type ReconcileEvent =
  | { readonly type: "published"; readonly key: string; readonly accepted: boolean }
  | { readonly type: "failed"; readonly key: string; readonly error: string }
  | { readonly type: "waiting"; readonly error: string };

export interface ReconcileOptions<A = Json, I = Json, R = Json> {
  /** The external.http() prefix; uses pending and publish, or next for pools. */
  readonly external: string;
  /** Compute the result for an input. It may run more than once for the same input. */
  readonly compute: (input: I, work: ExternalWork<A, I>, signal: AbortSignal) => R | Promise<R>;
  readonly signal: AbortSignal;
  /** Keep one key current. Omit to drain every tracked key through next. */
  readonly args?: A;
  /** Pool mode: work only on keys in this hash shard. */
  readonly shard?: readonly [index: number, count: number];
  /** Pool mode: parallel computations. Default 1. */
  readonly concurrency?: number;
  /** Pool mode: keys fetched per round. Default 16. */
  readonly batch?: number;
  readonly retry?: RetryPolicy;
  readonly onEvent?: (event: ReconcileEvent) => void;
}

/**
 * Keep external values current: wait for pending work, compute it, and publish
 * it guarded by its input key. Stale results are rejected, never stored.
 */
export async function reconcile<A = Json, I = Json, R = Json>(client: FlowerClient<any>, options: ReconcileOptions<A, I, R>): Promise<void> {
  const untyped = client as FlowerClient;
  const { external, compute, signal, onEvent = () => {} } = options;
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError("concurrency must be a positive safe integer");
  const failures = new Map<string, number>();

  async function failed(key: string, error: unknown, stop: AbortSignal): Promise<void> {
    const count = (failures.get(key) ?? 0) + 1;
    failures.set(key, count);
    onEvent({ type: "failed", key, error: message(error) });
    await pause(backoff(count - 1), stop);
  }

  async function settle(work: ExternalWork<A, I>, stop: AbortSignal): Promise<void> {
    let value: R;
    try {
      value = await compute(work.input, work, stop);
    } catch (error) {
      if (!stop.aborted) await failed(work.key, error, stop);
      return;
    }
    let receipt: Json;
    try {
      ({ value: receipt } = await untyped.mutate(`${external}.publish`, { args: work.args, key: work.key, value } as unknown as Json,
        { retry: options.retry ?? true, signal: stop }));
    } catch (error) {
      // The publish method rejected this result (e.g. its schema); other keys can still progress.
      if (error instanceof FlowerError && error.code === "EVALUATION_FAILED" && !stop.aborted) return failed(work.key, error, stop);
      throw error;
    }
    failures.delete(work.key);
    onEvent({ type: "published", key: work.key, accepted: (receipt as { accepted: boolean }).accepted });
  }

  for (let attempt = 0; !signal.aborted;) {
    try {
      if (options.args !== undefined) {
        const { value } = await untyped.waitUntil(`${external}.pending`, options.args as Json, Boolean, { signal });
        await settle(value as unknown as ExternalWork<A, I>, signal);
      } else {
        const request = { limit: options.batch ?? 16, ...(options.shard ? { shard: options.shard } : {}) } as unknown as Json;
        const { value } = await untyped.waitUntil(`${external}.next`, request, (items) => Array.isArray(items) && items.length > 0, { signal });
        const queue = [...(value as unknown as ExternalWork<A, I>[])];
        const batch = new AbortController();
        const stop = AbortSignal.any([signal, batch.signal]);
        await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
          try {
            for (let work = queue.shift(); work && !stop.aborted; work = queue.shift()) await settle(work, stop);
          } catch (error) {
            batch.abort(error);
            throw error;
          }
        }));
      }
      attempt = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (!isTransient(error)) throw error;
      onEvent({ type: "waiting", error: message(error) });
      await pause(backoff(attempt++), signal);
    }
  }
}
