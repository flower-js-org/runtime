import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { canonicalJson, collection } from "./index.ts";
import type { Collection, Derived, HistoryIdentity, MutationContext, Query, RangeQuery, RangePage } from "./index.ts";
import { buildBundle } from "./bundle.ts";
import { expiringCollection, workQueue } from "./temporal.ts";

function copy<T>(value: T): T { return JSON.parse(canonicalJson(value)); }

import { memoryRange } from "./range-fixture.test.ts";

class MemoryContext implements MutationContext {
  principal() { return null; }
  historyIdentity:HistoryIdentity|null=null;
  history() { return this.historyIdentity; }
  range<T>(query: RangeQuery<T>): RangePage<T> {
    return memoryRange(query, Array.from(this.data.get(query.collection)?.entries() ?? [], ([key,value]) => ({key,value:structuredClone(value) as T})));
  }
  time: number;
  data = new Map<string, Map<string, unknown>>();
  constructor(time = 1_000) { this.time = time; }
  now(): number { return this.time; }
  get<T>(ref: Collection<T>, key: string): T | null;
  get<A, V>(ref: Derived<A, V>, args: A): V;
  get(ref: any, key: any): any {
    if (ref.kind === "derived") return ref.compute(this, key);
    const values = this.data.get(ref.name);
    return values?.has(key) ? copy(values.get(key)) : null;
  }
  set<T>(ref: Collection<T>, key: string, value: T): void {
    if (!this.data.has(ref.name)) this.data.set(ref.name, new Map());
    this.data.get(ref.name)!.set(key, copy(value));
  }
  delete<T>(ref: Collection<T>, key: string): void { this.data.get(ref.name)?.delete(key); }
  scan<T>(ref: Collection<T>): { key: string; value: T }[] {
    return Array.from(this.data.get(ref.name)?.entries() ?? [])
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => ({ key, value: copy(value) as T }));
  }
  query<T>(_query: Query<T>): T[] { throw new Error("Test helper does not implement index queries"); }
  materialize<A, V>(_ref: Derived<A, V>, _args: A): void {}
  unmaterialize<A, V>(_ref: Derived<A, V>, _args: A): void {}
}

test("TTL reads expire at the deadline without waiting for physical cleanup", () => {
  const ctx = new MemoryContext();
  const cache = expiringCollection<string>("cache");
  const record = cache.set(ctx, "one", "value", { at: 1_010 });
  assert.deepEqual(record, { value: "value", createdAt: 1_000, updatedAt: 1_000, expiresAt: 1_010 });
  ctx.time = 1_009;
  assert.equal(cache.get(ctx, "one"), "value");
  ctx.time = 1_010;
  assert.equal(cache.get(ctx, "one"), null);
  assert.equal(cache.entry(ctx, "one"), null);
  assert.deepEqual(cache.scan(ctx), []);
  assert.notEqual(ctx.get(cache.records, "one"), null, "expired storage still exists before maintenance");
  assert.equal(cache.sweep(ctx), 1);
  assert.equal(ctx.get(cache.records, "one"), null);
  assert.equal(cache.sweep(ctx), 0);
});

test("creation and update TTLs diverge on updates and recreation resets creation", () => {
  const ctx = new MemoryContext();
  const cache = expiringCollection<string>("cache");
  cache.set(ctx, "created", "first", { afterCreationMs: 10 });
  cache.set(ctx, "updated", "first", { afterUpdateMs: 10 });
  ctx.time = 1_005;
  const created = cache.set(ctx, "created", "second", { afterCreationMs: 10 });
  const updated = cache.set(ctx, "updated", "second", { afterUpdateMs: 10 });
  assert.equal(created.createdAt, 1_000);
  assert.equal(created.updatedAt, 1_005);
  assert.equal(created.expiresAt, 1_010);
  assert.equal(updated.expiresAt, 1_015);
  ctx.time = 1_010;
  assert.equal(cache.get(ctx, "created"), null);
  assert.equal(cache.get(ctx, "updated"), "second");
  const recreated = cache.set(ctx, "created", "third", { afterCreationMs: 10 });
  assert.equal(recreated.createdAt, 1_010);
  assert.equal(recreated.expiresAt, 1_020);
  cache.delete(ctx, "created");
  ctx.time = 1_011;
  assert.equal(cache.set(ctx, "created", "fourth", null).createdAt, 1_011);
});

