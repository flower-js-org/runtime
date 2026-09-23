import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

// Exercise the downloadable example against current SDK source, never dist/.
const bundle = await build({
  stdin: {
    contents: 'export { runWorker } from "./docs/reactive-worker-client.ts"; export { FlowerError } from "./sdk/client.ts";',
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
  },
  alias: { "@flower-js/sdk": fileURLToPath(new URL("./index.ts", import.meta.url)) },
  define: { "import.meta.url": JSON.stringify(new URL("../docs/reactive-worker-client.ts", import.meta.url).href) },
  bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent",
});
const { runWorker, FlowerError } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const originalDigest = webcrypto.subtle.digest.bind(webcrypto.subtle);
const job = (key: string) => ({ key, input: { recipe: "sha256-v1", text: key } });
const snapshot = (key: string | null, revision = 1) => ({ revision, value: key === null ? null : job(key) });
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const shutdown = new AbortController();
  const events: any[] = [];
  let wake = () => {};
  let connections = 0, active = 0;
  let fresh = snapshot("A");
  const requests: { body: any; requestId: string }[] = [];
  let publish = async (_body: any, _requestId: string) => ({ value: { accepted: true } });
  const client = {
    async *watch(_name: string, _id: string, { signal }: { signal: AbortSignal }) {
      connections++;
      active++;
      const abort = () => wake();
      signal.addEventListener("abort", abort, { once: true });
      try {
        yield fresh;
        while (!signal.aborted) {
          if (!events.length) { await new Promise<void>((done) => { wake = done; }); continue; }
          const event = events.shift();
          if (event instanceof Error) throw event;
          if (event === "eof") return;
          yield event;
        }
      } finally { active--; signal.removeEventListener("abort", abort); }
    },
    async mutate(_name: string, body: any, { requestId }: { requestId: string }) {
      requests.push({ body: structuredClone(body), requestId });
      return publish(body, requestId);
    },
  };
  return {
    client, shutdown, requests,
    get connections() { return connections; },
    get active() { return active; },
    set fresh(value: ReturnType<typeof snapshot>) { fresh = value; },
    set publish(value: typeof publish) { publish = value; },
    send(event: any) { events.push(event); wake(); },
    start() { return runWorker(client, "doc-1", shutdown.signal); },
  };
}

test("worker closes its watch before computing and re-arms from current state after publication", { timeout: 3_000 }, async (t) => {
  t.mock.method(console, "log", () => {});
  const db = fixture(), started = deferred(), release = deferred(), published = deferred();
  const inputs: string[] = [];
  t.mock.method(webcrypto.subtle, "digest", async (algorithm: any, input: any) => {
    assert.equal(db.active, 0, "no watch remains open during computation");
    inputs.push(new TextDecoder().decode(input));
    if (inputs.length === 1) { started.resolve(); await release.promise; }
    return originalDigest(algorithm, input);
  });
  db.publish = async (body) => {
    if (body.key === "C") { db.fresh = snapshot(null, 4); published.resolve(); }
    return { value: { accepted: body.key === "C" } };
  };
  const running = db.start();
  try {
    await started.promise;
    db.fresh = snapshot("B", 2);
    await tick();
    db.fresh = snapshot("C", 3);
    await tick();
    assert.deepEqual(inputs, ["A"], "no overlapping computation");
    assert.equal(db.connections, 1, "new watch waits until this attempt settles");
    release.resolve();
    await published.promise;
    assert.deepEqual(inputs, ["A", "C"]);
    assert.deepEqual(db.requests.map(({ body }) => body.key), ["A", "C"]);
  } finally { release.resolve(); db.shutdown.abort(); await running; }
});

test("failed computation retries without a new watch event", { timeout: 3_000 }, async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const db = fixture(), published = deferred();
  let attempts = 0;
  t.mock.method(webcrypto.subtle, "digest", async (algorithm: any, input: any) => {
    if (++attempts === 1) throw new Error("temporary compute failure");
    return originalDigest(algorithm, input);
  });
  db.publish = async () => { db.fresh = snapshot(null, 2); published.resolve(); return { value: { accepted: true } }; };
  const running = db.start();
  try { await published.promise; assert.equal(attempts, 2); assert.equal(db.connections, 2); }
  finally { db.shutdown.abort(); await running; }
});

test("ambiguous publication retains its body and ID while newer work arrives", { timeout: 3_000 }, async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const db = fixture(), published = deferred();
  db.publish = async (body) => {
    if (db.requests.length === 1) { db.fresh = snapshot("B", 2); throw new TypeError("response lost"); }
    if (db.requests.length === 2) assert.equal(db.connections, 1, "settle the same intent before re-arming");
    if (body.key === "B") { db.fresh = snapshot(null, 3); published.resolve(); }
    return { value: { accepted: body.key === "B" } };
  };
  const running = db.start();
  try {
    await published.promise;
    assert.deepEqual(db.requests.map(({ body }) => body.key), ["A", "A", "B"]);
    assert.deepEqual(db.requests[0], db.requests[1]);
    assert.notEqual(db.requests[1].requestId, db.requests[2].requestId);
  } finally { db.shutdown.abort(); await running; }
});

test("fresh recheck repairs a rejected publication when A to B to A emits no watch event", { timeout: 3_000 }, async (t) => {
  t.mock.method(console, "log", () => {});
  const db = fixture(), published = deferred();
  db.publish = async () => {
    const accepted = db.requests.length === 2;
    if (accepted) { db.fresh = snapshot(null, 4); published.resolve(); }
    else db.fresh = snapshot("A", 3);
    return { value: { accepted } };
  };
  const running = db.start();
  try {
    await published.promise;
    assert.deepEqual(db.requests.map(({ body }) => body.key), ["A", "A"]);
    assert.notEqual(db.requests[0].requestId, db.requests[1].requestId);
    assert.equal(db.connections, 2);
  } finally { db.shutdown.abort(); await running; }
});

test("worker reconnects on EOF and scope changes, and stops on permanent Flower errors", { timeout: 3_000 }, async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const db = fixture();
  db.fresh = snapshot(null);
  db.send("eof");
  db.send(new FlowerError("deployment changed", 409, "WATCH_SCOPE_CHANGED"));
  db.send(new FlowerError("access revoked", 403, "FORBIDDEN"));
  await assert.rejects(db.start(), { code: "FORBIDDEN" });
  assert.equal(db.connections, 3);
});
