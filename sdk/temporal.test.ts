import assert from "node:assert/strict";
import { test } from "node:test";
import { define, FlowerError, mutation, query, v } from "./index.ts";
import type { Json, MutationContext } from "./index.ts";
import { expiringCollection, queue } from "./temporal.ts";
import type { Job } from "./temporal.ts";
import { testDatabase } from "./testing.ts";

function rejected(run: () => unknown): FlowerError {
  try { run(); } catch (error) { if (error instanceof FlowerError) return error; throw error; }
  assert.fail("expected a FlowerError");
}
const lost = { code: "LEASE_LOST", message: "Job lease is missing, expired, or held by another claim" };
const brief = ({ state, availableAt, attempts, lease, error }: Job<any, any>) => ({ state, availableAt, attempts, leased: lease !== null, error });

const jobs = queue<{ n: number }, { ok: boolean }>("jobs", {
  lease: { defaultMs: 100, maxMs: 1_000 },
  retry: { maxAttempts: 4, initialDelayMs: 10, maxDelayMs: 25 },
  payload: v.object({ n: v.int() }),
  result: v.object({ ok: v.boolean() }),
});
const every = ["enqueue", "claim", "renew", "complete", "fail", "retry", "cancel", "get", "ready", "stats"] as const;
const enqueueAt = mutation("enqueueAt", { args: v.object({ id: v.string(), n: v.int(), at: v.int() }) }, (ctx, input) => jobs.enqueue(ctx, input.id, { n: input.n }, { at: input.at }));
const replace = mutation("replace", { args: v.object({ id: v.string(), n: v.int() }) }, (ctx, input) => jobs.enqueue(ctx, input.id, { n: input.n }, { replace: true }));
const scan = query("scan", { args: v.nullable(v.string()) }, (ctx, scope) => (scope === null ? jobs : jobs.scope(scope)).scan(ctx).map((job) => [job.scope, job.id, job.state]));
const stored = query("stored", { args: v.tuple([v.string(), v.string()]) }, (ctx, key) => ctx.get(jobs.records, key));
const app = define({
  uses: [jobs],
  http: { ...jobs.http("jobs", { methods: every }), ...jobs.http("tenant", { methods: every, scope: "argument" }), enqueueAt, replace, scan, stored },
});

test("enqueue, claim, renew and complete a job under a fenced lease", async () => {
  const db = await testDatabase(app);
  assert.deepEqual(db.mutate("jobs.enqueue", { id: "one", payload: { n: 1 } }), {
    scope: "", id: "one", payload: { n: 1 }, state: "pending", availableAt: 1_000_000, leaseExpiresAt: null, lease: null,
    attempts: 0, createdAt: 1_000_000, updatedAt: 1_000_000, result: null, error: null,
  });
  const claim = db.mutate("jobs.claim", { owner: "w1" })!;
  assert.deepEqual(claim, { scope: "", id: "one", payload: { n: 1 }, owner: "w1", token: 1, expiresAt: 1_000_100, attempt: 1 });
  assert.equal(db.mutate("jobs.claim", { owner: "w2" }), null);
  const leased = db.query("jobs.get", { id: "one" })!;
  assert.deepEqual([leased.state, leased.leaseExpiresAt, leased.lease, leased.attempts], ["leased", 1_000_100, { owner: "w1", token: 1, expiresAt: 1_000_100 }, 1]);
  db.now += 50;
  const renewed = db.mutate("jobs.renew", { id: "one", owner: "w1", token: 1, leaseMs: 500 });
  assert.deepEqual([renewed.token, renewed.expiresAt, renewed.attempt], [1, 1_000_550, 1]);
  assert.deepEqual(rejected(() => db.mutate("jobs.renew", { id: "one", owner: "w2", token: 1 })).failure, lost);
  assert.deepEqual(rejected(() => db.mutate("jobs.complete", { id: "one", owner: "w1", token: 2, result: { ok: true } })).failure, lost);
  const done = db.mutate("jobs.complete", { id: "one", owner: "w1", token: 1, result: { ok: true } });
  assert.deepEqual([done.state, done.result, done.lease, done.leaseExpiresAt, done.availableAt, done.updatedAt], ["completed", { ok: true }, null, null, null, 1_000_050]);
  assert.deepEqual(rejected(() => db.mutate("jobs.complete", { id: "one", owner: "w1", token: 1, result: { ok: true } })).failure, lost);
  assert.equal(db.query("jobs.get", { id: "one" })!.state, "completed");
  assert.equal(db.query("jobs.get", { id: "missing" }), null);
});