test("expiration rules validate runtime input, zero durations, and arithmetic bounds", () => {
  const ctx = new MemoryContext();
  const cache = expiringCollection<string>("cache", { expiration: { afterUpdateMs: 20 } });
  assert.equal(cache.set(ctx, "default", "value").expiresAt, 1_020);
  cache.set(ctx, "none", "value", null);
  cache.set(ctx, "computed", "value", { at: ctx.now() + 5 });
  cache.set(ctx, "zero", "value", { afterUpdateMs: 0 });
  assert.equal(cache.get(ctx, "zero"), null);
  for (const expiration of [
    {}, [], { at: NaN }, { at: Infinity }, { at: -1 }, { at: 1.5 },
    { afterCreationMs: -1 }, { afterUpdateMs: "10" }, { at: 1, afterUpdateMs: 2 }, { unknown: 10 },
  ]) assert.throws(() => cache.set(ctx, "invalid", "value", expiration as any), TypeError);
  assert.equal(ctx.get(cache.records, "invalid"), null);
  ctx.time = Number.MAX_SAFE_INTEGER;
  assert.throws(() => cache.set(ctx, "overflow", "value", { afterCreationMs: 1 }), /Deadline/);
  assert.equal(cache.get(ctx, "none"), "value");
  assert.throws(() => cache.set(ctx, "bad-json", undefined as any, null), TypeError);
});

test("helper defaults are copied, per-write overrides are temporary, and internal names are reserved", () => {
  const ctx = new MemoryContext();
  const expiration = { afterUpdateMs: 10 };
  const cache = expiringCollection<string>("cache", { expiration });
  expiration.afterUpdateMs = 500;
  assert.equal(cache.set(ctx, "one", "value", { at: 1_100 }).expiresAt, 1_100);
  ctx.time = 1_005;
  assert.equal(cache.set(ctx, "one", "value").expiresAt, 1_015);
  for (const name of ["$flower.fencing", "$flower.reserved"]) {
    assert.throws(() => expiringCollection(name), /reserved/);
    assert.throws(() => workQueue(name, { maxLeaseMs: 10 }), /reserved/);
  }
  for (const config of [null, [], { extra: true }, { expiration: null, extra: true }]) {
    assert.throws(() => expiringCollection("cache", config as any), TypeError);
  }
  const leaseOptions = { maxLeaseMs: 10, defaultLeaseMs: 5 };
  const queue = workQueue("jobs", leaseOptions);
  leaseOptions.maxLeaseMs = 500;
  leaseOptions.defaultLeaseMs = 400;
  queue.enqueue(ctx, "one", null);
  assert.equal(queue.claim(ctx, "owner")!.expiresAt, ctx.now() + 5);
  assert.throws(() => queue.claim(ctx, "owner", 11), /maximum/);
  assert.throws(() => workQueue("jobs", { maxLeaseMs: 10, defaultLeaseMs: null } as any), TypeError);
});

test("workers compete for one lease and expired work is reclaimable without maintenance", () => {
  const ctx = new MemoryContext();
  const queue = workQueue<string, string>("jobs", { maxLeaseMs: 10 });
  queue.enqueue(ctx, "one", "payload");
  const first = queue.claim(ctx, "worker-a")!;
  assert.equal(first.expiresAt, 1_010);
  assert.equal(first.attempt, 1);
  assert.equal(queue.claim(ctx, "worker-b"), null);
  assert.throws(() => queue.complete(ctx, { ...first, owner: "worker-b" }, "wrong owner"), /another claim/);
  ctx.time = 1_010;
  assert.throws(() => queue.complete(ctx, first, "too late"), (error: any) => error.code === "LEASE_LOST");
  assert.equal(queue.get(ctx, "one")!.state, "pending");
  assert.equal((queue.get(ctx, "one")!.error as any).code, "LEASE_EXPIRED");
  assert.equal(ctx.get(queue.records, canonicalJson(["", "one"]))!.state, "leased", "no sweep was needed to see expiration");
  const second = queue.claim(ctx, "worker-b")!;
  assert.ok(second.token > first.token);
  assert.equal(second.attempt, 2);
  assert.throws(() => queue.complete(ctx, first, "stale"), /another claim/);
  assert.throws(() => queue.fail(ctx, first, "stale failure"), /another claim/);
  assert.equal(queue.complete(ctx, second, "done").result, "done");
  assert.equal(queue.get(ctx, "one")!.state, "completed");
});

