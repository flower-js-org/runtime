import { canonicalJson } from "./json.ts";
import { collection } from "./index.ts";
import type { Context, Json, HistoryIdentity, MutationContext, RangeOptions, RangeQuery } from "./index.ts";

// A page size controls temporary guest allocation, never the total work selected.
function* pages<T>(ctx: Context, index: { range(options: RangeOptions): RangeQuery<T> }, bounds: Omit<RangeOptions, "limit" | "after">) {
  let after: string | undefined;
  do {
    const page = ctx.range(index.range({ ...bounds, limit: 64, ...(after === undefined ? {} : { after }) }));
    yield* page.rows;
    after = page.cursor ?? undefined;
  } while (after !== undefined);
}

/** Millisecond deadlines. null explicitly disables expiration. */
export type Expiration = null | { at: number } | { afterCreationMs: number } | { afterUpdateMs: number };
export interface ExpiringEntry<T> {
  value: T;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

function configuration(value: unknown, label: string, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !fields.includes(key) || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} contains an unsupported property`);
    }
  }
  return value as Record<string, unknown>;
}

function backingName(value: unknown, label: string): asserts value is string {
  name(value, label);
  if (value.startsWith("$flower.")) throw new TypeError("Collection names beginning with $flower. are reserved");
}

function integer(value: unknown, name: string, minimum = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer at least ${minimum}`);
  }
}