test("claims take the job that has waited longest; delayMs and at hold jobs back", async () => {
  const db = await testDatabase(app);
  db.mutate("jobs.enqueue", { id: "a", payload: { n: 1 }, delayMs: 50 });
  db.mutate("jobs.enqueue", { id: "b", payload: { n: 2 } });
  db.mutate("enqueueAt", { id: "c", n: 3, at: 1_000_010 });
  db.mutate("enqueueAt", { id: "old", n: 0, at: 999_000 });
  assert.equal(db.query("jobs.ready"), true);
  assert.deepEqual(db.query("jobs.stats"), { ready: true, oldestReadyAt: 999_000, nextAvailableAt: 1_000_010 });
  const claim = () => db.mutate("jobs.claim", { owner: "w" })?.id ?? null;
  assert.deepEqual([claim(), claim(), claim()], ["old", "b", null]);
  assert.equal(db.query("jobs.ready"), false);
  assert.deepEqual(db.query("jobs.stats"), { ready: false, oldestReadyAt: null, nextAvailableAt: 1_000_010 });
  db.now += 10;
  assert.equal(claim(), "c");
  db.now += 40;
  assert.equal(claim(), "a");
  assert.deepEqual(db.query("jobs.stats"), { ready: false, oldestReadyAt: null, nextAvailableAt: 1_000_100 });
  db.now += 51;
  db.mutate("jobs.enqueue", { id: "fresh", payload: { n: 4 } });
  assert.deepEqual([claim(), claim()], ["b", "old"], "work whose lease expired first precedes newer work");
  assert.deepEqual([claim(), claim()], ["fresh", null]);
});

test("fail() requeues with capped exponential backoff until attempts run out", async () => {
  const db = await testDatabase(app);
  db.mutate("jobs.enqueue", { id: "f", payload: { n: 1 } });
  const cycle = (error: Json, options: { retry?: boolean; delayMs?: number } = {}) => {
    const claim = db.mutate("jobs.claim", { owner: "w" })!;
    return brief(db.mutate("jobs.fail", { id: claim.id, owner: "w", token: claim.token, error, ...options }));
  };
  assert.deepEqual(cycle({ reason: 1 }), { state: "pending", availableAt: 1_000_010, attempts: 1, leased: false, error: { reason: 1 } });
  assert.equal(db.mutate("jobs.claim", { owner: "w" }), null);
  db.now += 10;
  assert.deepEqual(cycle("two").availableAt, 1_000_030);
  db.now += 20;
  assert.deepEqual(cycle("three").availableAt, 1_000_055, "the doubled delay is capped by maxDelayMs");
  db.now += 25;
  assert.deepEqual(cycle("four"), { state: "failed", availableAt: null, attempts: 4, leased: false, error: "four" });
  assert.equal(db.mutate("jobs.claim", { owner: "w" }), null);
  db.mutate("jobs.enqueue", { id: "g", payload: { n: 2 } });
  assert.equal(cycle("custom", { delayMs: 5 }).availableAt, db.now + 5);
  db.now += 5;
  assert.deepEqual(cycle("final", { retry: false }), { state: "failed", availableAt: null, attempts: 2, leased: false, error: "final" });
});

test("retry: false makes fail() final while expired leases still requeue", async () => {
  const once = queue("once", { retry: false });
  const db = await testDatabase(define({ uses: [once], http: once.http("once", { methods: ["enqueue", "claim", "fail", "get"] }) }));
  db.mutate("once.enqueue", { id: "x", payload: null });
  const claim = db.mutate("once.claim", { owner: "w" })!;
  assert.equal(claim.expiresAt, 1_030_000, "the default lease is 30 seconds");
  assert.equal(db.mutate("once.fail", { id: "x", owner: "w", token: claim.token, error: null }).state, "failed");
  db.mutate("once.enqueue", { id: "y", payload: null });
  db.mutate("once.claim", { owner: "w" });
  db.now += 30_000;
  assert.equal(db.query("once.get", { id: "y" })!.state, "pending");
});