test("failed jobs remain visible, explicit retries fence old claims, and ID reuse cannot cause ABA", () => {
  const ctx = new MemoryContext();
  let queue = workQueue<string, string>("jobs", { maxLeaseMs: 20 });
  queue.enqueue(ctx, "reused", "original");
  const first = queue.claim(ctx, "same-worker")!;
  queue.fail(ctx, first, { message: "worker failed" });
  assert.deepEqual(queue.get(ctx, "reused")!.error, { message: "worker failed" });
  assert.equal(queue.get(ctx, "reused")!.state, "failed");
  assert.equal(queue.claim(ctx, "other-worker"), null);
  queue.retry(ctx, "reused");
  const second = queue.claim(ctx, "same-worker")!;
  assert.ok(second.token > first.token);
  assert.throws(() => queue.complete(ctx, first, "old"), /another claim/);
  assert.equal(queue.complete(ctx, second, "second attempt succeeded").error, null);
  assert.throws(() => queue.enqueue(ctx, "reused", "replacement"), /already exists/);
  ctx.time++;
  // Reconstructing the helper uses the same durable records and global counter.
  queue = workQueue<string, string>("jobs", { maxLeaseMs: 20 });
  queue.enqueue(ctx, "reused", "replacement", { replaceFinished: true });
  const third = queue.claim(ctx, "same-worker")!;
  assert.ok(third.token > second.token);
  assert.equal(third.attempt, 1);
  assert.throws(() => queue.complete(ctx, second, "stale reused ID"), /another claim/);
  assert.equal(queue.complete(ctx, third, "new payload done").payload, "replacement");
});

test("fencing tokens are global across queues and overflow fails without issuing a duplicate", () => {
  const ctx = new MemoryContext();
  const a = workQueue("queue-a", { maxLeaseMs: 10 });
  const b = workQueue("queue-b", { maxLeaseMs: 10 });
  a.enqueue(ctx, "a", null);
  b.enqueue(ctx, "b", null);
  const claimA = a.claim(ctx, "worker")!;
  const claimB = b.claim(ctx, "worker")!;
  assert.ok(claimB.token > claimA.token);
  a.enqueue(ctx, "overflow", null);
  ctx.set(collection<{ last: number }>("$flower.fencing"), "queue", { last: Number.MAX_SAFE_INTEGER });
  assert.throws(() => a.claim(ctx, "worker"), /fencing token/);
  assert.equal(a.get(ctx, "overflow")!.state, "pending");
});

test("lease duration, ownership, and deadline bounds are enforced at runtime", () => {
  const ctx = new MemoryContext();
  for (const maxLeaseMs of [0, -1, NaN, Infinity, 1.5, "10"]) {
    assert.throws(() => workQueue("jobs", { maxLeaseMs: maxLeaseMs as number }), TypeError);
  }
  assert.throws(() => workQueue("jobs", { maxLeaseMs: 10, defaultLeaseMs: 11 }), /maximum/);
  const queue = workQueue("jobs", { maxLeaseMs: 10 });
  queue.enqueue(ctx, "one", null);
  for (const leaseMs of [0, -1, NaN, Infinity, 1.5, "1", 11]) {
    assert.throws(() => queue.claim(ctx, "worker", leaseMs as number));
  }
  assert.throws(() => queue.claim(ctx, ""), TypeError);
  const claim = queue.claim(ctx, "worker", 1)!;
  assert.equal(claim.expiresAt, 1_001);
  assert.throws(() => queue.complete(ctx, { ...claim, token: 0 }, null), TypeError);
  assert.throws(() => queue.enqueue(ctx, "one", null, { replaceFinished: true }), /already exists/);
  ctx.time = Number.MAX_SAFE_INTEGER;
  assert.throws(() => queue.claim(ctx, "worker", 1), /Deadline/);
});

test("maintenance reclaims expired leases without resetting fencing history", () => {
  const ctx = new MemoryContext();
  const queue = workQueue("jobs", { maxLeaseMs: 10 });
  queue.enqueue(ctx, "one", null);
  const first = queue.claim(ctx, "worker")!;
  assert.equal(queue.sweep(ctx), 0);
  ctx.time = first.expiresAt;
  assert.equal(queue.sweep(ctx), 1);
  assert.equal(ctx.get(queue.records, canonicalJson(["", "one"]))!.state, "pending");
  assert.equal(queue.sweep(ctx), 0);
  assert.ok(queue.claim(ctx, "worker")!.token > first.token);
});

