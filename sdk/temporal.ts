import { canonicalJson, type Json } from "./json.ts";
import { collection, component, fail, mutation, plainObject, query, requireName, task } from "./core.ts";
import type {
  Access, Collection, Component, Context, HistoryIdentity, MutationContext, MutationMethod, QueryContext, QueryMethod, RangeOptions, RangeQuery, Row,
} from "./core.ts";
import { schema as adopt, v, ValidationError, type Optional, type Schema, type SchemaLike } from "./schema.ts";

function* pages<T, K>(ctx: Context, index: { range(options: RangeOptions): RangeQuery<T, K> }, bounds: Omit<RangeOptions, "limit" | "after">): Generator<Row<T, K>> {
  let after: string | undefined;
  do {
    const page = ctx.range(index.range({ ...bounds, limit: 64, ...(after === undefined ? {} : { after }) }));
    yield* page.rows;
    after = page.cursor ?? undefined;
  } while (after !== undefined);
}

function integer(value: unknown, label: string, minimum = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer at least ${minimum}`);
  }
}

function clock(ctx: Context): number {
  const now = ctx.now();
  integer(now, "Server time");
  return now;
}

function reserved(name: unknown, label: string): asserts name is string {
  requireName(name, label);
  if (name.startsWith("$flower.")) throw new TypeError(`${label}s beginning with $flower. are reserved`);
}

function validated<T>(schema: Schema<T> | null, value: unknown, label: string): T {
  if (schema) {
    try { schema.parse(value); }
    catch (error) {
      if (error instanceof ValidationError) fail("INVALID_ARGUMENT", `${label} ${error.message}`, { path: [...error.path] });
      throw error;
    }
  } else canonicalJson(value);
  return value as T;
}

// ---- Expiring collections

/** Millisecond deadlines. null disables expiration. */
export type Expiration = null | { at: number } | { afterCreationMs: number } | { afterUpdateMs: number };
export interface ExpiringEntry<T> { value: T; createdAt: number; updatedAt: number; expiresAt: number | null }

function deadline(policy: Expiration, createdAt: number, updatedAt: number): number | null {
  if (policy === null) return null;
  const rule = plainObject(policy, "Expiration policy", ["at", "afterCreationMs", "afterUpdateMs"]);
  const keys = Object.keys(rule);
  if (keys.length !== 1) throw new TypeError("Expiration requires exactly one deadline rule");
  const value = rule[keys[0]];
  integer(value, "Expiration time or duration");
  const result = keys[0] === "at" ? value : (keys[0] === "afterCreationMs" ? createdAt : updatedAt) + value;
  integer(result, "Deadline");
  return result;
}

export interface ExpiringCollection<T> extends Component {
  readonly records: Collection<ExpiringEntry<T>, string, { readonly expiry: readonly ["expiresAt"] }>;
  entry(ctx: Context, key: string): ExpiringEntry<T> | null;
  get(ctx: Context, key: string): T | null;
  scan(ctx: Context): Row<T>[];
  set(ctx: MutationContext, key: string, value: T, expiration?: Expiration): ExpiringEntry<T>;
  delete(ctx: MutationContext, key: string): void;
}

/** Reads hide records at ctx.now() >= expiresAt; a maintenance task reclaims their storage. */
export function expiringCollection<T = Json>(name: string, options: { readonly expiration?: Expiration; readonly value?: SchemaLike<T> } = {}): ExpiringCollection<T> {
  reserved(name, "Collection name");
  const settings = plainObject(options, "Expiration configuration", ["expiration", "value"]);
  const configured = (settings.expiration ?? null) as Expiration;
  deadline(configured, 0, 0);
  // Snapshot the validated default so later changes to the caller's object have no effect.
  const fallback = configured === null ? null : Object.freeze({ ...configured }) as Expiration;
  const valueSchema = settings.value === undefined ? null : adopt(settings.value as SchemaLike<T>);
  const records = collection<ExpiringEntry<T>>(name).index("expiry", ["expiresAt"]);
  const live = (entry: ExpiringEntry<T> | null, now: number): entry is ExpiringEntry<T> =>
    entry !== null && (entry.expiresAt === null || now < entry.expiresAt);
  function entry(ctx: Context, key: string): ExpiringEntry<T> | null {
    requireName(key, "Key");
    const stored = ctx.get(records, key);
    return live(stored, clock(ctx)) ? stored : null;
  }
  const sweep = task(`expiring:${name}`, {
    due: (ctx) => ctx.range(records.by("expiry").range({ gte: 0, limit: 1 })).rows[0]?.value.expiresAt ?? null,
    run(ctx) {
      const now = clock(ctx);
      const rows = ctx.range(records.by("expiry").range({ gte: 0, lte: now, limit: 64 })).rows;
      for (const row of rows) ctx.delete(records, row.key);
      return { expired: rows.length };
    },
  });
  return Object.freeze({
    ...component({ collections: [records], tasks: [sweep] }),
    records,
    entry,
    get(ctx: Context, key: string): T | null { return entry(ctx, key)?.value ?? null; },
    scan(ctx: Context): Row<T>[] {
      const now = clock(ctx);
      return ctx.scan(records).filter((row) => live(row.value, now)).map((row) => ({ key: row.key, value: row.value.value }));
    },
    set(ctx: MutationContext, key: string, value: T, expiration: Expiration = fallback): ExpiringEntry<T> {
      requireName(key, "Key");
      validated(valueSchema, value, "Value");
      const now = clock(ctx);
      const previous = ctx.get(records, key);
      const createdAt = live(previous, now) ? previous.createdAt : now;
      const next: ExpiringEntry<T> = { value, createdAt, updatedAt: now, expiresAt: deadline(expiration, createdAt, now) };
      ctx.set(records, key, next);
      return next;
    },
    delete(ctx: MutationContext, key: string): void {
      requireName(key, "Key");
      ctx.delete(records, key);
    },
  }) as unknown as ExpiringCollection<T>;
}

// ---- Work queues

export interface Lease { owner: string; token: number; expiresAt: number; history?: HistoryIdentity }
export interface Job<P = Json, R = Json> {
  scope: string;
  id: string;
  payload: P;
  state: "pending" | "leased" | "completed" | "failed";
  /** When a pending job may be claimed; null otherwise. */
  availableAt: number | null;
  /** Indexed mirror of lease.expiresAt; null unless leased. */
  leaseExpiresAt: number | null;
  lease: Lease | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  result: R | null;
  error: Json;
}
export interface Claim<P = Json> extends Lease { scope: string; id: string; payload: P; attempt: number }
export interface LeaseIdentity { id: string; owner: string; token: number; history?: HistoryIdentity }
export interface QueueRetry { readonly maxAttempts?: number; readonly initialDelayMs?: number; readonly maxDelayMs?: number }
export interface QueueOptions<P, R> {
  readonly lease?: { readonly defaultMs?: number; readonly maxMs?: number };
  /** Automatic retries after fail() or an expired lease. false makes fail() final. */
  readonly retry?: QueueRetry | false;
  readonly payload?: SchemaLike<P>;
  readonly result?: SchemaLike<R>;
}
export interface QueueStats {
  /** A claim would succeed now. */
  readonly ready: boolean;
  /** When the longest-waiting claimable job became available. */
  readonly oldestReadyAt: number | null;
  /** When a delayed job or running lease next makes work available. */
  readonly nextAvailableAt: number | null;
}

export interface QueueView<P = Json, R = Json> {
  enqueue(ctx: MutationContext, id: string, payload: P, options?: { readonly delayMs?: number; readonly at?: number; readonly replace?: boolean }): Job<P, R>;
  /** Lease the job that has waited longest, or return null. */
  claim(ctx: MutationContext, owner: string, options?: { readonly leaseMs?: number }): Claim<P> | null;
  /** Extend a current lease; the fencing token stays the same. */
  renew(ctx: MutationContext, lease: LeaseIdentity, options?: { readonly leaseMs?: number }): Claim<P>;
  complete(ctx: MutationContext, lease: LeaseIdentity, result: R): Job<P, R>;
  /** Retries with backoff unless retry is false or attempts are exhausted. */
  fail(ctx: MutationContext, lease: LeaseIdentity, error: Json, options?: { readonly retry?: boolean; readonly delayMs?: number }): Job<P, R>;
  /** Requeue a failed job with a fresh attempt budget. */
  retry(ctx: MutationContext, id: string, options?: { readonly delayMs?: number }): Job<P, R>;
  cancel(ctx: MutationContext, id: string): boolean;
  get(ctx: Context, id: string): Job<P, R> | null;
  scan(ctx: Context): Job<P, R>[];
  ready(ctx: Context): boolean;
  stats(ctx: Context): QueueStats;
}

type QueueIndexes = {
  readonly ready: readonly ["scope", "state", "availableAt"];
  readonly leases: readonly ["scope", "state", "leaseExpiresAt"];
  readonly expiry: readonly ["state", "leaseExpiresAt"];
};
// With scope: "argument" every method takes the scope; otherwise none accepts one.
type ScopeArgs<A extends boolean> = A extends true ? { scope: string } : unknown;
type LeaseArgs<A extends boolean> = LeaseIdentity & ScopeArgs<A>;
export type QueueMethodName = "enqueue" | "claim" | "renew" | "complete" | "fail" | "retry" | "cancel" | "get" | "ready" | "stats";
export interface QueueMethods<P, R, A extends boolean = false> {
  enqueue: MutationMethod<{ id: string; payload: P; delayMs?: number; at?: number; replace?: boolean } & ScopeArgs<A>, Job<P, R>>;
  claim: MutationMethod<{ owner: string; leaseMs?: number } & ScopeArgs<A>, Claim<P> | null>;
  renew: MutationMethod<LeaseArgs<A> & { leaseMs?: number }, Claim<P>>;
  complete: MutationMethod<LeaseArgs<A> & { result: R }, Job<P, R>>;
  fail: MutationMethod<LeaseArgs<A> & { error: Json; retry?: boolean; delayMs?: number }, Job<P, R>>;
  retry: MutationMethod<{ id: string; delayMs?: number } & ScopeArgs<A>, Job<P, R>>;
  cancel: MutationMethod<{ id: string } & ScopeArgs<A>, boolean>;
  get: QueryMethod<{ id: string } & ScopeArgs<A>, Job<P, R> | null>;
  ready: QueryMethod<A extends true ? { scope: string } : null, boolean>;
  stats: QueryMethod<A extends true ? { scope: string } : null, QueueStats>;
}
const workerMethods = ["claim", "renew", "complete", "fail", "get", "ready", "stats"] as const;
export type QueueHttp<Prefix extends string, P, R, M extends QueueMethodName, A extends boolean = false> = { readonly [K in M as `${Prefix}.${K}`]: QueueMethods<P, R, A>[K] };
export interface QueueHttpOptions<M extends QueueMethodName> {
  /** Which methods to expose. Defaults to the worker set: claim, renew, complete, fail, get, ready, stats. */
  readonly methods?: readonly M[];
  /** Scope source: a caller argument, a function of the authenticated context, or the default scope. */
  readonly scope?: "argument" | ((ctx: QueryContext) => string);
  readonly access?: Access;
}

export interface Queue<P = Json, R = Json> extends QueueView<P, R>, Component {
  readonly name: string;
  readonly records: Collection<Job<P, R>, [scope: string, id: string], QueueIndexes>;
  /** The same queue restricted to one namespace of the shared collection. */
  scope(name: string): QueueView<P, R>;
  /** Public methods for workers; spread into define({ http }). */
  http<const Prefix extends string, const M extends QueueMethodName = typeof workerMethods[number]>(
    prefix: Prefix, options: QueueHttpOptions<M> & { readonly scope: "argument" }): QueueHttp<Prefix, P, R, M, true>;
  http<const Prefix extends string, const M extends QueueMethodName = typeof workerMethods[number]>(
    prefix: Prefix, options?: QueueHttpOptions<M> & { readonly scope?: (ctx: QueryContext) => string }): QueueHttp<Prefix, P, R, M>;
}

function leaseError(): never {
  return fail("LEASE_LOST", "Job lease is missing, expired, or held by another claim");
}

const fencing = collection<{ last: number }>("$flower.fencing");
const leaseSchema = {
  id: v.string({ min: 1 }), owner: v.string({ min: 1 }), token: v.int({ min: 1 }),
  history: v.optional(v.object({ database: v.string(), incarnation: v.string() })),
};

/** Leased durable work with fencing tokens, retries, delays and renewal, in ordinary records. */
export function queue<P = Json, R = Json>(name: string, options: QueueOptions<P, R> = {}): Queue<P, R> {
  reserved(name, "Queue name");
  const settings = plainObject(options, "Queue options", ["lease", "retry", "payload", "result"]);
  const leaseSettings = plainObject(settings.lease ?? {}, "Lease options", ["defaultMs", "maxMs"]);
  const maxLeaseMs = (leaseSettings.maxMs ?? 300_000) as number;
  integer(maxLeaseMs, "lease.maxMs", 1);
  const defaultLeaseMs = (leaseSettings.defaultMs ?? Math.min(30_000, maxLeaseMs)) as number;
  integer(defaultLeaseMs, "lease.defaultMs", 1);
  if (defaultLeaseMs > maxLeaseMs) throw new RangeError("The default lease exceeds the maximum");
  let policy: Required<QueueRetry> | null = null;
  if (settings.retry !== false) {
    const retry = plainObject(settings.retry ?? {}, "Retry options", ["maxAttempts", "initialDelayMs", "maxDelayMs"]);
    policy = { maxAttempts: (retry.maxAttempts ?? 5) as number, initialDelayMs: (retry.initialDelayMs ?? 1_000) as number, maxDelayMs: (retry.maxDelayMs ?? 60_000) as number };
    integer(policy.maxAttempts, "retry.maxAttempts", 1);
    integer(policy.initialDelayMs, "retry.initialDelayMs", 0);
    integer(policy.maxDelayMs, "retry.maxDelayMs", policy.initialDelayMs);
  }
  const payloadSchema = settings.payload === undefined ? null : adopt(settings.payload as SchemaLike<P>);
  const resultSchema = settings.result === undefined ? null : adopt(settings.result as SchemaLike<R>);
  const records = collection<Job<P, R>>(name)
    .key(v.tuple([v.string(), v.string({ min: 1 })]))
    .index("ready", ["scope", "state", "availableAt"])
    .index("leases", ["scope", "state", "leaseExpiresAt"])
    .index("expiry", ["state", "leaseExpiresAt"]);
  const backoff = (attempts: number) => Math.min(policy!.maxDelayMs, policy!.initialDelayMs * 2 ** Math.min(attempts - 1, 30));

  function effective(job: Job<P, R>, now: number): Job<P, R> {
    if (job.state !== "leased" || now < job.lease!.expiresAt) return job;
    const expiredAt = job.lease!.expiresAt;
    const exhausted = policy !== null && job.attempts >= policy.maxAttempts;
    return {
      ...job, state: exhausted ? "failed" : "pending", lease: null, leaseExpiresAt: null,
      availableAt: exhausted ? null : expiredAt, updatedAt: expiredAt,
      error: { code: "LEASE_EXPIRED", message: "Worker lease expired", at: expiredAt },
    };
  }

  function view(scope: string): QueueView<P, R> {
    if (typeof scope !== "string") throw new TypeError("Queue scope must be a string");
    const key = (id: string): [string, string] => { requireName(id, "Job ID"); return [scope, id]; };
    function held(ctx: MutationContext, identity: LeaseIdentity, now: number): Job<P, R> {
      plainObject(identity, "Lease identity");
      integer(identity.token, "Lease token", 1);
      const job = ctx.get(records, key(identity.id));
      const history = ctx.history();
      if (!job || job.state !== "leased" || job.lease!.owner !== identity.owner || job.lease!.token !== identity.token ||
          now >= job.lease!.expiresAt || canonicalJson(identity.history ?? null) !== canonicalJson(history) ||
          canonicalJson(job.lease!.history ?? null) !== canonicalJson(history)) leaseError();
      return job;
    }
    function claimOf(job: Job<P, R>): Claim<P> {
      return { scope, id: job.id, payload: job.payload, ...job.lease!, attempt: job.attempts };
    }
    function expiredPending(ctx: Context, now: number): Job<P, R> | null {
      for (const row of pages(ctx, records.by("leases"), { prefix: [scope, "leased"], lte: now })) {
        const job = effective(row.value, now);
        if (job.state === "pending") return job;
      }
      return null;
    }
    function oldest(ctx: Context, now: number): Job<P, R> | null {
      let selected = ctx.range(records.by("ready").range({ prefix: [scope, "pending"], lte: now, limit: 1 })).rows[0]?.value ?? null;
      for (const row of pages(ctx, records.by("leases"), { prefix: [scope, "leased"], lte: now })) {
        const job = effective(row.value, now);
        if (job.state !== "pending") continue;
        if (!selected || job.availableAt! < selected.availableAt! ||
            (job.availableAt === selected.availableAt && canonicalJson(key(job.id)) < canonicalJson(key(selected.id)))) selected = job;
      }
      return selected;
    }
    return Object.freeze({
      enqueue(ctx: MutationContext, id: string, payload: P, enqueueOptions: { readonly delayMs?: number; readonly at?: number; readonly replace?: boolean } = {}): Job<P, R> {
        const choice = plainObject(enqueueOptions, "Enqueue options", ["delayMs", "at", "replace"]);
        validated(payloadSchema, payload, "Payload");
        const now = clock(ctx);
        if (choice.delayMs !== undefined && choice.at !== undefined) throw new TypeError("Use delayMs or at, not both");
        if (choice.delayMs !== undefined) integer(choice.delayMs, "delayMs");
        if (choice.at !== undefined) integer(choice.at, "at");
        const availableAt = choice.at !== undefined ? choice.at as number : now + ((choice.delayMs as number | undefined) ?? 0);
        const stored = ctx.get(records, key(id));
        const previous = stored && effective(stored, now);
        if (previous !== null && (choice.replace !== true || previous.state === "pending" || previous.state === "leased")) {
          fail("JOB_EXISTS", `Job ${id} already exists`);
        }
        const job: Job<P, R> = {
          scope, id, payload, state: "pending", availableAt, leaseExpiresAt: null, lease: null,
          attempts: 0, createdAt: now, updatedAt: now, result: null, error: null,
        };
        ctx.set(records, key(id), job);
        return job;
      },
      claim(ctx: MutationContext, owner: string, claimOptions: { readonly leaseMs?: number } = {}): Claim<P> | null {
        requireName(owner, "Lease owner");
        const leaseMs = plainObject(claimOptions, "Claim options", ["leaseMs"]).leaseMs ?? defaultLeaseMs;
        integer(leaseMs, "Lease duration", 1);
        if (leaseMs > maxLeaseMs) fail("LEASE_TOO_LONG", `Leases last at most ${maxLeaseMs} ms`);
        const now = clock(ctx);
        const selected = oldest(ctx, now);
        if (!selected) return null;
        const counter = canonicalJson([name, scope]);
        const token = (ctx.get(fencing, counter)?.last ?? 0) + 1;
        integer(token, "Fencing token", 1);
        ctx.set(fencing, counter, { last: token });
        const history = ctx.history();
        const lease: Lease = { owner, token, expiresAt: now + leaseMs, ...(history === null ? {} : { history }) };
        const job: Job<P, R> = { ...selected, state: "leased", availableAt: null, lease, leaseExpiresAt: lease.expiresAt, attempts: selected.attempts + 1, updatedAt: now };
        ctx.set(records, key(selected.id), job);
        return claimOf(job);
      },
      renew(ctx: MutationContext, identity: LeaseIdentity, renewOptions: { readonly leaseMs?: number } = {}): Claim<P> {
        const leaseMs = plainObject(renewOptions, "Renew options", ["leaseMs"]).leaseMs ?? defaultLeaseMs;
        integer(leaseMs, "Lease duration", 1);
        if (leaseMs > maxLeaseMs) fail("LEASE_TOO_LONG", `Leases last at most ${maxLeaseMs} ms`);
        const now = clock(ctx);
        const job = held(ctx, identity, now);
        const lease = { ...job.lease!, expiresAt: now + leaseMs };
        const renewed: Job<P, R> = { ...job, lease, leaseExpiresAt: lease.expiresAt, updatedAt: now };
        ctx.set(records, key(job.id), renewed);
        return claimOf(renewed);
      },
      complete(ctx: MutationContext, identity: LeaseIdentity, result: R): Job<P, R> {
        validated(resultSchema, result, "Result");
        const now = clock(ctx);
        const job = held(ctx, identity, now);
        const completed: Job<P, R> = { ...job, state: "completed", availableAt: null, lease: null, leaseExpiresAt: null, updatedAt: now, result, error: null };
        ctx.set(records, key(job.id), completed);
        return completed;
      },
      fail(ctx: MutationContext, identity: LeaseIdentity, error: Json, failOptions: { readonly retry?: boolean; readonly delayMs?: number } = {}): Job<P, R> {
        const choice = plainObject(failOptions, "Fail options", ["retry", "delayMs"]);
        canonicalJson(error);
        if (choice.delayMs !== undefined) integer(choice.delayMs, "delayMs");
        const now = clock(ctx);
        const job = held(ctx, identity, now);
        const final = policy === null || choice.retry === false || job.attempts >= policy.maxAttempts;
        const failed: Job<P, R> = {
          ...job, state: final ? "failed" : "pending", lease: null, leaseExpiresAt: null, updatedAt: now, error,
          availableAt: final ? null : now + ((choice.delayMs as number | undefined) ?? backoff(job.attempts)),
        };
        ctx.set(records, key(job.id), failed);
        return failed;
      },
      retry(ctx: MutationContext, id: string, retryOptions: { readonly delayMs?: number } = {}): Job<P, R> {
        const delayMs = plainObject(retryOptions, "Retry options", ["delayMs"]).delayMs ?? 0;
        integer(delayMs, "delayMs");
        const now = clock(ctx);
        const stored = ctx.get(records, key(id));
        const job = stored && effective(stored, now);
        if (!job || job.state !== "failed") fail("JOB_NOT_FAILED", "Only failed jobs can be retried");
        const pending: Job<P, R> = { ...job, state: "pending", availableAt: now + delayMs, attempts: 0, updatedAt: now, result: null };
        ctx.set(records, key(id), pending);
        return pending;
      },
      cancel(ctx: MutationContext, id: string): boolean {
        if (ctx.get(records, key(id)) === null) return false;
        ctx.delete(records, key(id));
        return true;
      },
      get(ctx: Context, id: string): Job<P, R> | null {
        const job = ctx.get(records, key(id));
        return job && effective(job, clock(ctx));
      },
      scan(ctx: Context): Job<P, R>[] {
        const now = clock(ctx);
        return Array.from(pages(ctx, records.by("ready"), { prefix: [scope] }), (row) => effective(row.value, now))
          .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      },
      ready(ctx: Context): boolean {
        const now = clock(ctx);
        return ctx.range(records.by("ready").range({ prefix: [scope, "pending"], lte: now, limit: 1 })).rows.length > 0 || expiredPending(ctx, now) !== null;
      },
      stats(ctx: Context): QueueStats {
        const now = clock(ctx);
        const found = oldest(ctx, now);
        const delayed = ctx.range(records.by("ready").range({ prefix: [scope, "pending"], gt: now, limit: 1 })).rows[0]?.value.availableAt ?? null;
        const running = ctx.range(records.by("leases").range({ prefix: [scope, "leased"], gt: now, limit: 1 })).rows[0]?.value.leaseExpiresAt ?? null;
        const upcoming = [delayed, running].filter((time): time is number => time !== null);
        return { ready: found !== null, oldestReadyAt: found?.availableAt ?? null, nextAvailableAt: upcoming.length ? Math.min(...upcoming) : null };
      },
    });
  }

  const reclaim = task(`queue:${name}`, {
    due: (ctx) => ctx.range(records.by("expiry").range({ prefix: ["leased"], limit: 1 })).rows[0]?.value.leaseExpiresAt ?? null,
    run(ctx) {
      const now = clock(ctx);
      const rows = ctx.range(records.by("expiry").range({ prefix: ["leased"], lte: now, limit: 64 })).rows;
      for (const row of rows) ctx.set(records, row.key, effective(row.value, now));
      return { reclaimed: rows.length };
    },
  });

  const defaultView = view("");
  const generated = new Map<string, { signature: string; access: unknown; scope: unknown; methods: Readonly<Record<string, MutationMethod<any, any> | QueryMethod<any, any>>> }>();
  function http(prefix: string, httpOptions: QueueHttpOptions<QueueMethodName> = {}) {
    requireName(prefix, "HTTP prefix");
    const choice = plainObject(httpOptions, "Queue HTTP options", ["methods", "scope", "access"]);
    const selected = (choice.methods ?? workerMethods) as readonly QueueMethodName[];
    const scopeSource = choice.scope as QueueHttpOptions<QueueMethodName>["scope"];
    if (scopeSource !== undefined && scopeSource !== "argument" && typeof scopeSource !== "function") throw new TypeError("scope must be \"argument\" or a function");
    const signature = canonicalJson([[...selected].sort(), scopeSource === undefined ? null : typeof scopeSource]);
    const cached = generated.get(prefix);
    if (cached) {
      if (cached.signature !== signature || cached.access !== choice.access || cached.scope !== scopeSource) {
        throw new TypeError(`Queue methods for ${JSON.stringify(prefix)} were already generated differently`);
      }
      return cached.methods;
    }
    const access = choice.access as Access | undefined;
    const spec = (shape: Record<string, SchemaLike<any> | Optional<any>>): { args: Schema<any>; access?: Access } => ({
      args: v.object(scopeSource === "argument" ? { ...shape, scope: v.string() } : shape) as Schema<any>,
      ...(access === undefined ? {} : { access }),
    });
    const nothing = { args: (scopeSource === "argument" ? v.object({ scope: v.string() }) : v.nullable(v.object({}))) as Schema<any>, ...(access === undefined ? {} : { access }) };
    const target = (ctx: QueryContext, args: any) =>
      view(scopeSource === "argument" ? args.scope : typeof scopeSource === "function" ? scopeSource(ctx) : "");
    const pick = (args: any, ...keys: string[]) => Object.fromEntries(keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
    const identity = (args: any): LeaseIdentity => pick(args, "id", "owner", "token", "history") as unknown as LeaseIdentity;
    const factories: Record<QueueMethodName, () => MutationMethod<any, any> | QueryMethod<any, any>> = {
      enqueue: () => mutation(`${prefix}.enqueue`, spec({ id: v.string({ min: 1 }), payload: v.json(), delayMs: v.optional(v.int({ min: 0 })), at: v.optional(v.int({ min: 0 })), replace: v.optional(v.boolean()) }),
        (ctx, args: any) => target(ctx, args).enqueue(ctx, args.id, args.payload, pick(args, "delayMs", "at", "replace"))),
      claim: () => mutation(`${prefix}.claim`, spec({ owner: v.string({ min: 1 }), leaseMs: v.optional(v.int({ min: 1 })) }),
        (ctx, args: any) => target(ctx, args).claim(ctx, args.owner, pick(args, "leaseMs"))),
      renew: () => mutation(`${prefix}.renew`, spec({ ...leaseSchema, leaseMs: v.optional(v.int({ min: 1 })) }),
        (ctx, args: any) => target(ctx, args).renew(ctx, identity(args), pick(args, "leaseMs"))),
      complete: () => mutation(`${prefix}.complete`, spec({ ...leaseSchema, result: v.json() }),
        (ctx, args: any) => target(ctx, args).complete(ctx, identity(args), args.result)),
      fail: () => mutation(`${prefix}.fail`, spec({ ...leaseSchema, error: v.json(), retry: v.optional(v.boolean()), delayMs: v.optional(v.int({ min: 0 })) }),
        (ctx, args: any) => target(ctx, args).fail(ctx, identity(args), args.error, pick(args, "retry", "delayMs"))),
      retry: () => mutation(`${prefix}.retry`, spec({ id: v.string({ min: 1 }), delayMs: v.optional(v.int({ min: 0 })) }),
        (ctx, args: any) => target(ctx, args).retry(ctx, args.id, pick(args, "delayMs"))),
      cancel: () => mutation(`${prefix}.cancel`, spec({ id: v.string({ min: 1 }) }),
        (ctx, args: any) => target(ctx, args).cancel(ctx, args.id)),
      get: () => query(`${prefix}.get`, spec({ id: v.string({ min: 1 }) }),
        (ctx, args: any) => target(ctx, args).get(ctx, args.id)),
      ready: () => query(`${prefix}.ready`, nothing, (ctx, args: any) => target(ctx, args).ready(ctx)),
      stats: () => query(`${prefix}.stats`, nothing, (ctx, args: any) => target(ctx, args).stats(ctx)),
    };
    const methods: Record<string, MutationMethod<any, any> | QueryMethod<any, any>> = {};
    for (const method of selected) {
      if (!Object.hasOwn(factories, method)) throw new TypeError(`Unknown queue method ${JSON.stringify(method)}`);
      methods[`${prefix}.${method}`] = factories[method]();
    }
    generated.set(prefix, { signature, access, scope: scopeSource, methods: Object.freeze(methods) });
    return methods;
  }

  return Object.freeze({
    ...component({ collections: [records, fencing], tasks: [reclaim] }),
    ...defaultView,
    name,
    records,
    scope: view,
    http,
  }) as unknown as Queue<P, R>;
}