test("lease expiry is visible before maintenance, counts an attempt and exhausts the budget", async () => {
  const db = await testDatabase(app);
  db.mutate("jobs.enqueue", { id: "slow", payload: { n: 1 } });
  const first = db.mutate("jobs.claim", { owner: "w", leaseMs: 10 })!;
  db.now += 10;
  const expired = db.query("jobs.get", { id: "slow" })!;
  assert.deepEqual([expired.state, expired.availableAt, expired.lease, expired.leaseExpiresAt, expired.updatedAt], ["pending", 1_000_010, null, null, 1_000_010]);
  assert.deepEqual(expired.error, { code: "LEASE_EXPIRED", message: "Worker lease expired", at: 1_000_010 });
  assert.equal(db.query("stored", ["", "slow"])!.state, "leased", "storage changes only when maintenance reclaims it");
  assert.deepEqual([db.query("jobs.ready"), db.query("jobs.stats").oldestReadyAt], [true, 1_000_010]);
  assert.deepEqual(rejected(() => db.mutate("jobs.complete", { id: "slow", owner: "w", token: first.token, result: { ok: true } })).failure, lost);
  assert.deepEqual(rejected(() => db.mutate("jobs.renew", { id: "slow", owner: "w", token: first.token })).failure, lost);
  const second = db.mutate("jobs.claim", { owner: "w" })!;
  assert.deepEqual([second.attempt, second.token], [2, 2]);
  assert.equal(db.advance(100), 1);
  assert.equal(db.query("stored", ["", "slow"])!.state, "pending");
  for (const attempt of [3, 4]) {
    assert.equal(db.mutate("jobs.claim", { owner: "w", leaseMs: 10 })!.attempt, attempt);
    assert.equal(db.advance(10), 1);
  }
  assert.deepEqual(brief(db.query("stored", ["", "slow"])!), { state: "failed", availableAt: null, attempts: 4, leased: false, error: { code: "LEASE_EXPIRED", message: "Worker lease expired", at: 1_000_130 } });
  assert.equal(db.mutate("jobs.claim", { owner: "w" }), null);
  assert.equal(db.maintain(), 0);
});

test("fencing tokens count per queue and scope, and stale leases stay fenced out", async () => {
  const db = await testDatabase(app);
  db.mutate("tenant.enqueue", { scope: "a", id: "x", payload: { n: 1 } });
  db.mutate("tenant.enqueue", { scope: "b", id: "x", payload: { n: 2 } });
  db.mutate("jobs.enqueue", { id: "x", payload: { n: 3 } });
  const a1 = db.mutate("tenant.claim", { scope: "a", owner: "w" })!;
  const b1 = db.mutate("tenant.claim", { scope: "b", owner: "w" })!;
  const root = db.mutate("jobs.claim", { owner: "w" })!;
  assert.deepEqual([a1, b1, root].map(({ scope, token, payload }) => [scope, token, payload.n]), [["a", 1, 1], ["b", 1, 2], ["", 1, 3]]);
  assert.deepEqual(db.data['source:["$flower.fencing","[\\"jobs\\",\\"a\\"]"]'], { last: 1 });
  db.now += 100;
  const a2 = db.mutate("tenant.claim", { scope: "a", owner: "w" })!;
  assert.equal(a2.token, 2);
  for (const call of [
    () => db.mutate("tenant.complete", { scope: "a", id: "x", owner: "w", token: 1, result: { ok: true } }),
    () => db.mutate("tenant.fail", { scope: "a", id: "x", owner: "w", token: 1, error: "stale" }),
    () => db.mutate("tenant.renew", { scope: "a", id: "x", owner: "w", token: 1 }),
    () => db.mutate("tenant.complete", { scope: "c", id: "x", owner: "w", token: 2, result: { ok: true } }),
  ]) assert.deepEqual(rejected(call).failure, lost);
  assert.equal(db.mutate("tenant.complete", { scope: "a", id: "x", owner: "w", token: 2, result: { ok: true } }).state, "completed");
  const left = queue("left"), right = queue("right");
  const pair = await testDatabase(define({ uses: [left, right], http: { ...left.http("left", { methods: ["enqueue", "claim"] }), ...right.http("right", { methods: ["enqueue", "claim"] }) } }));
  pair.mutate("left.enqueue", { id: "x", payload: null });
  pair.mutate("right.enqueue", { id: "x", payload: null });
  assert.deepEqual([pair.mutate("left.claim", { owner: "w" })!.token, pair.mutate("right.claim", { owner: "w" })!.token], [1, 1]);
});