test("workers bundle registers maintenance privately and exposes queue/cache methods", async () => {
  const bundle = await buildBundle(new URL("../examples/workers.ts", import.meta.url).pathname);
  const sandbox: Record<string, any> = {};
  runInNewContext(bundle.javascript, sandbox, { timeout: 1_000 });
  const module = sandbox.__flowerBundle.default;
  assert.equal(module.maintenance.name, "internal.workers.maintenance");
  assert.equal(module.maintenance.kind, "mutation");
  assert.equal(module.definitions[module.maintenance.name].kind, "mutationMethod");
  assert.equal(Object.values(module.http).some((method: any) => method.name === module.maintenance.name), false);
  assert.equal(module.http["jobs.claim"].kind, "mutation");
  assert.equal(module.http["cache.get"].kind, "query");
});

test("shared queue scopes isolate identical IDs and preserve FIFO when leases expire", () => {
  const ctx = new MemoryContext();
  const a = workQueue<string>("shared",{scope:"a",maxLeaseMs:100});
  const b = workQueue<string>("shared",{scope:"b",maxLeaseMs:100});
  const unscoped = workQueue<string>("shared",{maxLeaseMs:100});
  a.enqueue(ctx,"one","a"); b.enqueue(ctx,"one","b"); unscoped.enqueue(ctx,canonicalJson(["a","one"]),"plain");
  const expired=a.claim(ctx,"old",1)!;
  ctx.time++;
  a.enqueue(ctx,"two","second");
  assert.equal(a.claim(ctx,"new")!.id,"one","expired old work precedes newly-created pending work");
  assert.equal(b.claim(ctx,"worker")!.payload,"b");
  assert.equal(unscoped.claim(ctx,"worker")!.payload,"plain","canonical-looking user IDs cannot collide with another scope");
  assert.throws(()=>a.complete(ctx,expired,null),/another claim/);
  assert.deepEqual(a.scan(ctx).map(row=>row.key),["one","two"]);
  assert.deepEqual(b.scan(ctx).map(row=>row.key),["one"]);
  const scan=ctx.scan;
  ctx.scan=()=>{throw new Error("hot helper must use bounded ranges");};
  assert.equal(a.claim(ctx,"next")!.id,"two");
  assert.equal(a.claim(ctx,"empty"),null);
  ctx.scan=scan;
});

test("lease and expiration sweeps traverse every bounded page without skipping deleted rows", () => {
  const ctx=new MemoryContext();
  const jobs=workQueue<number>("paged",{maxLeaseMs:1});
  const cache=expiringCollection<number>("paged-cache");
  for(let i=0;i<130;i++) {jobs.enqueue(ctx,`key-${i}`,i);jobs.claim(ctx,"owner");cache.set(ctx,`key-${i}`,i,{afterCreationMs:1});}
  ctx.time++;
  ctx.scan=()=>{throw new Error("sweep must use bounded ranges");};
  assert.equal(jobs.sweep(ctx),130);
  assert.equal(cache.sweep(ctx),130);
  assert.equal(jobs.sweep(ctx),0);
  assert.equal(cache.sweep(ctx),0);
  assert.equal(jobs.scan(ctx).length,130);
});


test("lease identities fence a restored history even before the old deadline",()=>{
  const ctx=new MemoryContext();
  const queue=workQueue("restored",{maxLeaseMs:1000});
  ctx.historyIdentity={database:"a".repeat(32),incarnation:"b".repeat(32)};
  queue.enqueue(ctx,"job",{action:"deliver"});
  const old=queue.claim(ctx,"worker")!;
  assert.deepEqual(old.history,ctx.historyIdentity);
  ctx.historyIdentity={...ctx.historyIdentity,incarnation:"c".repeat(32)};
  assert.throws(()=>queue.complete(ctx,old,{done:true}),/lease/i);
  assert.throws(()=>queue.complete(ctx,{...old,history:ctx.historyIdentity!},{done:true}),/lease/i,"claim still belongs to the old history");
  ctx.time=old.expiresAt;
  const current=queue.claim(ctx,"worker")!;
  assert.deepEqual(current.history,ctx.historyIdentity);
  assert.throws(()=>queue.complete(ctx,{...current,history:old.history},{done:true}),/lease/i);
  assert.equal(queue.complete(ctx,current,{done:true}).state,"completed");
});
