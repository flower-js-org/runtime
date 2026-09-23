import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

// Exercise the downloadable worker against current SDK source, never dist/.
const bundle = await build({
  stdin: {
    contents: 'export { runWorker } from "./docs/job-worker.ts"; export { FlowerError } from "./sdk/client.ts";',
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
  },
  alias: { "@flower-js/sdk": fileURLToPath(new URL("./index.ts", import.meta.url)) },
  define: { "import.meta.url": JSON.stringify(new URL("../docs/job-worker.ts", import.meta.url).href) },
  bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent",
});
const { runWorker, FlowerError } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));

type Job = { id: string; state: string; attempts: number; lease: { owner: string; token: number; expiresAt: number } | null; result?: unknown; error?: any };

// An in-memory queue with the contract of examples/workers.ts: request-ID
// receipts, fencing tokens, LEASE_LOST, and a readiness watch.
function queue(ids: string[], hooks: { lose?: (name: string) => boolean; reject?: (name: string) => Error | undefined } = {}) {
  const jobs: Job[] = ids.map((id) => ({ id, state: "pending", attempts: 0, lease: null }));
  const receipts = new Map<string, unknown>();
  const calls: { name: string; args: any; requestId: string }[] = [];
  const waiters = new Set<() => void>();
  let token = 0, watches = 0;
  const claimable = (job: Job) => job.state === "pending" || (job.state === "leased" && job.lease!.expiresAt <= Date.now());
  const notify = () => { for (const wake of [...waiters]) wake(); };
  const client = {
    async mutate(name: string, args: any, { requestId }: { requestId: string }) {
      calls.push({ name, args, requestId });
      const rejected = hooks.reject?.(name);
      if (rejected) throw rejected;
      if (receipts.has(requestId)) return { value: receipts.get(requestId), duplicate: true };
      let value: unknown;
      if (name === "jobs.claim") {
        const job = jobs.find(claimable);
        if (job) {
          job.state = "leased";
          job.attempts++;
          job.lease = { owner: args.owner, token: ++token, expiresAt: Date.now() + args.leaseMs };
        }
        value = job ? { id: job.id, payload: null, ...job.lease, attempt: job.attempts } : null;
      } else {
        const job = jobs.find((candidate) => candidate.id === args.id);
        if (!job || job.state !== "leased" || job.lease!.token !== args.token || job.lease!.expiresAt <= Date.now()) {
          throw new FlowerError("EVALUATION_FAILED (422): LEASE_LOST: Job lease is missing, expired, or held by another claim", 422, "EVALUATION_FAILED");
        }
        Object.assign(job, { state: name === "jobs.complete" ? "completed" : "failed", result: args.result, error: args.error, lease: null });
        value = { ...job };
      }
      receipts.set(requestId, value);
      notify();
      if (hooks.lose?.(name)) throw new FlowerError("reply lost", 503, "UNAVAILABLE");
      return { value, duplicate: false };
    },
    async *watch(_name: string, _args: null, { signal }: { signal: AbortSignal }) {
      watches++;
      for (let last: boolean | undefined; !signal.aborted;) {
        const ready = jobs.some(claimable);
        if (ready !== last) yield { revision: 1, value: (last = ready) };
        await new Promise<void>((resolve) => {
          const wake = () => { waiters.delete(wake); resolve(); };
          waiters.add(wake);
          signal.addEventListener("abort", wake, { once: true });
          setTimeout(wake, 20); // Leases expire without a write.
        });
      }
      signal.throwIfAborted();
    },
  };
  return { client, jobs, calls, expire: (id: string) => { jobs.find((job) => job.id === id)!.lease!.expiresAt = 0; }, get watches() { return watches; } };
}

async function until(condition: () => boolean) {
  for (const started = Date.now(); !condition(); await sleep(5)) {
    if (Date.now() - started > 5_000) throw new Error("Timed out waiting for the worker");
  }
}

const options = (work: (job: any, signal: AbortSignal) => Promise<unknown>, extra = {}) =>
  ({ owner: "test-worker", lanes: 2, leaseMs: 10_000, work, log: () => {}, ...extra });

