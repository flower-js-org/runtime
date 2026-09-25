import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import app from "../examples/workers.ts";
import { FlowerClient, FlowerError, type FlowerFetch } from "./client.ts";
import { testDatabase, type TestDatabase } from "./testing.ts";
import { runQueueWorker, type QueueWorkerEvent, type QueueWorkerOptions } from "./worker.ts";

type Db = TestDatabase<typeof app>;
type Call = { name: string; args: Record<string, unknown>; requestId?: string };

// Workers keep local deadlines with Date.now(), so the server clock starts there.
async function queue(ids: string[]): Promise<Db> {
  const db = await testDatabase(app, { now: Date.now() });
  for (const id of ids) db.mutate("jobs.enqueue", { id, payload: { id } });
  return db;
}

/** Keep server time in step with the wall clock, running due maintenance like a leader. */
function wallClock(db: Db): () => void {
  const timer = setInterval(() => db.advance(Math.max(0, Date.now() - db.now)), 5);
  return () => clearInterval(timer);
}

/** A client over the database that records every call; intercept may drop or replace replies. */
function recording(db: Db, intercept?: (call: Call, reply: Response) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: FlowerFetch = async (url, init) => {
    const reply = await db.fetch(url, init);
    if (url.endsWith("/v1/watch")) return reply;
    const call: Call = JSON.parse(init.body);
    calls.push({ name: call.name, args: call.args, requestId: call.requestId });
    return intercept ? intercept(call, reply) : reply;
  };
  return { client: new FlowerClient<typeof app>("http://flower.test", { fetch }), calls };
}

function start(client: FlowerClient<typeof app>, options: Partial<QueueWorkerOptions> & Pick<QueueWorkerOptions, "work">) {
  const stop = new AbortController();
  const events: QueueWorkerEvent[] = [];
  const done = runQueueWorker(client, { queue: "jobs", signal: stop.signal, onEvent: (event) => events.push(event), ...options });
  return { events, done, stop: () => { stop.abort(); return done; }, types: () => events.map((event) => event.type) };
}

async function until(condition: () => boolean) {
  for (const started = Date.now(); !condition(); await sleep(2)) {
    if (Date.now() - started > 3_000) throw new Error("Timed out waiting for the worker");
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const job = (db: Db, id: string) => {
  const found = db.query("jobs.get", { id });
  assert.ok(found, `no job ${id}`);
  return found;
};
const leaseEnd = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));

test("lanes drain the queue concurrently and complete every job exactly once", async () => {
  const ids = ["a", "b", "c", "d", "e"];
  const db = await queue(ids);
  const both = deferred();
  let running = 0;
  const worker = start(db.client, {
    owner: "test-worker", lanes: 2,
    async work(claim) {
      if (++running === 2) both.resolve();
      await both.promise;
      await sleep(1);
      running--;
      return { done: claim.id, by: claim.owner };
    },
  });
  await until(() => worker.types().filter((type) => type === "completed").length === ids.length);
  await worker.stop();
  assert.deepEqual(ids.map((id) => [job(db, id).state, job(db, id).attempts, job(db, id).result]), ids.map((id) => ["completed", 1, { done: id, by: "test-worker" }]));
  assert.deepEqual(new Set(worker.events.map((event) => "lane" in event ? event.lane : 0)), new Set([1, 2]));
  assert.equal(db.query("jobs.ready"), false);
});

test("a failed attempt is reported, requeued with backoff, and retried once it becomes ready", async () => {
  const db = await queue(["flaky"]);
  const worker = start(db.client, {
    work(claim) {
      if (claim.attempt === 1) throw new Error("upstream said no");
      return { attempt: claim.attempt };
    },
  });
  await until(() => worker.types().includes("failed"));
  const failed = job(db, "flaky");
  assert.deepEqual([failed.state, failed.attempts, failed.error, failed.availableAt], ["pending", 1, { message: "upstream said no" }, db.now + 1_000]);
  db.advance(999);
  await sleep(20);
  assert.deepEqual(worker.types(), ["claimed", "failed"], "the worker waits out the backoff");
  db.advance(1);
  await until(() => worker.types().includes("completed"));
  await worker.stop();
  assert.deepEqual(worker.types(), ["claimed", "failed", "claimed", "completed"]);
  assert.deepEqual(worker.events[1], { type: "failed", lane: 1, id: "flaky", error: "upstream said no" });
  const done = job(db, "flaky");
  assert.deepEqual([done.state, done.attempts, done.result], ["completed", 2, { attempt: 2 }]);
});

test("renewal keeps a job alive through many short leases", async () => {
  const db = await queue(["long"]);
  const { client, calls } = recording(db);
  const stopClock = wallClock(db);
  try {
    const worker = start(client, {
      leaseMs: 300,
      async work(_claim, signal) {
        await sleep(900, undefined, { signal });
        return "survived";
      },
    });
    await until(() => worker.events.length === 2);
    await worker.stop();
    assert.deepEqual(worker.types(), ["claimed", "completed"]);
  } finally { stopClock(); }
  const done = job(db, "long");
  assert.deepEqual([done.state, done.attempts, done.result], ["completed", 1, "survived"]);
  assert.ok(calls.filter((call) => call.name === "jobs.renew").length >= 5, "renewed well past the first lease");
});

test("work still running at the end of its lease is aborted and failed with the reason", async () => {
  const db = await queue(["slow"]);
  const worker = start(db.client, { leaseMs: 100, renew: false, work: (_claim, signal) => sleep(5_000, null, { signal }) });
  await until(() => worker.types().includes("failed"));
  await worker.stop();
  const failed = job(db, "slow");
  assert.deepEqual([failed.state, failed.attempts, failed.error], ["pending", 1, { message: "The lease ran out" }]);
});

