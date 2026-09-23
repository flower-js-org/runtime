import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { canonicalJson, collection, define, derive, mutation, query } from "./index.ts";
import type { Collection, Derived, MaintenanceHandlers, MutationContext, Query, RangeQuery, RangePage } from "./index.ts";
import { scheduler } from "./scheduler.ts";
import { buildBundle } from "./bundle.ts";

import { memoryRange } from "./range-fixture.test.ts";

class MemoryContext implements MutationContext {
  principal() { return null; }
  history() { return null; }
  range<T>(query: RangeQuery<T>): RangePage<T> {
    return memoryRange(query, Array.from(this.data.get(query.collection)?.entries() ?? [], ([key,value]) => ({key,value:structuredClone(value) as T})));
  }
  time: number;
  data = new Map<string, Map<string, unknown>>();
  constructor(time = 1_000) { this.time = time; }
  now(): number { return this.time; }
  fork(): MemoryContext {
    const next = new MemoryContext(this.time);
    next.data = structuredClone(this.data);
    return next;
  }
  get<T>(ref: Collection<T>, key: string): T | null;
  get<A, V>(ref: Derived<A, V>, args: A): V;
  get(ref: any, key: any): any {
    if (ref.kind === "derived") return ref.compute(this, key);
    const rows = this.data.get(ref.name);
    return rows?.has(key) ? structuredClone(rows.get(key)) : null;
  }
  set<T>(ref: Collection<T>, key: string, value: T): void {
    const copy = JSON.parse(canonicalJson(value));
    if (!this.data.has(ref.name)) this.data.set(ref.name, new Map());
    this.data.get(ref.name)!.set(key, copy);
  }
  delete<T>(ref: Collection<T>, key: string): void { this.data.get(ref.name)?.delete(key); }
  scan<T>(ref: Collection<T>): { key: string; value: T }[] {
    return Array.from(this.data.get(ref.name)?.entries() ?? []).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => ({ key, value: structuredClone(value) as T }));
  }
  query<T>(_query: Query<T>): T[] { throw new Error("Index queries are not needed by these tests"); }
  materialize<A, V>(_ref: Derived<A, V>, _args: A): void {}
  unmaterialize<A, V>(_ref: Derived<A, V>, _args: A): void {}
}

// This small harness supplies the host's documented original-snapshot fallback
// contract. Real rollback and Raft behavior are covered by the HTTP integration suite.
function maintenance(ctx: MemoryContext, handlers: MaintenanceHandlers, failedAt = ctx.time): unknown {
  const staged = ctx.fork();
  try {
    const value = handlers.run.compute(staged, null);
    ctx.data = staged.data;
    return value;
  } catch (error: any) {
    return handlers.onError.compute(ctx, {
      error: { code: error.code ?? "CALLBACK_FAILED", message: error.message ?? String(error) }, failedAt,
    });
  }
}

test("timers execute at or after their deadlines, commit business writes, and leave no success history", () => {
  const ctx = new MemoryContext();
  const output = collection<number>("output");
  const publish = mutation("private.publish", (ctx, args: { value: number }) => { ctx.set(output, "result", args.value); return null; });
  const timers = scheduler("timers", { publish });
  assert.equal(timers.after(ctx, "one", 100, "publish", { value: 42 }).dueAt, 1_100);
  ctx.time = 1_099;
  assert.equal(maintenance(ctx, timers.maintenance), null);
  assert.equal(ctx.get(output, "result"), null);
  ctx.time = 1_100;
  assert.deepEqual(maintenance(ctx, timers.maintenance), { id: "one", $flower: { continue: false } });
  assert.equal(ctx.get(output, "result"), 42);
  assert.equal(timers.get(ctx, "one"), null);
  assert.deepEqual(timers.scan(ctx), []);
  assert.equal(maintenance(ctx, timers.maintenance), null);
  const module = define({ maintenance: timers.maintenance });
  assert.deepEqual(Object.keys(module.definitions).sort(), ["internal.scheduler.timers.onError", "internal.scheduler.timers.run"]);
  assert.deepEqual(Object.keys(module.http), []);
});

test("one timer runs per invocation with deterministic deadline and ID ordering", () => {
  const ctx = new MemoryContext();
  const timers = scheduler("timers", { run: mutation("run", () => null) });
  timers.at(ctx, "b", 1_000, "run", null);
  timers.at(ctx, "a", 1_000, "run", null);
  timers.at(ctx, "earlier", 999, "run", null);
  assert.deepEqual(timers.scan(ctx).map((timer) => timer.id), ["earlier", "a", "b"]);
  assert.deepEqual(maintenance(ctx, timers.maintenance), { id: "earlier", $flower: { continue: true } });
  assert.deepEqual(maintenance(ctx, timers.maintenance), { id: "a", $flower: { continue: true } });
  assert.deepEqual(maintenance(ctx, timers.maintenance), { id: "b", $flower: { continue: false } });
});