function name(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a nonempty string`);
}

function clock(ctx: Context): number {
  const now = ctx.now();
  integer(now, "Server time");
  return now;
}

function addTime(base: number, duration: number): number {
  const deadline = base + duration;
  integer(deadline, "Deadline");
  return deadline;
}

function expirationDeadline(policy: Expiration, createdAt: number, updatedAt: number): number | null {
  if (policy === null) return null;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new TypeError("Invalid expiration policy");
  const prototype = Object.getPrototypeOf(policy);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Invalid expiration policy");
  const keys = Reflect.ownKeys(policy);
  if (keys.length !== 1 || typeof keys[0] !== "string") throw new TypeError("Expiration requires exactly one deadline rule");
  const key = keys[0];
  const descriptor = Object.getOwnPropertyDescriptor(policy, key)!;
  if (!("value" in descriptor) || !descriptor.enumerable) throw new TypeError("Expiration must use an ordinary value property");
  const value: unknown = descriptor.value;
  integer(value, "Expiration time or duration");
  if (key === "at") return value;
  if (key === "afterCreationMs") return addTime(createdAt, value);
  if (key === "afterUpdateMs") return addTime(updatedAt, value);
  throw new TypeError(`Unknown expiration rule ${key}`);
}

function validEntry<T>(entry: ExpiringEntry<T>): void {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("Invalid expiring record");
  integer(entry.createdAt, "createdAt");
  integer(entry.updatedAt, "updatedAt");
  if (entry.expiresAt !== null) integer(entry.expiresAt, "expiresAt");
}

/**
 * Expiration is checked on reads; sweep() only reclaims physical storage.
 * A set() override applies to that write. Later omitted policies use the
 * collection default, which is copied when the helper is constructed.
 */
export function expiringCollection<T = Json>(name_: string, options: { expiration?: Expiration } = {}) {
  backingName(name_, "Collection name");
  const config = configuration(options, "Expiration configuration", ["expiration"]);
  const input = (Object.hasOwn(config, "expiration") && config.expiration !== undefined ? config.expiration : null) as Expiration;
  expirationDeadline(input, 0, 0);
  const policy: Expiration = input === null ? null : Object.freeze({ ...input });
  const records = collection<ExpiringEntry<T>>(name_).index("expiry", ["expiresAt"]);
  function live(entry: ExpiringEntry<T> | null, now: number): entry is ExpiringEntry<T> {
    if (entry === null) return false;
    validEntry(entry);
    return entry.expiresAt === null || now < entry.expiresAt;
  }
  function entry(ctx: Context, key: string): ExpiringEntry<T> | null {
    name(key, "Key");
    const stored = ctx.get(records, key);
    return live(stored, clock(ctx)) ? stored : null;
  }
  return Object.freeze({
    /** Ordinary storage is available to internal code; public reads should use the helper. */
    records,
    entry,
    get(ctx: Context, key: string): T | null {
      const stored = entry(ctx, key);
      return stored === null ? null : stored.value;
    },
    scan(ctx: Context): { key: string; value: T }[] {
      const now = clock(ctx);
      return ctx.scan(records).filter((row) => live(row.value, now))
        .map((row) => ({ key: row.key, value: row.value.value }));
    },
    set(ctx: MutationContext, key: string, value: T, expiration: Expiration = policy): ExpiringEntry<T> {
      name(key, "Key");
      canonicalJson(value);
      const now = clock(ctx);
      const previous = ctx.get(records, key);
      const createdAt = live(previous, now) ? previous.createdAt : now;
      const next: ExpiringEntry<T> = { value, createdAt, updatedAt: now, expiresAt: expirationDeadline(expiration, createdAt, now) };
      ctx.set(records, key, next);
      return next;
    },
    delete(ctx: MutationContext, key: string): void {
      name(key, "Key");
      ctx.delete(records, key);
    },
    sweep(ctx: MutationContext): number {
      const now = clock(ctx);
      let removed = 0;
      for (const row of pages(ctx, records.by("expiry"), { gte: 0, lte: now })) {
        if (!live(row.value, now)) { ctx.delete(records, row.key); removed++; }
      }
      return removed;
    },
  });
}

export interface Lease { owner: string; token: number; expiresAt: number; history?: HistoryIdentity }
export interface Job<Payload = Json, Result = Json> {
  payload: Payload;
  /** Queue namespace within the shared backing collection. */
  scope: string;
  id: string;
  /** Indexed mirror of lease.expiresAt; null unless leased. */
  leaseExpiresAt: number | null;
  state: "pending" | "leased" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  attempts: number;
  lease: Lease | null;
  result: Result | null;
  error: Json;
}
export interface Claim<Payload = Json> extends Lease { id: string; payload: Payload; attempt: number }
export interface LeaseIdentity { id: string; owner: string; token: number; history?: HistoryIdentity }

// Shared across queues and never removed by helper operations, including job replacement.
const fencing = collection<{ last: number }>("$flower.fencing");

function leaseError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "LEASE_LOST" });
}

function validJob<Payload, Result>(job: Job<Payload, Result>): void {
  if (!job || typeof job !== "object" || !["pending", "leased", "completed", "failed"].includes(job.state)) {
    throw new TypeError("Invalid queue record");
  }
  if (typeof job.scope !== "string") throw new TypeError("Invalid queue scope");
  name(job.id, "Job ID");
  integer(job.createdAt, "Job createdAt");
  integer(job.updatedAt, "Job updatedAt");
  integer(job.attempts, "Job attempts");
  if (job.state === "leased") {
    if (!job.lease || typeof job.lease !== "object") throw new TypeError("Invalid job lease");
    name(job.lease.owner, "Lease owner");
    integer(job.lease.token, "Lease token", 1);
    integer(job.lease.expiresAt, "Lease deadline");
    if (job.leaseExpiresAt !== job.lease.expiresAt) throw new TypeError("Invalid indexed lease deadline");
  } else if (job.lease !== null || job.leaseExpiresAt !== null) throw new TypeError("Unleased job contains a lease");
}

/**
 * Transactional leases and fencing expressed in ordinary TypeScript operations.
 * A deduplicated HTTP claim retry returns its original expiresAt, even if that
 * lease has since expired. Workers must verify deadlines before starting work.
 * Fencing tokens must also be enforced by any external sink that workers write.
 */
export function workQueue<Payload = Json, Result = Json>(
  name_: string, options: { maxLeaseMs: number; defaultLeaseMs?: number; scope?: string },
) {
  backingName(name_, "Queue name");
  const config = configuration(options, "Queue configuration", ["maxLeaseMs", "defaultLeaseMs", "scope"]);
  const maxLeaseMs = Object.hasOwn(config, "maxLeaseMs") ? config.maxLeaseMs : undefined;
  integer(maxLeaseMs, "maxLeaseMs", 1);
  const defaultLeaseMs = Object.hasOwn(config, "defaultLeaseMs") && config.defaultLeaseMs !== undefined ? config.defaultLeaseMs : maxLeaseMs;
  integer(defaultLeaseMs, "defaultLeaseMs", 1);
  if (defaultLeaseMs > maxLeaseMs) throw new RangeError("Default lease exceeds the configured maximum");
  const scope = Object.hasOwn(config, "scope") ? config.scope : "";
  if (typeof scope !== "string") throw new TypeError("Queue scope must be a string");
  const records = collection<Job<Payload, Result>>(name_)
    .index("pending", ["scope", "state", "createdAt", "id"])
    .index("leased", ["scope", "state", "leaseExpiresAt"]);
  const storedId = (id: string): string => canonicalJson([scope, id]);
  const externalId = (key: string): string => {
    const pair: unknown = JSON.parse(key);
    if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== scope || typeof pair[1] !== "string") throw new TypeError("Invalid scoped queue ID");
    return pair[1];
  };
  const check = (job: Job<Payload, Result>) => {
    validJob(job);
    if (job.scope !== scope) throw new TypeError("Queue record belongs to another scope");
  };
  function current(job: Job<Payload, Result> | null, now: number): Job<Payload, Result> | null {
    if (job === null) return null;
    check(job);
    if (job.state !== "leased" || now < job.lease!.expiresAt) return job;
    return {
      ...job, state: "pending", updatedAt: job.lease!.expiresAt, lease: null, leaseExpiresAt: null,
      error: { code: "LEASE_EXPIRED", message: "Worker lease expired", at: job.lease!.expiresAt },
    };
  }
  function held(ctx: MutationContext, identity: LeaseIdentity, now: number): Job<Payload, Result> {
    if (!identity || typeof identity !== "object") throw new TypeError("Lease identity is required");
    name(identity.id, "Job ID");
    name(identity.owner, "Lease owner");
    integer(identity.token, "Lease token", 1);
    const history=ctx.history();
    const job = ctx.get(records, storedId(identity.id));
    if (job !== null) check(job);
    if (!job || job.state !== "leased" || job.lease!.owner !== identity.owner ||
        job.lease!.token !== identity.token || now >= job.lease!.expiresAt ||
        canonicalJson(identity.history??null)!==canonicalJson(history) ||
        canonicalJson(job.lease!.history??null)!==canonicalJson(history)) {
      throw leaseError("Job lease is missing, expired, or held by another claim");
    }
    return job;
  }
  return Object.freeze({
    records,
    /** Explicit full scoped inspection, e.g. operator dashboards. */
    scan(ctx: Context): { key: string; value: Job<Payload, Result> }[] {
      return Array.from(pages(ctx, records.by("pending"), { prefix: [scope] }), (row) => {
        check(row.value);
        return { key: externalId(row.key), value: row.value };
      }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    },
    enqueue(ctx: MutationContext, id: string, payload: Payload, enqueueOptions: { replaceFinished?: boolean } = {}): Job<Payload, Result> {
      name(id, "Job ID");
      canonicalJson(payload);
      const enqueueConfig = configuration(enqueueOptions, "Enqueue options", ["replaceFinished"]);
      const replaceFinished = Object.hasOwn(enqueueConfig, "replaceFinished") ? enqueueConfig.replaceFinished : undefined;
      if (replaceFinished !== undefined && typeof replaceFinished !== "boolean") {
        throw new TypeError("replaceFinished must be boolean");
      }
      const now = clock(ctx);
      const previous = ctx.get(records, storedId(id));
      if (previous !== null) {
        check(previous);
        if (!replaceFinished || !["completed", "failed"].includes(previous.state)) {
          throw new Error(`Job ${id} already exists`);
        }
      }
      const job: Job<Payload, Result> = {
        payload, scope, id, state: "pending", createdAt: now, updatedAt: now, attempts: 0,
        lease: null, leaseExpiresAt: null, result: null, error: null,
      };
      ctx.set(records, storedId(id), job);
      return job;
    },
    get(ctx: Context, id: string): Job<Payload, Result> | null {
      name(id, "Job ID");
      return current(ctx.get(records, storedId(id)), clock(ctx));
    },
    claim(ctx: MutationContext, owner: string, leaseMs: number = defaultLeaseMs): Claim<Payload> | null {
      name(owner, "Lease owner");
      integer(leaseMs, "Lease duration", 1);
      if (leaseMs > maxLeaseMs) throw new RangeError("Lease duration exceeds the configured maximum");
      const now = clock(ctx);
      const expiresAt = addTime(now, leaseMs);
      let selected = ctx.range(records.by("pending").range({ prefix: [scope, "pending"], limit: 1 })).rows[0];
      if (selected) check(selected.value);
      // Preserve creation-order FIFO across expired and never-claimed jobs.
      // Work is proportional to expired leases, not total historical queue size.
      for (const row of pages(ctx, records.by("leased"), { prefix: [scope, "leased"], lte: now })) {
        const value = current(row.value, now)!;
        if (!selected || value.createdAt < selected.value.createdAt ||
            (value.createdAt === selected.value.createdAt && externalId(row.key) < externalId(selected.key))) selected = { key: row.key, value };
      }
      if (!selected) return null;
      const counter = ctx.get(fencing, "queue");
      const last = counter === null ? 0 : counter.last;
      integer(last, "Persistent fencing counter");
      const token = last + 1;
      integer(token, "Next fencing token", 1);
      const attempt = selected.value.attempts + 1;
      integer(attempt, "Claim attempt", 1);
      const history=ctx.history();
      const lease = { owner, token, expiresAt, ...(history===null?{}:{history}) };
      ctx.set(fencing, "queue", { last: token });
      ctx.set(records, selected.key, { ...selected.value, state: "leased", lease, leaseExpiresAt: expiresAt, attempts: attempt, updatedAt: now });
      return { id: externalId(selected.key), payload: selected.value.payload, ...lease, attempt };
    },
    complete(ctx: MutationContext, identity: LeaseIdentity, result: Result): Job<Payload, Result> {
      canonicalJson(result);
      const now = clock(ctx);
      const job = held(ctx, identity, now);
      const completed: Job<Payload, Result> = { ...job, state: "completed", updatedAt: now, lease: null, leaseExpiresAt: null, result, error: null };
      ctx.set(records, storedId(identity.id), completed);
      return completed;
    },
    fail(ctx: MutationContext, identity: LeaseIdentity, error: Json): Job<Payload, Result> {
      canonicalJson(error);
      const now = clock(ctx);
      const job = held(ctx, identity, now);
      const failed: Job<Payload, Result> = { ...job, state: "failed", updatedAt: now, lease: null, leaseExpiresAt: null, error };
      ctx.set(records, storedId(identity.id), failed);
      return failed;
    },
    retry(ctx: MutationContext, id: string): Job<Payload, Result> {
      name(id, "Job ID");
      const now = clock(ctx);
      const job = ctx.get(records, storedId(id));
      if (job !== null) check(job);
      if (!job || job.state !== "failed") throw new Error("Only failed jobs can be retried explicitly");
      const pending: Job<Payload, Result> = { ...job, state: "pending", updatedAt: now, lease: null, leaseExpiresAt: null, result: null };
      ctx.set(records, storedId(id), pending);
      return pending;
    },
    sweep(ctx: MutationContext): number {
      const now = clock(ctx);
      let reclaimed = 0;
      for (const row of pages(ctx, records.by("leased"), { prefix: [scope, "leased"], lte: now })) {
        const effective = current(row.value, now)!;
        if (row.value.state === "leased" && effective.state === "pending") {
          ctx.set(records, row.key, effective);
          reclaimed++;
        }
      }
      return reclaimed;
    },
  });
}