test("scopes isolate identical IDs in one shared collection", async () => {
  const db = await testDatabase(app);
  db.mutate("tenant.enqueue", { scope: "a", id: "one", payload: { n: 1 } });
  db.mutate("tenant.enqueue", { scope: "a", id: "two", payload: { n: 2 } });
  db.mutate("tenant.enqueue", { scope: "b", id: "one", payload: { n: 3 } });
  db.mutate("jobs.enqueue", { id: '["a","one"]', payload: { n: 4 } });
  assert.deepEqual(db.query("scan", "a"), [["a", "one", "pending"], ["a", "two", "pending"]]);
  assert.deepEqual(db.query("scan", "b"), [["b", "one", "pending"]]);
  assert.deepEqual(db.query("scan", null), [["", '["a","one"]', "pending"]], "canonical-looking IDs cannot reach another scope");
  assert.equal(db.mutate("tenant.claim", { scope: "b", owner: "w" })!.payload.n, 3);
  assert.deepEqual([db.query("tenant.ready", { scope: "b" }), db.query("tenant.ready", { scope: "a" }), db.query("tenant.ready", { scope: "z" })], [false, true, false]);
  assert.equal(db.query("tenant.get", { scope: "a", id: "two" })!.payload.n, 2);
  assert.equal(db.query("tenant.get", { scope: "b", id: "two" }), null);
  assert.equal(db.query("stored", ["a", "one"])!.scope, "a");
});

test("enqueue refuses live duplicates, and replace overwrites only finished jobs", async () => {
  const db = await testDatabase(app);
  db.mutate("jobs.enqueue", { id: "d", payload: { n: 1 } });
  const exists = { code: "JOB_EXISTS", message: "Job d already exists" };
  assert.deepEqual(rejected(() => db.mutate("jobs.enqueue", { id: "d", payload: { n: 2 } })).failure, exists);
  assert.deepEqual(rejected(() => db.mutate("replace", { id: "d", n: 2 })).failure, exists);
  const claim = db.mutate("jobs.claim", { owner: "w" })!;
  assert.deepEqual(rejected(() => db.mutate("jobs.enqueue", { id: "d", payload: { n: 2 }, replace: true })).failure, exists);
  db.mutate("jobs.complete", { id: "d", owner: "w", token: claim.token, result: { ok: true } });
  db.now += 1;
  const replaced = db.mutate("replace", { id: "d", n: 2 });
  assert.deepEqual([replaced.state, replaced.payload, replaced.attempts, replaced.result, replaced.createdAt], ["pending", { n: 2 }, 0, null, 1_000_001]);
  for (let attempt = 0; attempt < 4; attempt++) { db.mutate("jobs.claim", { owner: "w", leaseMs: 1 }); db.now += 1_000; }
  assert.equal(db.query("jobs.get", { id: "d" })!.state, "failed");
  assert.equal(db.query("stored", ["", "d"])!.state, "leased");
  assert.equal(db.mutate("replace", { id: "d", n: 3 }).state, "pending", "a job whose expired lease exhausted it counts as failed");
});

test("retry() requeues failed jobs with a fresh budget and cancel() deletes jobs", async () => {
  const db = await testDatabase(app);
  db.mutate("jobs.enqueue", { id: "r", payload: { n: 1 } });
  const claim = db.mutate("jobs.claim", { owner: "w" })!;
  db.mutate("jobs.fail", { id: "r", owner: "w", token: claim.token, error: "boom", retry: false });
  const retried = db.mutate("jobs.retry", { id: "r", delayMs: 5 });
  assert.deepEqual([retried.state, retried.attempts, retried.availableAt, retried.result], ["pending", 0, 1_000_005, null]);
  const notFailed = { code: "JOB_NOT_FAILED", message: "Only failed jobs can be retried" };
  assert.deepEqual(rejected(() => db.mutate("jobs.retry", { id: "r" })).failure, notFailed);
  assert.deepEqual(rejected(() => db.mutate("jobs.retry", { id: "missing" })).failure, notFailed);
  db.now += 5;
  const again = db.mutate("jobs.claim", { owner: "w" })!;
  assert.equal(again.attempt, 1);
  assert.equal(db.mutate("jobs.cancel", { id: "r" }), true);
  assert.equal(db.mutate("jobs.cancel", { id: "r" }), false);
  assert.equal(db.query("jobs.get", { id: "r" }), null);
  assert.deepEqual(rejected(() => db.mutate("jobs.complete", { id: "r", owner: "w", token: again.token, result: { ok: true } })).failure, lost);
});