test("same-ID replacement debounces updates and cancellation removes pending work", () => {
  const ctx = new MemoryContext();
  const output = collection<number>("output");
  const timers = scheduler("timers", { run: mutation("run", (ctx, args: { version: number }) => { ctx.set(output, "version", args.version); return null; }) });
  timers.after(ctx, "publish", 50, "run", { version: 1 });
  ctx.time = 1_025;
  const replacement = timers.after(ctx, "publish", 50, "run", { version: 2 });
  assert.equal(replacement.createdAt, 1_000);
  assert.equal(replacement.updatedAt, 1_025);
  assert.equal(replacement.dueAt, 1_075);
  ctx.time = 1_050;
  assert.equal(maintenance(ctx, timers.maintenance), null);
  ctx.time = 1_075;
  maintenance(ctx, timers.maintenance);
  assert.equal(ctx.get(output, "version"), 2);
  timers.after(ctx, "cancelled", 10, "run", { version: 3 });
  assert.equal(timers.cancel(ctx, "cancelled"), true);
  assert.equal(timers.cancel(ctx, "cancelled"), false);
  assert.equal(timers.get(ctx, "cancelled"), null);
});

test("deleting before dispatch preserves callbacks that reschedule their own ID", () => {
  const ctx = new MemoryContext();
  let again: (ctx: MutationContext, remaining: number) => void;
  const repeat = mutation("repeat", (ctx, args: { remaining: number }) => {
    if (args.remaining > 0) again(ctx, args.remaining - 1);
    return null;
  });
  const timers = scheduler("timers", { repeat });
  again = (ctx, remaining) => { timers.after(ctx, "repeat", 1, "repeat", { remaining }); };
  timers.after(ctx, "repeat", 0, "repeat", { remaining: 2 });
  maintenance(ctx, timers.maintenance);
  assert.deepEqual(timers.get(ctx, "repeat")!.args, { remaining: 1 });
  assert.equal(timers.get(ctx, "repeat")!.dueAt, 1_001);
  ctx.time++;
  maintenance(ctx, timers.maintenance);
  assert.deepEqual(timers.get(ctx, "repeat")!.args, { remaining: 0 });
  ctx.time++;
  maintenance(ctx, timers.maintenance);
  assert.equal(timers.get(ctx, "repeat"), null);
});

test("failure fallback counts attempts, applies capped backoff, and allows healthy work to progress", () => {
  const ctx = new MemoryContext();
  const output = collection<string>("output");
  const timers = scheduler("timers", {
    fail: mutation("fail", (ctx) => { ctx.set(output, "bad", "discard me"); throw new Error("failed"); }),
    healthy: mutation("healthy", (ctx) => { ctx.set(output, "good", "committed"); return null; }),
  }, { maxAttempts: 3, retryDelayMs: 10, maxRetryDelayMs: 15 });
  timers.after(ctx, "a-fails", 0, "fail", null);
  timers.after(ctx, "b-healthy", 0, "healthy", null);
  assert.equal((maintenance(ctx, timers.maintenance) as any).$flower.continue, true);
  assert.equal(ctx.get(output, "bad"), null);
  assert.equal(timers.get(ctx, "a-fails")!.attempts, 1);
  assert.equal(timers.get(ctx, "a-fails")!.dueAt, 1_010);
  maintenance(ctx, timers.maintenance);
  assert.equal(ctx.get(output, "good"), "committed");
  ctx.time = 1_010;
  maintenance(ctx, timers.maintenance, 1_012);
  assert.equal(timers.get(ctx, "a-fails")!.dueAt, 1_027);
  ctx.time = 1_027;
  maintenance(ctx, timers.maintenance);
  const failed = timers.get(ctx, "a-fails")!;
  assert.equal(failed.state, "failed");
  assert.equal(failed.attempts, 3);
  assert.equal(failed.error!.message, "failed");
  assert.equal(maintenance(ctx, timers.maintenance), null);
  assert.deepEqual(timers.scan(ctx, "failed").map((timer) => timer.id), ["a-fails"]);
  const retried = timers.retry(ctx, "a-fails", 5);
  assert.equal(retried.state, "pending");
  assert.equal(retried.attempts, 0);
  assert.equal(retried.error, null);
  assert.equal(retried.dueAt, 1_032);
  assert.throws(() => timers.retry(ctx, "a-fails"), /Only failed/);
});