test("a completion after another worker took over the expired lease is reported as lost", async () => {
  const db = await queue(["contested"]);
  const started = deferred(), release = deferred();
  const worker = start(db.client, {
    renew: false, leaseMs: 10_000,
    async work() { started.resolve(); await release.promise; return "too late"; },
  });
  await started.promise;
  db.advance(10_000);
  const thief = db.mutate("jobs.claim", { owner: "thief" });
  assert.ok(thief);
  assert.equal(thief.attempt, 2);
  release.resolve();
  await until(() => worker.types().includes("lost"));
  await worker.stop();
  assert.deepEqual(worker.types(), ["claimed", "lost"]);
  assert.equal(job(db, "contested").lease?.owner, "thief", "the lost completion changed nothing");
  db.mutate("jobs.complete", { id: thief.id, owner: thief.owner, token: thief.token, result: "rescued" });
  assert.equal(job(db, "contested").result, "rescued");
});

test("renewal notices a lease taken over after expiry and stops the work early", async () => {
  const db = await queue(["contested"]);
  const started = deferred();
  let reason: unknown;
  const worker = start(db.client, {
    leaseMs: 300,
    async work(_claim, signal) { started.resolve(); try { return await leaseEnd(signal); } catch (error) { reason = error; throw error; } },
  });
  await started.promise;
  db.advance(300);
  assert.ok(db.mutate("jobs.claim", { owner: "thief" }));
  await until(() => worker.types().includes("lost"));
  await worker.stop();
  assert.deepEqual(worker.types(), ["claimed", "lost"]);
  assert.equal((reason as Error).message, "The lease was lost");
  assert.equal(job(db, "contested").lease?.owner, "thief");
});

test("a completion whose reply is lost is retried with the same request ID and applied once", async () => {
  const db = await queue(["a"]);
  let dropped = 0;
  const { client, calls } = recording(db, (call, reply) => {
    if (call.name === "jobs.complete" && dropped++ === 0) throw new TypeError("fetch failed");
    return reply;
  });
  const worker = start(client, { retry: { initialDelayMs: 1 }, work: () => "ok" });
  await until(() => worker.events.length === 2);
  await worker.stop();
  assert.deepEqual(worker.types(), ["claimed", "completed"]);
  const completions = calls.filter((call) => call.name === "jobs.complete");
  assert.equal(completions.length, 2);
  assert.equal(completions[0].requestId, completions[1].requestId);
  const done = job(db, "a");
  assert.deepEqual([done.state, done.attempts, done.result], ["completed", 1, "ok"]);
});

test("stopping lets the held job finish and claims nothing new", async () => {
  const db = await queue(["a", "b"]);
  const { client, calls } = recording(db);
  const started = deferred(), release = deferred();
  const worker = start(client, {
    async work(_claim, signal) { started.resolve(); await release.promise; return { interrupted: signal.aborted }; },
  });
  await started.promise;
  const stopped = worker.stop();
  release.resolve();
  await stopped;
  assert.deepEqual(["a", "b"].map((id) => job(db, id).state), ["completed", "pending"]);
  assert.deepEqual(job(db, "a").result, { interrupted: false }, "stopping does not abort work in progress");
  assert.deepEqual(calls.map((call) => call.name), ["jobs.claim", "jobs.complete"]);
});

test("a permanent claim error rejects the worker instead of spinning", async () => {
  const db = await queue(["a"]);
  const { client, calls } = recording(db);
  await assert.rejects(runQueueWorker(client, { queue: "jobs", signal: new AbortController().signal, leaseMs: 60_000, work: () => null }),
    (error) => error instanceof FlowerError && error.failure?.code === "LEASE_TOO_LONG");
  assert.deepEqual(calls.map((call) => call.name), ["jobs.claim"]);
  assert.equal(job(db, "a").state, "pending");
});

test("a permanent error in one lane stops the others once they finish their held jobs", async () => {
  const db = await queue(["a", "b", "c"]);
  let claims = 0;
  const denied = () => new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "Authorization denied", failure: { code: "FORBIDDEN", message: "Access revoked" } } }),
    { status: 403, headers: { "content-type": "application/json" } });
  const client = new FlowerClient<typeof app>("http://flower.test", {
    fetch: async (url, init) => JSON.parse(init.body).name === "jobs.claim" && ++claims === 2 ? denied() : db.fetch(url, init),
  });
  const worker = start(client, { lanes: 2, async work(claim) { await sleep(20); return claim.id; } });
  await assert.rejects(worker.done, (error) => error instanceof FlowerError && error.status === 403 && error.failure?.code === "FORBIDDEN");
  assert.deepEqual(worker.types(), ["claimed", "completed"]);
  assert.deepEqual(["a", "b", "c"].map((id) => job(db, id).state), ["completed", "pending", "pending"]);
});

test("the worker pools backlog check subscribes to a method examples/workers.ts exposes, reading fields it returns", async () => {
  const page = readFileSync(new URL("../docs/guide/worker-pools.html", import.meta.url), "utf8");
  const block = page.match(/<span>Backlog check<\/span>[\s\S]*?<code class="language-ts">([\s\S]*?)<\/code>/)![1];
  const code = block.replace(/<\/?span[^>]*>/g, "").replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
  const [, alias, args] = code.match(/client\.subscribe\("([^"]+)", ([^)]+)\)/)!;
  const db = await queue(["a"]);
  const stats = db.query(alias as "jobs.stats", JSON.parse(args));
  for (const [, field] of code.matchAll(/value\.(\w+)/g)) assert.ok(field in stats, field);
  assert.equal(typeof stats.oldestReadyAt, "number");
  assert.ok(page.includes("<code>nextAvailableAt</code>") && "nextAvailableAt" in stats);
});