test("leases are bounded and payloads and results follow their schemas", async () => {
  const db = await testDatabase(app);
  db.mutate("jobs.enqueue", { id: "x", payload: { n: 1 } });
  const tooLong = { code: "LEASE_TOO_LONG", message: "Leases last at most 1000 ms" };
  assert.deepEqual(rejected(() => db.mutate("jobs.claim", { owner: "w", leaseMs: 1_001 })).failure, tooLong);
  assert.equal(rejected(() => db.mutate("jobs.claim", { owner: "w", leaseMs: 0 })).failure!.code, "INVALID_ARGUMENT");
  assert.equal(rejected(() => db.mutate("jobs.claim", { owner: "" })).failure!.code, "INVALID_ARGUMENT");
  const claim = db.mutate("jobs.claim", { owner: "w", leaseMs: 1_000 })!;
  assert.deepEqual(rejected(() => db.mutate("jobs.renew", { id: "x", owner: "w", token: claim.token, leaseMs: 1_001 })).failure, tooLong);
  assert.equal(rejected(() => db.mutate("jobs.renew", { id: "x", owner: "w", token: 0 })).failure!.code, "INVALID_ARGUMENT");
  assert.deepEqual(rejected(() => db.mutate("jobs.complete", { id: "x", owner: "w", token: claim.token, result: { ok: 1 } as never })).failure,
    { code: "INVALID_ARGUMENT", message: "Result ok: must be a boolean", details: { path: ["ok"] } });
  assert.deepEqual(rejected(() => db.mutate("jobs.enqueue", { id: "y", payload: { n: "1" } as never })).failure,
    { code: "INVALID_ARGUMENT", message: "Payload n: must be a finite number", details: { path: ["n"] } });
  const typed = () => {
    // @ts-expect-error payloads are typed by the queue
    db.mutate("jobs.enqueue", { id: "y", payload: { n: "1" } });
    // @ts-expect-error results are typed by the queue
    db.mutate("jobs.complete", { id: "x", owner: "w", token: 1, result: { ok: "yes" } });
  };
  void typed;
});