test("failure selection uses the original clock while backoff starts after a long failed attempt", () => {
  const ctx = new MemoryContext();
  const timers = scheduler("timers", { fail: mutation("fail", () => { throw new Error("slow failure"); }) }, { retryDelayMs: 100 });
  timers.after(ctx, "original", 0, "fail", null);
  timers.after(ctx, "became-due-later", 1_000, "fail", null);
  maintenance(ctx, timers.maintenance, 6_000);
  assert.equal(timers.get(ctx, "original")!.attempts, 1);
  assert.equal(timers.get(ctx, "original")!.updatedAt, 6_000);
  assert.equal(timers.get(ctx, "original")!.dueAt, 6_100);
  assert.equal(timers.get(ctx, "became-due-later")!.attempts, 0);
  assert.equal(timers.get(ctx, "became-due-later")!.dueAt, 2_000);
});

test("reconstructed schedulers use durable records and current handlers; removed handlers fail finitely", () => {
  const ctx = new MemoryContext();
  const output = collection<string>("output");
  const original = scheduler("timers", { publish: mutation("old", (ctx) => { ctx.set(output, "result", "old"); return null; }) });
  original.after(ctx, "one", 0, "publish", null);
  const redeployed = scheduler("timers", { publish: mutation("new", (ctx) => { ctx.set(output, "result", "new"); return null; }) });
  maintenance(ctx, redeployed.maintenance);
  assert.equal(ctx.get(output, "result"), "new");
  original.after(ctx, "orphan", 0, "publish", null);
  const removed = scheduler("timers", {}, { maxAttempts: 1 });
  maintenance(ctx, removed.maintenance);
  assert.equal(removed.get(ctx, "orphan")!.state, "failed");
  assert.equal(removed.get(ctx, "orphan")!.error!.code, "SCHEDULER_HANDLER_MISSING");
  assert.throws(() => removed.retry(ctx, "orphan"), /Unknown scheduler handler/);
  redeployed.retry(ctx, "orphan");
  maintenance(ctx, redeployed.maintenance);
  assert.equal(redeployed.get(ctx, "orphan"), null);
});

test("async and non-JSON callbacks are failed attempts, including accessors that must not execute", () => {
  let getterExecuted = false;
  const accessor = { get value() { getterExecuted = true; return 1; } };
  const invalid = [undefined, NaN, Infinity, Promise.resolve(null), accessor, [,], new Date(), Symbol("invalid")];
  for (const result of invalid) {
    const ctx = new MemoryContext();
    const output = collection<number>("output");
    const timers = scheduler("timers", { bad: mutation("bad", (ctx) => { ctx.set(output, "result", 42); return result; }) }, { maxAttempts: 1 });
    timers.after(ctx, "bad", 0, "bad", null);
    maintenance(ctx, timers.maintenance);
    assert.equal(timers.get(ctx, "bad")!.state, "failed");
    assert.equal(timers.get(ctx, "bad")!.attempts, 1);
    assert.equal(ctx.get(output, "result"), null);
  }
  assert.equal(getterExecuted, false);
});

test("runtime validation rejects malformed configs and deadlines and protects reserved data", () => {
  const ctx = new MemoryContext();
  const run = mutation("run", () => null);
  for (const name of ["", "$flower.fencing"]) {
    assert.throws(() => scheduler(name, { run }), TypeError);
  }
  for (const handlers of [null, [], { run: query("read", () => null) }, { run: derive("derived", () => null) },
    { run: { ...run, extra: true } }]) {
    assert.throws(() => scheduler("timers", handlers as any), TypeError);
  }
  for (const options of [null, [], { extra: 1 }, { maxAttempts: 0 }, { retryDelayMs: 0 }, { maxAttempts: 1.5 },
    { retryDelayMs: NaN }, { retryDelayMs: Infinity }, { maxRetryDelayMs: 999 }, { maxAttempts: "3" }]) {
    assert.throws(() => scheduler("timers", { run }, options as any));
  }
  const timers = scheduler("timers", { run });
  for (const delay of [-1, Infinity, NaN, 0.5, "10"]) {
    assert.throws(() => timers.after(ctx, "one", delay as number, "run", null), TypeError);
    assert.throws(() => timers.at(ctx, "one", delay as number, "run", null), TypeError);
  }
  assert.throws(() => timers.after(ctx, "one", 0, "unknown" as "run", null), /Unknown scheduler handler/);
  assert.throws(() => timers.after(ctx, "one", 0, "run", undefined), TypeError);
  assert.doesNotThrow(() => timers.after(ctx, "x".repeat(513), 0, "run", null));
  ctx.time = Number.MAX_SAFE_INTEGER;
  assert.throws(() => timers.after(ctx, "overflow", 1, "run", null), /Deadline/);
  assert.equal(timers.get(ctx, "overflow"), null);
  assert.throws(() => timers.scan(ctx, "missing" as any), TypeError);
});

