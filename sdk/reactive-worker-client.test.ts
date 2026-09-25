import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type app from "../docs/reactive-worker.ts";
import { FlowerClient, FlowerError } from "./client.ts";
import { testDatabase, type TestDatabase } from "./testing.ts";
import { reconcile } from "./worker.ts";

// Node ignores tsconfig paths, so resolve the download's @flower-js/sdk imports to
// current source; the worker then shares FlowerError and friends with this test.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const match = /^@flower-js\/sdk(?:\/([a-z0-9-]+))?$/.exec(specifier);
    return nextResolve(match ? new URL(`./${match[1] ?? "index"}.ts`, import.meta.url).href : specifier, context);
  },
});
const { runWorker } = await import("../docs/reactive-worker-client.ts");

const entry = fileURLToPath(new URL("../docs/reactive-worker.ts", import.meta.url));
const application = () => testDatabase<typeof app>(entry);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const originalDigest = webcrypto.subtle.digest.bind(webcrypto.subtle);
type DigestArgs = Parameters<typeof originalDigest>;
type Db = TestDatabase<typeof app>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(condition: () => boolean) {
  for (const started = Date.now(); !condition(); await sleep(2)) {
    if (Date.now() - started > 3_000) throw new Error("Timed out waiting for the worker");
  }
}

const digestOf = (db: Db, id: string, text: string) => db.client.waitUntil("document.get", id,
  (document) => document?.digest?.status === "ready" && document.digest.value === sha(text), { signal: AbortSignal.timeout(3_000) });

/** A client over the test database that records each publication and its reply. */
function recording(db: Db, intercept: (reply: Response, count: number) => Response | Promise<Response> = (reply) => reply) {
  const publications: { requestId: string; value: string; reply: { value: { accepted: boolean }; duplicate: boolean } }[] = [];
  const client = new FlowerClient<typeof app>("http://flower.test", {
    async fetch(url, init) {
      const response = await db.fetch(url, init);
      const body = JSON.parse(init.body);
      if (body.name !== "digest.publish") return response;
      publications.push({ requestId: body.requestId, value: body.args.value, reply: await response.clone().json() });
      return intercept(response, publications.length);
    },
  });
  return { client, publications };
}

test("a single-key worker keeps one document's digest current as it changes", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const db = await application();
  const stop = new AbortController();
  const worker = runWorker(db.client, stop.signal, "one");
  try {
    db.mutate("document.put", { id: "one", text: "A" });
    db.mutate("document.put", { id: "two", text: "not mine" });
    await digestOf(db, "one", "A");
    db.mutate("document.put", { id: "one", text: "B" });
    await digestOf(db, "one", "B");
  } finally { stop.abort(); await worker; }
  assert.deepEqual(db.query("document.get", "two"), { text: "not mine", digest: { status: "pending" } });
  assert.deepEqual(log.mock.calls.map((call) => call.arguments[0]), ["published", "published"]);
});

test("a pool worker drains every pending document and follows edits, additions and deletions", async (t) => {
  t.mock.method(console, "log", () => {});
  const db = await application();
  for (const id of ["one", "two", "three"]) db.mutate("document.put", { id, text: id });
  const stop = new AbortController();
  const worker = runWorker(db.client, stop.signal);
  try {
    for (const id of ["one", "two", "three"]) await digestOf(db, id, id);
    db.mutate("document.put", { id: "two", text: "second draft" });
    db.mutate("document.delete", "three");
    db.mutate("document.put", { id: "four", text: "four" });
    await digestOf(db, "two", "second draft");
    await digestOf(db, "four", "four");
  } finally { stop.abort(); await worker; }
  assert.deepEqual(db.query("digest.next"), []);
  assert.equal(db.query("document.get", "three"), null);
});

test("a result computed for a superseded input is rejected, and the worker computes the current one", async (t) => {
  t.mock.method(console, "log", () => {});
  const db = await application();
  const { client, publications } = recording(db);
  const started = deferred(), release = deferred();
  let computations = 0;
  t.mock.method(webcrypto.subtle, "digest", async (...args: DigestArgs) => {
    if (++computations === 1) { started.resolve(); await release.promise; }
    return originalDigest(...args);
  });
  db.mutate("document.put", { id: "one", text: "A" });
  const stop = new AbortController();
  const worker = runWorker(client, stop.signal, "one");
  try {
    await started.promise;
    db.mutate("document.put", { id: "one", text: "B" });
    release.resolve();
    await digestOf(db, "one", "B");
  } finally { release.resolve(); stop.abort(); await worker; }
  assert.deepEqual(publications.map(({ value, reply }) => [value, reply.value.accepted]), [[sha("A"), false], [sha("B"), true]]);
  assert.equal(computations, 2);
});