test("http() generates worker methods with argument or context scopes and caches them per prefix", async () => {
  const gen = queue("gen");
  assert.deepEqual(Object.keys(gen.http("w")).sort(), ["w.claim", "w.complete", "w.fail", "w.get", "w.ready", "w.renew", "w.stats"]);
  assert.equal(gen.http("w"), gen.http("w"));
  assert.throws(() => gen.http("w", { methods: ["claim"] }), /already generated differently/);
  assert.throws(() => gen.http("w", { access: "authenticated" }), /already generated differently/);
  const tenantOf = () => "a";
  assert.equal(gen.http("s", { scope: tenantOf }), gen.http("s", { scope: tenantOf }));
  assert.throws(() => gen.http("s", { scope: () => "b" }), /already generated differently/);
  assert.deepEqual(Object.keys(gen.http("admin", { methods: ["enqueue", "retry", "cancel"] })).sort(), ["admin.cancel", "admin.enqueue", "admin.retry"]);
  assert.throws(() => gen.http("bad", { methods: ["drop" as never] }), /Unknown queue method "drop"/);
  assert.throws(() => gen.http("bad", { scope: "tenant" as never }), /scope must be/);
  assert.throws(() => gen.http(""), /nonempty/);
  const kinds = define({ uses: [gen], http: gen.http("w") }).http;
  assert.deepEqual(Object.fromEntries(Object.entries(kinds).map(([alias, entry]) => [alias, entry.kind])), {
    "w.claim": "mutation", "w.renew": "mutation", "w.complete": "mutation", "w.fail": "mutation", "w.get": "query", "w.ready": "query", "w.stats": "query",
  });
  const db = await testDatabase(app);
  assert.deepEqual(rejected(() => db.mutate("tenant.claim", { owner: "w" } as never)).failure, { code: "INVALID_ARGUMENT", message: 'is missing "scope"', details: { path: [] } });
  assert.equal(db.query("jobs.ready", null), false);
  assert.equal(rejected(() => db.query("jobs.ready", { scope: "a" } as never)).failure!.code, "INVALID_ARGUMENT");

  const tenants = queue("tenants");
  const byPrincipal = define({
    uses: [tenants],
    auth: { authenticate: (_ctx, credentials) => typeof credentials === "string" ? { subject: credentials, tenant: credentials } : null },
    http: {
      ...tenants.http("t", { methods: ["enqueue", "claim", "get"], scope: (ctx) => ctx.principal()!.tenant! }),
      ...tenants.http("pub", { methods: ["stats"], access: "public", scope: () => "acme" }),
    },
  });
  const auth = await testDatabase(byPrincipal);
  assert.equal(auth.mutate("t.enqueue", { id: "x", payload: 1 }, { credentials: "acme" }).scope, "acme");
  assert.equal(auth.query("t.get", { id: "x" }, { credentials: "other" }), null);
  assert.equal(auth.mutate("t.claim", { owner: "w" }, { credentials: "other" }), null);
  assert.equal(auth.mutate("t.claim", { owner: "w" }, { credentials: "acme" })!.scope, "acme");
  assert.equal(rejected(() => auth.mutate("t.claim", { owner: "w" })).failure!.code, "UNAUTHENTICATED");
  assert.deepEqual(auth.query("pub.stats"), { ready: false, oldestReadyAt: null, nextAvailableAt: 1_030_000 });
});

test("lease identities are fenced to the history that issued them", async () => {
  const db = await testDatabase(app);
  const setHistory = (history: { database: string; incarnation: string }) => {
    (db as unknown as { stores: Map<string, { data: Record<string, Json> }> }).stores.get("")!.data["$flower.retention"] = history;
  };
  const original = { database: "a".repeat(32), incarnation: "b".repeat(32) };
  const restored = { ...original, incarnation: "c".repeat(32) };
  setHistory(original);
  db.mutate("jobs.enqueue", { id: "h", payload: { n: 1 } });
  const old = db.mutate("jobs.claim", { owner: "w" })!;
  assert.deepEqual(old.history, original);
  setHistory(restored);
  const complete = (lease: typeof old, history = lease.history) =>
    db.mutate("jobs.complete", { id: lease.id, owner: lease.owner, token: lease.token, ...(history ? { history } : {}), result: { ok: true } });
  assert.deepEqual(rejected(() => complete(old)).failure, lost);
  assert.deepEqual(rejected(() => complete(old, restored)).failure, lost, "the claim still belongs to the old history");
  db.now = old.expiresAt;
  const current = db.mutate("jobs.claim", { owner: "w" })!;
  assert.deepEqual(current.history, restored);
  assert.deepEqual(rejected(() => complete(current, original)).failure, lost);
  assert.equal(complete(current).state, "completed");
});

test("the reclaim task pages through many expired leases", async () => {
  const bulk = queue<number>("bulk", { lease: { defaultMs: 1, maxMs: 10 } });
  const fill = mutation("fill", { args: v.int() }, (ctx, count) => { for (let i = 0; i < count; i++) bulk.enqueue(ctx, `k${i}`, i); return null; });
  const grab = mutation("grab", { args: v.int() }, (ctx, count) => { for (let i = 0; i < count; i++) bulk.claim(ctx, "w"); return null; });
  const states = query("states", (ctx) => bulk.scan(ctx).map((job) => job.state));
  const raw = query("raw", (ctx) => ctx.scan(bulk.records).filter((row) => row.value.state === "leased").length);
  const db = await testDatabase(define({ uses: [bulk], http: { fill, grab, states, raw } }));
  db.mutate("fill", 130);
  db.mutate("grab", 130);
  assert.equal(db.query("raw"), 130);
  assert.equal(db.advance(1), 3);
  assert.equal(db.query("raw"), 0);
  const all = db.query("states");
  assert.deepEqual([all.length, new Set(all).size, all[0]], [130, 1, "pending"]);
});