test("retry deadline overflow becomes terminal failure instead of jamming maintenance", () => {
  const ctx = new MemoryContext();
  const timers = scheduler("timers", { fail: mutation("fail", () => { throw new Error("failure"); }) });
  timers.after(ctx, "one", 0, "fail", null);
  maintenance(ctx, timers.maintenance, Number.MAX_SAFE_INTEGER);
  assert.equal(timers.get(ctx, "one")!.state, "failed");
  assert.equal(timers.get(ctx, "one")!.attempts, 1);
  assert.equal(timers.get(ctx, "one")!.updatedAt, Number.MAX_SAFE_INTEGER);
});

test("registries snapshot their handlers and safely support prototype-like aliases and IDs", () => {
  const ctx = new MemoryContext();
  const output = collection<number>("output");
  const handler = { kind: "mutationMethod" as const, name: "constructor", compute: (ctx: MutationContext) => { ctx.set(output, "value", 1); return null; } };
  const config = { maxAttempts: 1, retryDelayMs: 10 };
  const timers = scheduler("timers", { ["__proto__"]: handler }, config);
  handler.compute = (ctx) => { ctx.set(output, "value", 2); return null; };
  config.maxAttempts = 10;
  timers.after(ctx, "__proto__", 0, "__proto__", null);
  maintenance(ctx, timers.maintenance);
  assert.equal(ctx.get(output, "value"), 1);
  assert.equal(timers.get(ctx, "__proto__"), null);
});

test("scheduling example exposes business methods while handlers and maintenance remain private", async () => {
  const bundle = await buildBundle(new URL("../examples/scheduling.ts", import.meta.url).pathname);
  const sandbox: Record<string, any> = {};
  runInNewContext(bundle.javascript, sandbox, { timeout: 1_000 });
  const module = sandbox.__flowerBundle.default;
  assert.equal(module.http["documents.update"].kind, "mutation");
  assert.equal(module.http["documents.publication"].kind, "query");
  assert.equal(module.maintenance.name, "internal.scheduler.publicationTimers.run");
  assert.equal(module.maintenance.onError.name, "internal.scheduler.publicationTimers.onError");
  assert.equal(Object.values(module.http).some((method: any) => method.name.startsWith("internal.scheduler.")), false);
  assert.equal(Object.hasOwn(module.http, "internal.documents.publish"), false);
});

// Compile-time checks ensure the handler alias determines its argument type.
function typedArguments(ctx: MutationContext) {
  const timers = scheduler("typed", { publish: mutation("publish", (_ctx, args: { id: string; version: number }) => args.id) });
  timers.after(ctx, "one", 0, "publish", { id: "a", version: 1 });
  // @ts-expect-error Unknown aliases cannot be scheduled.
  timers.after(ctx, "one", 0, "missing", { id: "a", version: 1 });
  // @ts-expect-error Registered handlers retain their argument requirements.
  timers.after(ctx, "one", 0, "publish", { id: "a" });
}
void typedArguments;


test("scheduler catalogs and identifiers are bounded by application budgets, not fixed counts", () => {
  const handlers = Object.fromEntries(Array.from({ length: 300 }, (_, index) =>
    ["handler-" + index, mutation("internal.handler-" + index, () => null)]));
  const timers = scheduler("🕰".repeat(200), handlers);
  const context = new MemoryContext();
  const id = "id".repeat(400);
  timers.at(context, id, context.now(), "handler-299", null);
  assert.deepEqual(maintenance(context, timers.maintenance), { id, $flower: { continue: false } });
  assert.equal(timers.get(context, id), null);
});

test("maintenance selects due timers through bounded index ranges without scanning history", () => {
  const ctx=new MemoryContext();
  const callback=mutation("callback",()=>null);
  const timers=scheduler("seek-timers",{callback});
  timers.at(ctx,"later",2_000,"callback",null);
  timers.at(ctx,"due",1_000,"callback",null);
  ctx.scan=()=>{throw new Error("maintenance must not scan timers");};
  assert.deepEqual(timers.maintenance.run.compute(ctx,null),{id:"due",$flower:{continue:false}});
  assert.equal(timers.maintenance.run.compute(ctx,null),null);
  assert.deepEqual(timers.records.indexes.due,["state","dueAt"]);
});
