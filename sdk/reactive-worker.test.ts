import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";
import { canonicalJson } from "./index.ts";

// Bundle the actual download against current source, without depending on dist/.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../docs/reactive-worker.ts", import.meta.url))],
  alias: { "@flower-js/sdk": fileURLToPath(new URL("./index.ts", import.meta.url)) },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "__flowerBundle",
  platform: "neutral",
  target: "es2020",
  logLevel: "silent",
});
const engine = readFileSync(new URL("../runtime/engine.js", import.meta.url), "utf8");
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function application() {
  const sandbox = createContext(Object.create(null));
  runInContext(bundle.outputFiles[0].text, sandbox, { timeout: 1_000 });
  runInContext(engine, sandbox, { timeout: 1_000 });
  const module = sandbox.__flowerBundle.default;
  let state: Record<string, unknown> = {};
  let sequence = 0;
  return {
    get state() { return plain(state); },
    call(alias: string, args: unknown) {
      const method = module.http[alias];
      assert.ok(method, `No public method ${alias}`);
      const output = plain(sandbox.flowerInvoke(state,
        { kind: method.kind, name: method.name, args, requestId: `worker-${sequence++}` },
        (name: string, input: unknown, ctx: unknown) => module.definitions[name].compute(ctx, input),
        (name: string, input: unknown, ctx: unknown) => module.definitions[name].compute(ctx, input), 1_000));
      state = { ...state, ...output.puts };
      for (const key of output.deletes) delete state[key];
      return output.value;
    },
  };
}

test("worker publication feeds a guarded derive and immediately hides obsolete results", () => {
  const db = application();
  assert.equal(db.call("document.get", "one"), null);
  assert.equal(db.call("worker.pending", "one"), null);
  db.call("document.put", { id: "one", text: "A" });
  const work = db.call("worker.pending", "one");
  assert.deepEqual(work, {
    key: canonicalJson(["one", { recipe: "sha256-v1", text: "A" }]),
    input: { recipe: "sha256-v1", text: "A" },
  });
  assert.deepEqual(db.call("document.get", "one"), { text: "A", result: null });
  assert.deepEqual(db.call("worker.publish", { id: "one", key: work.key, result: digest("A") }), { accepted: true });
  assert.deepEqual(db.call("document.get", "one"), { text: "A", result: digest("A") });
  assert.equal(db.call("worker.pending", "one"), null);

  db.call("document.put", { id: "one", text: "B" });
  assert.deepEqual(db.call("document.get", "one"), { text: "B", result: null });
  assert.deepEqual(db.call("worker.pending", "one").input, { recipe: "sha256-v1", text: "B" });
  assert.deepEqual(db.call("worker.publish", { id: "one", key: work.key, result: digest("A") }), { accepted: false });
  assert.deepEqual(db.call("document.get", "one"), { text: "B", result: null });
});

test("superseded and deleted work cannot publish", () => {
  const db = application();
  db.call("document.put", { id: "one", text: "A" });
  const workA = db.call("worker.pending", "one");
  db.call("document.put", { id: "one", text: "B" });
  const workB = db.call("worker.pending", "one");
  assert.deepEqual(db.call("worker.publish", { id: "one", key: workA.key, result: digest("A") }), { accepted: false });
  db.call("document.delete", "one");
  assert.deepEqual(db.call("worker.publish", { id: "one", key: workB.key, result: digest("B") }), { accepted: false });
  assert.equal(db.call("worker.pending", "one"), null);
  assert.equal(db.call("document.get", "one"), null);
});

test("duplicate computation preserves the first accepted result and stops pending work", () => {
  const db = application();
  db.call("document.put", { id: "one", text: "A" });
  const work = db.call("worker.pending", "one");
  for (const result of [digest("A"), digest("a duplicate must not overwrite")]) {
    assert.deepEqual(db.call("worker.publish", { id: "one", key: work.key, result }), { accepted: true });
  }
  assert.deepEqual(db.call("document.get", "one"), { text: "A", result: digest("A") });
  assert.equal(db.call("worker.pending", "one"), null);
});

test("A → B → A accepts equivalent old work and reuses an existing matching result", () => {
  const db = application();
  db.call("document.put", { id: "one", text: "A" });
  const workA = db.call("worker.pending", "one");
  db.call("document.put", { id: "one", text: "B" });
  const workB = db.call("worker.pending", "one");
  db.call("document.put", { id: "one", text: "A" });
  assert.deepEqual(db.call("worker.pending", "one"), workA);
  assert.deepEqual(db.call("worker.publish", { id: "one", key: workA.key, result: digest("A") }), { accepted: true });
  assert.deepEqual(db.call("worker.publish", { id: "one", key: workB.key, result: digest("B") }), { accepted: false });

  db.call("document.put", { id: "one", text: "B" });
  assert.deepEqual(db.call("document.get", "one"), { text: "B", result: null });
  db.call("document.put", { id: "one", text: "A" });
  assert.equal(db.call("worker.pending", "one"), null);
  assert.deepEqual(db.call("document.get", "one"), { text: "A", result: digest("A") });
});

test("irrelevant edits do not invalidate work and identical documents have distinct identities", () => {
  const db = application();
  db.call("document.put", { id: "one", text: "A" });
  const work = db.call("worker.pending", "one");
  db.call("document.put", { id: "two", text: "A" });
  assert.notEqual(db.call("worker.pending", "two").key, work.key);
  assert.deepEqual(db.call("worker.publish", { id: "two", key: work.key, result: digest("A") }), { accepted: false });
  db.call("document.put", { id: "two", text: "B" });
  assert.deepEqual(db.call("worker.publish", { id: "one", key: work.key, result: digest("A") }), { accepted: true });
  assert.deepEqual(db.call("document.get", "one"), { text: "A", result: digest("A") });
  assert.deepEqual(db.call("document.get", "two"), { text: "B", result: null });
});

test("invalid document inputs and malformed results leave state unchanged", () => {
  const db = application();
  db.call("document.put", { id: "one", text: "" });
  const work = db.call("worker.pending", "one");
  const before = db.state;
  for (const input of [null, {}, { id: "", text: "A" }, { id: "one", text: 42 },
    { id: "one", text: "A".repeat(100_001) }]) {
    assert.throws(() => db.call("document.put", input));
  }
  for (const result of [null, 42, "a".repeat(63), "g".repeat(64), "A".repeat(64)]) {
    assert.throws(() => db.call("worker.publish", { id: "one", key: work.key, result }), /SHA-256/);
  }
  assert.deepEqual(db.state, before);
});