test("queue() and its methods validate configuration and inputs", () => {
  for (const name of ["", "$flower.jobs"]) assert.throws(() => queue(name), TypeError);
  for (const options of [null, [], { extra: 1 }, { lease: { defaultMs: 0 } }, { lease: { maxMs: 1.5 } }, { lease: { maxMs: "10" } }, { lease: { other: 1 } },
    { retry: { maxAttempts: 0 } }, { retry: { initialDelayMs: -1 } }, { retry: { initialDelayMs: 10, maxDelayMs: 5 } }, { retry: true }, { payload: 1 }]) {
    assert.throws(() => queue("q", options as never), TypeError, JSON.stringify(options));
  }
  assert.throws(() => queue("q", { lease: { defaultMs: 11, maxMs: 10 } }), RangeError);
  const lease = { defaultMs: 5, maxMs: 10 };
  const snap = queue("snap", { lease });
  lease.maxMs = 500;
  assert.throws(() => snap.claim({} as MutationContext, "w", { leaseMs: 11 }), { code: "LEASE_TOO_LONG" });
  assert.throws(() => snap.claim({} as MutationContext, ""), /nonempty/);
  assert.throws(() => snap.claim({} as MutationContext, "w", { leaseMs: 1, other: 1 } as never), /does not accept "other"/);
  const clock = { now: () => 0, clock: () => 0, changesAt: () => {} } as unknown as MutationContext;
  assert.throws(() => snap.enqueue(clock, "x", undefined as never), TypeError);
  assert.throws(() => snap.enqueue(clock, "x", null, { delayMs: 1, at: 1 }), /delayMs or at, not both/);
  assert.throws(() => snap.enqueue(clock, "x", null, { delayMs: -1 }), TypeError);
  assert.throws(() => snap.scope(1 as never), /Queue scope must be a string/);
  assert.equal(snap.name, "snap");
  assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.scope("x")));
  assert.deepEqual(JSON.parse(JSON.stringify(snap.records.indexes)), {
    ready: ["scope", "state", "availableAt"], leases: ["scope", "state", "leaseExpiresAt"], expiry: ["state", "leaseExpiresAt"],
  });
});

// ---- Expiring collections

const cache = expiringCollection<string>("cache", { expiration: { afterUpdateMs: 20 }, value: v.string({ max: 10 }) });
const setCache = mutation("setCache", { args: v.object({ key: v.string(), value: v.string(), expiration: v.optional(v.json()) }) }, (ctx, input) =>
  cache.set(ctx, input.key, input.value, input.expiration as never));
const readCache = query("readCache", { args: v.string() }, (ctx, key) => ({ value: cache.get(ctx, key), entry: cache.entry(ctx, key) }));
const listCache = query("listCache", (ctx) => cache.scan(ctx));
const dropCache = mutation("dropCache", { args: v.string() }, (ctx, key) => { cache.delete(ctx, key); return null; });
const storedCache = query("storedCache", { args: v.string() }, (ctx, key) => ctx.get(cache.records, key));
const cacheApp = define({ uses: [cache], http: { setCache, readCache, listCache, dropCache, storedCache } });

test("expired entries vanish from reads at the deadline and the sweep task reclaims them", async () => {
  const db = await testDatabase(cacheApp);
  assert.deepEqual(db.mutate("setCache", { key: "one", value: "v", expiration: { at: 1_000_010 } }),
    { value: "v", createdAt: 1_000_000, updatedAt: 1_000_000, expiresAt: 1_000_010 });
  db.mutate("setCache", { key: "keep", value: "k", expiration: null });
  db.now += 9;
  assert.deepEqual(db.query("readCache", "one"), { value: "v", entry: { value: "v", createdAt: 1_000_000, updatedAt: 1_000_000, expiresAt: 1_000_010 } });
  db.now += 1;
  assert.deepEqual(db.query("readCache", "one"), { value: null, entry: null });
  assert.deepEqual(db.query("listCache"), [{ key: "keep", value: "k" }]);
  assert.notEqual(db.query("storedCache", "one"), null);
  assert.equal(db.maintain(), 1);
  assert.equal(db.query("storedCache", "one"), null);
  assert.equal(db.maintain(), 0);
  db.mutate("dropCache", "keep");
  assert.deepEqual(db.query("listCache"), []);
});

