import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { buildBundle } from "./bundle.ts";
import { canonicalJson } from "./index.ts";

const bundle = await buildBundle(new URL("../examples/workers.ts", import.meta.url).pathname);
const engine = readFileSync(new URL("../runtime/engine.js", import.meta.url), "utf8");
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// Run the actual deployed example and reactive engine with a controlled clock.
// Queries never install writes, and no maintenance runs in these tests.
function workers() {
  const sandbox = createContext(Object.create(null));
  runInContext(bundle.javascript, sandbox, { timeout: 1_000 });
  runInContext(engine, sandbox, { timeout: 1_000 });
  const module = sandbox.__flowerBundle.default;
  let data: Record<string, any> = {};
  let sequence = 0;
  let time = 1_000;
  return {
    get time() { return time; },
    set time(value: number) { time = value; },
    stored(id: string) {
      return plain(data[`source:${canonicalJson(["workerJobs", canonicalJson(["", id])])}`]);
    },
    call(alias: string, args: unknown = null) {
      const method = module.http[alias];
      assert.ok(method, `No public method ${alias}`);
      const before = JSON.stringify(data);
      const output = plain(sandbox.flowerInvoke(data,
        { kind: method.kind, name: method.name, args, requestId: `reactive-queue-${sequence++}` },
        (name: string, input: unknown, ctx: unknown) => module.definitions[name].compute(ctx, input),
        (name: string, input: unknown, ctx: unknown) => module.definitions[name].compute(ctx, input), time));
      assert.equal(JSON.stringify(data), before, "evaluation preserves its input snapshot");
      if (method.kind === "query") {
        assert.deepEqual(output.puts, {}, "readiness must not reclaim leases or write state");
        assert.deepEqual(output.deletes, []);
      } else {
        data = { ...data, ...output.puts };
        for (const key of output.deletes) delete data[key];
      }
      return output.value;
    },
  };
}

test("queue readiness wakes on pending work and lease expiry without maintenance", () => {
  const db = workers();
  assert.equal(db.call("jobs.ready"), false);
  db.call("jobs.enqueue", { id: "one", payload: { work: true } });
  assert.equal(db.call("jobs.ready"), true);

  const first = db.call("jobs.claim", { owner: "worker-a", leaseMs: 100 });
  assert.equal(db.call("jobs.ready"), false);
  db.time = first.expiresAt - 1;
  assert.equal(db.call("jobs.ready"), false);
  db.time = first.expiresAt;
  assert.equal(db.call("jobs.ready"), true, "expiry changes readiness without a new commit");
  assert.equal(db.stored("one").state, "leased", "readiness does not depend on a sweep");

  const second = db.call("jobs.claim", { owner: "worker-b", leaseMs: 100 });
  assert.ok(second.token > first.token);
  assert.equal(db.call("jobs.ready"), false);
  assert.throws(() => db.call("jobs.complete", { ...first, result: "stale" }),
    (error: any) => error.code === "LEASE_LOST");
  db.call("jobs.complete", { ...second, result: "finished" });
  db.time = second.expiresAt;
  assert.equal(db.call("jobs.ready"), false, "finished history never becomes ready");
});

test("readiness remains true until pending work is drained, and failures need explicit retry", () => {
  const db = workers();
  for (const id of ["one", "two"]) db.call("jobs.enqueue", { id, payload: id });
  assert.equal(db.call("jobs.ready"), true);
  const first = db.call("jobs.claim", { owner: "worker-a", leaseMs: 100 });
  assert.equal(db.call("jobs.ready"), true, "another pending job does not need a new true edge");
  const second = db.call("jobs.claim", { owner: "worker-b", leaseMs: 100 });
  assert.equal(db.call("jobs.ready"), false);
  db.call("jobs.complete", { ...first, result: null });
  db.call("jobs.fail", { ...second, error: { code: "EXTERNAL_FAILURE" } });
  db.time = second.expiresAt;
  assert.equal(db.call("jobs.ready"), false, "failed work does not retry through lease expiry");
  db.call("jobs.retry", second.id);
  assert.equal(db.call("jobs.ready"), true);
  const retried = db.call("jobs.claim", { owner: "worker-c", leaseMs: 100 });
  assert.equal(retried.id, second.id);
  assert.equal(retried.attempt, second.attempt + 1);
  assert.equal(db.call("jobs.ready"), false);
});