test("lanes drain the queue, complete every job once, and re-arm a fresh watch", async () => {
  const fake = queue(["a", "b", "c", "d", "e"]);
  const stop = new AbortController();
  const running = runWorker(fake.client, options(async (job) => ({ done: job.id })), stop.signal);
  await until(() => fake.jobs.every((job) => job.state === "completed"));
  stop.abort();
  await running;
  assert.deepEqual(fake.jobs.map((job) => [job.id, job.attempts, job.result]), ["a", "b", "c", "d", "e"].map((id) => [id, 1, { done: id }]));
  assert.ok(fake.watches >= 3, "each lane waits on a new watch after draining");
  const completions = fake.calls.filter((call) => call.name === "jobs.complete");
  assert.deepEqual(completions[0].args, { id: completions[0].args.id, owner: "test-worker", token: completions[0].args.token, result: completions[0].args.result });
});

test("a lost reply is retried with the same request ID and applied once", async () => {
  let lost = false;
  const fake = queue(["a"], { lose: (name) => name === "jobs.complete" && !lost && (lost = true) });
  const stop = new AbortController();
  const running = runWorker(fake.client, options(async () => "ok", { lanes: 1 }), stop.signal);
  await until(() => fake.calls.filter((call) => call.name === "jobs.complete").length === 2);
  stop.abort();
  await running;
  const [first, second] = fake.calls.filter((call) => call.name === "jobs.complete");
  assert.equal(first.requestId, second.requestId);
  assert.equal(fake.jobs[0].state, "completed");
});

test("a job that outlives its lease is logged as lost, then redone by the next claim", async () => {
  const lines: string[] = [];
  const fake = queue(["a"]);
  const stop = new AbortController();
  const running = runWorker(fake.client, options(async (job) => {
    if (job.attempt === 1) fake.expire(job.id); // Another worker could now claim it.
    return { attempt: job.attempt };
  }, { lanes: 1, log: (line: string) => lines.push(line) }), stop.signal);
  await until(() => fake.jobs[0].state === "completed");
  stop.abort();
  await running;
  assert.ok(lines.some((line) => /lost a, its lease ran out first/.test(line)), lines.join("\n"));
  assert.deepEqual(fake.jobs[0].result, { attempt: 2 });
});

test("a job that runs out of time is marked failed with a clear reason", async () => {
  const fake = queue(["slow"]);
  const stop = new AbortController();
  const running = runWorker(fake.client, options((_job, signal) => sleep(5_000, undefined, { signal }), { lanes: 1, leaseMs: 1_050 }), stop.signal);
  await until(() => fake.jobs[0].state === "failed");
  stop.abort();
  await running;
  assert.match(fake.jobs[0].error.message, /Ran out of time after \d+ ms/);
});

test("stopping finishes the held job and claims nothing new", async () => {
  const fake = queue(["a", "b"]);
  const stop = new AbortController();
  let started!: () => void, release!: () => void;
  const working = new Promise<void>((resolve) => { started = resolve; });
  const running = runWorker(fake.client, options(async () => {
    started();
    await new Promise<void>((done) => { release = done; });
    return "finished";
  }, { lanes: 1 }), stop.signal);
  await working;
  stop.abort();
  release();
  await running;
  assert.deepEqual(fake.jobs.map((job) => job.state), ["completed", "pending"]);
  assert.equal(fake.calls.filter((call) => call.name === "jobs.claim").length, 1);
});

test("a permanent claim error stops the worker instead of spinning", async () => {
  const fake = queue(["a"], { reject: (name) => name === "jobs.claim" ? new FlowerError("Lease duration exceeds the configured maximum", 422, "EVALUATION_FAILED") : undefined });
  await assert.rejects(runWorker(fake.client, options(async () => null, { lanes: 1 }), new AbortController().signal), /Lease duration exceeds/);
  assert.equal(fake.calls.length, 1);
});

test("the worker pools page shows the backlog query that examples/workers.ts deploys", () => {
  const page = readFileSync(new URL("../docs/guide/worker-pools.html", import.meta.url), "utf8");
  const block = page.match(/<span>examples\/workers\.ts<\/span>[\s\S]*?<code class="language-ts">([\s\S]*?)<\/code>/)![1];
  const code = block.replace(/<\/?span[^>]*>/g, "").replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
  assert.ok(readFileSync(new URL("../examples/workers.ts", import.meta.url), "utf8").includes(code), code);
});
