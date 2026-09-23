import { collection, mutation } from "./index.ts";
import type { Context, Json, MaintenanceFailure, MutationContext, MutationMethod } from "./index.ts";
import { canonicalJson } from "./json.ts";

export interface ScheduledTimer<Args = Json> {
  state: "pending" | "failed";
  handler: string;
  args: Args;
  dueAt: number;
  attempts: number;
  error: { code: string; message: string } | null;
  createdAt: number;
  updatedAt: number;
}

export interface SchedulerOptions {
  /** Maximum failed attempts before a timer is left in failed state. Default 3. */
  maxAttempts?: number;
  /** First retry delay in milliseconds. Default 1000; doubles after each failure. */
  retryDelayMs?: number;
  /** Upper bound on retry delays. Default 60000. */
  maxRetryDelayMs?: number;
}

type Handlers = Record<string, MutationMethod<any, any>>;
type HandlerArgs<Handler> = Handler extends MutationMethod<infer Args, any> ? Args : never;

function object(value: unknown, label: string, allowed?: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor) || (allowed && !allowed.includes(key))) {
      throw new TypeError(`${label} contains an unsupported property`);
    }
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.length) throw new TypeError(`${label} must be a nonempty string`);

}

function integer(value: unknown, label: string, minimum = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer at least ${minimum}`);
  }
}

function now(ctx: Context): number {
  const value = ctx.now();
  integer(value, "Server time");
  return value;
}

function deadline(time: number, delay: number): number {
  integer(delay, "Delay");
  const dueAt = time + delay;
  integer(dueAt, "Deadline");
  return dueAt;
}

function validateTimer(timer: ScheduledTimer): void {
  const value = object(timer, "Timer", ["state", "handler", "args", "dueAt", "attempts", "error", "createdAt", "updatedAt"]);
  if (value.state !== "pending" && value.state !== "failed") throw new TypeError("Invalid timer state");
  identifier(value.handler, "Stored handler alias");
  canonicalJson(value.args);
  integer(value.dueAt, "Stored deadline");
  integer(value.attempts, "Stored attempts");
  integer(value.createdAt, "Stored createdAt");
  integer(value.updatedAt, "Stored updatedAt");
  if (value.error !== null) {
    const error = object(value.error, "Stored timer error", ["code", "message"]);
    if (typeof error.code !== "string" || typeof error.message !== "string") throw new TypeError("Invalid stored timer error");
  }
}

/**
 * Durable callbacks composed from ordinary TypeScript methods and records.
 * Register maintenance in define({ maintenance: timers.maintenance }). Only one
 * due timer runs per maintenance transaction, ordered by (dueAt, id). A bounded
 * host burst can promptly run more transactions while due work remains.
 * Deadlines mean "not before": outages and queued work may delay execution.
 * A callback's writes and timer deletion commit together. Its code may execute
 * again before commit, so external effects belong in a durable worker queue.
 */
export function scheduler<Registry extends Handlers>(name: string, handlers: Registry, options: SchedulerOptions = {}) {
  identifier(name, "Scheduler name");
  if (name.startsWith("$flower.")) throw new TypeError("Scheduler names beginning with $flower. are reserved");
  const runName = `internal.scheduler.${name}.run`;
  const errorName = `internal.scheduler.${name}.onError`;
  identifier(runName, "Generated maintenance name");
  identifier(errorName, "Generated error handler name");
  const config = object(options, "Scheduler options", ["maxAttempts", "retryDelayMs", "maxRetryDelayMs"]);
  const option = (key: string, fallback: number): unknown => Object.hasOwn(config, key) && config[key] !== undefined ? config[key] : fallback;
  const maxAttempts = option("maxAttempts", 3);
  const retryDelayMs = option("retryDelayMs", 1_000);
  const maxRetryDelayMs = option("maxRetryDelayMs", 60_000);
  integer(maxAttempts, "maxAttempts", 1);
  integer(retryDelayMs, "retryDelayMs", 1);
  integer(maxRetryDelayMs, "maxRetryDelayMs", 1);
  if (maxRetryDelayMs < retryDelayMs) throw new RangeError("Maximum retry delay must be at least the first retry delay");

  const inputHandlers = object(handlers, "Scheduler handlers");
  const registered: Record<string, MutationMethod<any, any>> = Object.create(null);
  for (const alias of Object.keys(inputHandlers)) {
    identifier(alias, "Handler alias");
    const handler = object(inputHandlers[alias], "Scheduler handler", ["kind", "name", "compute"]);
    identifier(handler.name, "Handler name");
    if (handler.kind !== "mutationMethod" || typeof handler.compute !== "function") {
      throw new TypeError("Scheduler handlers must be mutation methods");
    }
    registered[alias] = Object.freeze({ kind: "mutationMethod", name: handler.name, compute: handler.compute as MutationMethod<any, any>["compute"] });
  }
  Object.freeze(registered);
  const records = collection<ScheduledTimer>(name).index("due", ["state", "dueAt"]);

  function requireHandler(alias: unknown): asserts alias is keyof Registry & string {
    identifier(alias, "Handler alias");
    if (!Object.hasOwn(registered, alias)) {
      throw Object.assign(new Error(`Unknown scheduler handler ${JSON.stringify(alias)}`), { code: "SCHEDULER_HANDLER_MISSING" });
    }
  }

  function get(ctx: Context, id: string): ScheduledTimer | null {
    identifier(id, "Timer ID");
    const timer = ctx.get(records, id);
    if (timer !== null) validateTimer(timer);
    return timer;
  }

  function scan(ctx: Context, state?: "pending" | "failed"): (ScheduledTimer & { id: string })[] {
    if (state !== undefined && state !== "pending" && state !== "failed") throw new TypeError("Unknown timer state filter");
    return ctx.scan(records).map(({ key, value }) => {
      identifier(key, "Stored timer ID");
      validateTimer(value);
      return { id: key, ...value };
    }).filter((timer) => state === undefined || timer.state === state)
      .sort((a, b) => a.dueAt - b.dueAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  function firstDue(ctx: Context, time: number) {
    const row = ctx.range(records.by("due").range({ prefix: ["pending"], lte: time, limit: 1 })).rows[0];
    if (!row) return null;
    identifier(row.key, "Stored timer ID");
    validateTimer(row.value);
    return { id: row.key, ...row.value };
  }

  function schedule<Name extends keyof Registry & string>(
    ctx: MutationContext, id: string, dueAt: number, handler: Name, args: HandlerArgs<Registry[Name]>, time: number,
  ): ScheduledTimer<HandlerArgs<Registry[Name]>> {
    identifier(id, "Timer ID");
    integer(dueAt, "Deadline");
    requireHandler(handler);
    const copiedArgs = JSON.parse(canonicalJson(args)) as HandlerArgs<Registry[Name]>;
    const previous = get(ctx, id);
    const timer: ScheduledTimer<HandlerArgs<Registry[Name]>> = {
      state: "pending", handler, args: copiedArgs, dueAt, attempts: 0, error: null,
      createdAt: previous?.createdAt ?? time, updatedAt: time,
    };
    ctx.set(records, id, timer as ScheduledTimer);
    return timer;
  }

  const run = mutation(runName, (ctx, _args: null) => {
    const due = firstDue(ctx, now(ctx));
    if (due === null) return null;
    // Removal is staged before dispatch. A successful callback may replace this
    // same ID; a throwing callback is entirely discarded by the host.
    ctx.delete(records, due.id);
    requireHandler(due.handler);
    const result: unknown = registered[due.handler].compute(ctx, due.args);
    // A Promise, undefined, accessor, or other non-JSON return is a failed
    // callback, exactly as for an ordinary public mutation method.
    canonicalJson(result);
    return { id: due.id, $flower: { continue: firstDue(ctx, now(ctx)) !== null } };
  });

  const onError = mutation(errorName, (ctx, failure: MaintenanceFailure) => {
    const info = object(failure, "Maintenance failure", ["error", "failedAt"]);
    integer(info.failedAt, "Failure time");
    const time = now(ctx);
    // ctx.now() stays at the failed invocation's original time so selection is
    // identical. Retry delays start when the failed attempt actually finished.
    const failedAt = Math.max(info.failedAt, time);
    const cause = object(info.error, "Maintenance error", ["code", "message"]);
    if (typeof cause.code !== "string" || typeof cause.message !== "string") throw new TypeError("Maintenance error requires code and message strings");
    const due = firstDue(ctx, time);
    if (due === null) return null;
    const attempts = due.attempts + 1;
    integer(attempts, "Attempt count", 1);
    let delay = retryDelayMs;
    for (let attempt = 1; attempt < attempts && delay < maxRetryDelayMs; attempt++) {
      delay = delay > maxRetryDelayMs / 2 ? maxRetryDelayMs : delay * 2;
    }
    const exhausted = attempts >= maxAttempts || failedAt > Number.MAX_SAFE_INTEGER - delay;
    const { id, ...previous } = due;
    const timer: ScheduledTimer = {
      ...previous, state: exhausted ? "failed" : "pending", attempts,
      dueAt: exhausted ? due.dueAt : failedAt + delay, updatedAt: failedAt,
      error: { code: cause.code, message: cause.message },
    };
    ctx.set(records, id, timer);
    return { id, state: timer.state, attempts, $flower: { continue: firstDue(ctx, time) !== null } };
  });

  return Object.freeze({
    records,
    maintenance: Object.freeze({ run, onError }),
    get,
    scan,
    /** Replacing an ID debounces prior work and starts a new retry budget. */
    after<Name extends keyof Registry & string>(
      ctx: MutationContext, id: string, delayMs: number, handler: Name, args: HandlerArgs<Registry[Name]>,
    ): ScheduledTimer<HandlerArgs<Registry[Name]>> {
      const time = now(ctx);
      return schedule(ctx, id, deadline(time, delayMs), handler, args, time);
    },
    at<Name extends keyof Registry & string>(
      ctx: MutationContext, id: string, dueAt: number, handler: Name, args: HandlerArgs<Registry[Name]>,
    ): ScheduledTimer<HandlerArgs<Registry[Name]>> {
      return schedule(ctx, id, dueAt, handler, args, now(ctx));
    },
    cancel(ctx: MutationContext, id: string): boolean {
      if (get(ctx, id) === null) return false;
      ctx.delete(records, id);
      return true;
    },
    /** Retry a failed timer using current deployed handlers and a fresh retry budget. */
    retry(ctx: MutationContext, id: string, delayMs = 0): ScheduledTimer {
      const time = now(ctx);
      const dueAt = deadline(time, delayMs);
      const timer = get(ctx, id);
      if (timer === null || timer.state !== "failed") throw new Error("Only failed timers can be retried explicitly");
      requireHandler(timer.handler);
      const retried: ScheduledTimer = { ...timer, state: "pending", attempts: 0, error: null, dueAt, updatedAt: time };
      ctx.set(records, id, retried);
      return retried;
    },
  });
}