test("creation and update deadlines diverge on updates, and recreation resets creation", async () => {
  const db = await testDatabase(cacheApp);
  db.mutate("setCache", { key: "created", value: "first", expiration: { afterCreationMs: 10 } });
  db.mutate("setCache", { key: "updated", value: "first" });
  db.now += 5;
  const created = db.mutate("setCache", { key: "created", value: "second", expiration: { afterCreationMs: 10 } });
  const updated = db.mutate("setCache", { key: "updated", value: "second" });
  assert.deepEqual([created.createdAt, created.updatedAt, created.expiresAt, updated.expiresAt], [1_000_000, 1_000_005, 1_000_010, 1_000_025]);
  db.now += 5;
  assert.deepEqual([db.query("readCache", "created").value, db.query("readCache", "updated").value], [null, "second"]);
  const recreated = db.mutate("setCache", { key: "created", value: "third", expiration: { afterCreationMs: 10 } });
  assert.deepEqual([recreated.createdAt, recreated.expiresAt], [1_000_010, 1_000_020]);
  db.mutate("dropCache", "created");
  db.now += 1;
  assert.equal(db.mutate("setCache", { key: "created", value: "fourth", expiration: null }).createdAt, 1_000_011);
  assert.equal(db.mutate("setCache", { key: "zero", value: "z", expiration: { afterUpdateMs: 0 } }).expiresAt, 1_000_011);
  assert.equal(db.query("readCache", "zero").value, null);
});

test("expiration policies, values and names are validated", async () => {
  const db = await testDatabase(cacheApp);
  assert.deepEqual(rejected(() => db.mutate("setCache", { key: "k", value: "far too long" })).failure,
    { code: "INVALID_ARGUMENT", message: "Value must contain at most 10 characters", details: { path: [] } });
  const fake = (now: number) => ({ now: () => now, clock: () => now, changesAt: () => {}, get: () => null, set: () => {} }) as unknown as MutationContext;
  for (const expiration of [{}, [], { at: Number.NaN }, { at: Infinity }, { at: -1 }, { at: 1.5 }, { afterCreationMs: -1 }, { afterUpdateMs: "10" },
    { at: 1, afterUpdateMs: 2 }, { unknown: 10 }]) {
    assert.throws(() => cache.set(fake(0), "k", "v", expiration as never), TypeError, JSON.stringify(expiration));
  }
  assert.throws(() => cache.set(fake(Number.MAX_SAFE_INTEGER), "k", "v", { afterCreationMs: 1 }), /Deadline/);
  assert.throws(() => cache.set(fake(0), "", "v"), /nonempty/);
  assert.throws(() => expiringCollection("raw").set(fake(0), "k", undefined as never), TypeError);
  const expiration = { afterUpdateMs: 10 };
  const copied = expiringCollection<string>("copied", { expiration });
  expiration.afterUpdateMs = 500;
  assert.equal(copied.set(fake(0), "k", "v").expiresAt, 10);
  for (const name of ["", "$flower.cache"]) assert.throws(() => expiringCollection(name), TypeError);
  for (const options of [null, [], { extra: true }, { expiration: { after: 1 } }, { value: 1 }]) {
    assert.throws(() => expiringCollection("c", options as never), TypeError, JSON.stringify(options));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(cache.records.indexes)), { expiry: ["expiresAt"] });
  assert.equal(cache.kind, "component");
  assert.equal(Object.hasOwn(cache, "sweep"), false);
});

test("the sweep task pages through many expired entries", async () => {
  const bulk = expiringCollection<number>("bulkCache");
  const fill = mutation("fill", { args: v.int() }, (ctx, count) => { for (let i = 0; i < count; i++) bulk.set(ctx, `k${i}`, i, { afterCreationMs: 1 }); return null; });
  const size = query("size", (ctx) => ctx.scan(bulk.records).length);
  const db = await testDatabase(define({ uses: [bulk], http: { fill, size } }));
  db.mutate("fill", 130);
  assert.equal(db.query("size"), 130);
  assert.equal(db.advance(1), 3);
  assert.equal(db.query("size"), 0);
});