test("a publication whose reply is lost is retried with the same request ID and applied once", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const db = await application();
  const { client, publications } = recording(db, (reply, count) => {
    if (count === 1) throw new TypeError("fetch failed");
    return reply;
  });
  db.mutate("document.put", { id: "one", text: "A" });
  const stop = new AbortController();
  const worker = runWorker(client, stop.signal, "one");
  try { await until(() => log.mock.callCount() === 1); } finally { stop.abort(); await worker; }
  assert.equal(publications.length, 2);
  assert.equal(publications[0].requestId, publications[1].requestId);
  assert.deepEqual(publications.map(({ reply }) => [reply.value.accepted, reply.duplicate]), [[true, false], [true, true]]);
  assert.deepEqual(db.query("document.get", "one"), { text: "A", digest: { status: "ready", value: sha("A") } });
});

test("a failed computation is reported and retried until it succeeds", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  let computations = 0;
  t.mock.method(webcrypto.subtle, "digest", async (...args: DigestArgs) => {
    if (++computations === 1) throw new Error("hardware hiccup");
    return originalDigest(...args);
  });
  const db = await application();
  db.mutate("document.put", { id: "one", text: "A" });
  const stop = new AbortController();
  const worker = runWorker(db.client, stop.signal, "one");
  try { await digestOf(db, "one", "A"); } finally { stop.abort(); await worker; }
  assert.deepEqual(log.mock.calls.map((call) => call.arguments[0]), ["failed", "published"]);
  assert.equal(computations, 2);
});

test("the worker rides out transient watch failures and stops on a permanent one", async (t) => {
  t.mock.method(console, "log", () => {});
  const db = await application();
  const reply = (status: number, error: object) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
  let watches = 0;
  const client = new FlowerClient<typeof app>("http://flower.test", {
    async fetch(url, init) {
      if (!url.endsWith("/v1/watch")) return db.fetch(url, init);
      watches++;
      if (watches === 1) return reply(503, { code: "UNAVAILABLE", message: "No leader yet" });
      return reply(403, { code: "FORBIDDEN", message: "Authorization denied", failure: { code: "FORBIDDEN", message: "Access denied" } });
    },
  });
  await assert.rejects(runWorker(client, new AbortController().signal, "one"),
    (error) => error instanceof FlowerError && error.status === 403 && error.failure?.code === "FORBIDDEN");
  assert.equal(watches, 2);
});

test("sharded reconcile pools split the keys between them and compute concurrently", async () => {
  const db = await application();
  const ids = Array.from({ length: 8 }, (_, index) => `doc-${index}`);
  for (const id of ids) db.mutate("document.put", { id, text: id });
  const seen = [new Set<string>(), new Set<string>()];
  let running = 0, peak = 0;
  const stop = new AbortController();
  const pools = [0, 1].map((index) => reconcile<string, { recipe: string; text: string }, string>(db.client, {
    external: "digest", shard: [index, 2], concurrency: 3, signal: stop.signal,
    async compute(input, work) {
      seen[index].add(work.args);
      peak = Math.max(peak, ++running);
      await sleep(5);
      running--;
      return sha(input.text);
    },
  }));
  try { for (const id of ids) await digestOf(db, id, id); } finally { stop.abort(); await Promise.all(pools); }
  assert.deepEqual([...seen[0], ...seen[1]].sort(), ids);
  assert.equal([...seen[0]].filter((id) => seen[1].has(id)).length, 0, "shards are disjoint");
  assert.ok(peak > 1, `peak concurrency ${peak}`);
});

test("a pool keeps publishing other keys when one computed value fails the result schema", async () => {
  const db = await application();
  for (const id of ["good-1", "bad", "good-2"]) db.mutate("document.put", { id, text: id });
  const events: string[] = [];
  const stop = new AbortController();
  const pool = reconcile<string, { recipe: string; text: string }, string>(db.client, {
    external: "digest", signal: stop.signal,
    compute: async (input, work) => work.args === "bad" ? "not a digest" : sha(input.text),
    onEvent: (event) => events.push(`${event.type}:${"key" in event ? JSON.parse(event.key)[0] : ""}`),
  });
  try {
    await digestOf(db, "good-1", "good-1");
    await digestOf(db, "good-2", "good-2");
    await until(() => events.includes("failed:bad"));
  } finally { stop.abort(); await pool; }
  assert.deepEqual(db.query("document.get", "bad")?.digest, { status: "pending" });
});
