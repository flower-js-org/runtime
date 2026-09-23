import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";

// Keep the downloadable npm imports intact, but exercise current SDK source.
// Tests must work before `npm run build` and must never read stale dist/ files.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../docs/terrarium.ts", import.meta.url))],
  alias: {
    "@flower-js/sdk": fileURLToPath(new URL("./index.ts", import.meta.url)),
    "@flower-js/sdk/scheduler": fileURLToPath(new URL("./scheduler.ts", import.meta.url)),
  },
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

// Run the downloadable application through the reactive reference engine.
// Only the trusted clock and commit loop are simulated here.
function terrarium() {
  const sandbox = createContext(Object.create(null));
  runInContext(bundle.outputFiles[0].text, sandbox, { timeout: 1_000 });
  runInContext(engine, sandbox, { timeout: 1_000 });
  const module = sandbox.__flowerBundle.default;
  let state: Record<string, unknown> = {};
  let time = 1_000;
  let sequence = 0;
  function invoke(kind: string, name: string, args: unknown) {
    const output = plain(sandbox.flowerInvoke(state, { kind, name, args, requestId: `terrarium-${sequence++}` },
      (method: string, input: unknown, ctx: unknown) => module.definitions[method].compute(ctx, input),
      (derived: string, input: unknown, ctx: unknown) => module.definitions[derived].compute(ctx, input), time));
    state = { ...state, ...output.puts };
    for (const key of output.deletes) delete state[key];
    return output;
  }
  return {
    get manifest() { return plain(module); },
    get state() { return plain(state); },
    set time(value: number) { time = value; },
    call(alias: string, args: unknown) {
      const method = module.http[alias];
      assert.ok(method, `No public method ${alias}`);
      return invoke(method.kind, method.name, args).value;
    },
    maintenance() { return invoke("mutation", module.maintenance.name, null).value; },
    internal(name: string, args: unknown) { return invoke("mutation", name, args).value; },
  };
}

test("the terrarium blooms on its durable deadline and updates only the matching garden", () => {
  const db = terrarium();
  assert.deepEqual(Object.keys(db.manifest.http).sort(), ["garden.plant", "garden.view"]);
  assert.equal(db.manifest.http["garden.view"].consistency, "replica-local");
  assert.ok(db.manifest.collections.some((entry: { name: string }) => entry.name === "seasons"));

  db.call("garden.plant", { garden: "moon", id: "luna" });
  db.time = 2_000;
  db.call("garden.plant", { garden: "sun", id: "luna" });
  const seedlings = { spacesLeft: 11, blooming: 0, flowers: { luna: "🌱" } };
  assert.deepEqual(db.call("garden.view", "moon"), seedlings);
  assert.deepEqual(db.call("garden.view", "sun"), seedlings);

  db.time = 5_999;
  assert.equal(db.maintenance(), null);
  db.time = 6_000;
  assert.equal(db.maintenance().id, 'bloom:["moon","luna"]');
  assert.deepEqual(db.call("garden.view", "moon"), { spacesLeft: 11, blooming: 1, flowers: { luna: "🌼" } });
  assert.deepEqual(db.call("garden.view", "sun"), seedlings);
  assert.equal(db.maintenance(), null);
  db.time = 7_000;
  assert.equal(db.maintenance().id, 'bloom:["sun","luna"]');
  assert.deepEqual(db.call("garden.view", "sun"), { spacesLeft: 11, blooming: 1, flowers: { luna: "🌼" } });
  assert.equal(db.maintenance(), null, "committed timer is removed atomically with its bloom");

  db.time = 35_999;
  assert.equal(db.maintenance(), null);
  db.time = 36_000;
  assert.equal(db.maintenance().id, 'perish:["moon","luna"]');
  assert.deepEqual(db.call("garden.view", "moon"), { spacesLeft: 12, blooming: 0, flowers: {} });
  assert.deepEqual(db.call("garden.view", "sun"), { spacesLeft: 11, blooming: 1, flowers: { luna: "🌼" } });
  db.time = 37_000;
  assert.equal(db.maintenance().id, 'perish:["sun","luna"]');
  assert.deepEqual(db.call("garden.view", "sun"), { spacesLeft: 12, blooming: 0, flowers: {} });
  assert.equal(db.maintenance(), null);
});

test("the terrarium rejects bad plants without changing state and uses collision-free composite keys", () => {
  const db = terrarium();
  db.call("garden.plant", { garden: "moon/fern", id: "luna" });
  db.call("garden.plant", { garden: "moon", id: "fern/luna" });
  assert.deepEqual(db.call("garden.view", "moon/fern"), { spacesLeft: 11, blooming: 0, flowers: { luna: "🌱" } });
  assert.deepEqual(db.call("garden.view", "moon"), { spacesLeft: 11, blooming: 0, flowers: { "fern/luna": "🌱" } });
  const before = db.state;
  assert.throws(() => db.call("garden.plant", { garden: "moon/fern", id: "luna" }), /already planted/);
  for (const args of [null, {}, { garden: "moon", id: "" }, { garden: 42, id: "luna" }]) {
    assert.throws(() => db.call("garden.plant", args), /Give your garden and seed a name/);
  }
  assert.deepEqual(db.state, before);
});

test("garden capacity is scoped, enforced atomically, and freed when flowers perish", () => {
  const db = terrarium();
  for (let index = 0; index < 12; index++) {
    db.call("garden.plant", { garden: "moon", id: `seed-${index}` });
  }
  assert.equal(db.call("garden.view", "moon").spacesLeft, 0);
  const full = db.state;
  assert.throws(() => db.call("garden.plant", { garden: "moon", id: "one-too-many" }), /Garden full/);
  assert.deepEqual(db.state, full, "a rejected seed creates neither timers nor records");
  db.call("garden.plant", { garden: "sun", id: "luna" });
  assert.equal(db.call("garden.view", "sun").spacesLeft, 11);

  db.time = 36_000;
  for (let index = 0; index < 13; index++) db.maintenance(); // All overdue blooms first.
  assert.equal(db.call("garden.view", "moon").spacesLeft, 0);
  assert.equal(db.maintenance().id, 'perish:["moon","seed-0"]');
  assert.equal(db.call("garden.view", "moon").spacesLeft, 1);
  db.call("garden.plant", { garden: "moon", id: "next-generation" });
  assert.equal(db.call("garden.view", "moon").spacesLeft, 0);
});

test("old lifecycle callbacks cannot bloom or delete a replanted name", () => {
  const db = terrarium();
  db.call("garden.plant", { garden: "moon", id: "luna" });
  db.time = 36_000;
  db.maintenance();
  db.maintenance();
  db.call("garden.plant", { garden: "moon", id: "luna" });
  const replacement = db.state;
  const old = { key: '["moon","luna"]', plantedAt: 1_000 };
  db.internal("internal.bloom", old);
  db.internal("internal.perish", old);
  assert.deepEqual(db.state, replacement);
  assert.deepEqual(db.call("garden.view", "moon"), { spacesLeft: 11, blooming: 0, flowers: { luna: "🌱" } });
  db.time = 41_000;
  db.maintenance();
  assert.deepEqual(db.call("garden.view", "moon"), { spacesLeft: 11, blooming: 1, flowers: { luna: "🌼" } });
  db.time = 71_000;
  db.maintenance();
  assert.deepEqual(db.call("garden.view", "moon"), { spacesLeft: 12, blooming: 0, flowers: {} });
});

test("homepage snippets are the complete downloadable terrarium and client", () => {
  const html = readFileSync(new URL("../docs/index.html", import.meta.url), "utf8");
  const snippets = [...html.matchAll(/<code class="language-ts">([\s\S]*?)<\/code>/g)].map(([, code]) =>
    code.replace(/<\/?span\b[^>]*>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
  assert.equal(snippets.length, 3);
  for (const [file, source] of [["terrarium.ts", snippets.slice(0, 2).join("\n\n")], ["terrarium-client.ts", snippets[2]]]) {
    assert.equal(source, readFileSync(new URL(`../docs/${file}`, import.meta.url), "utf8").trimEnd());
    for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      assert.match(match[1], /^@flower-js\/sdk(?:\/scheduler)?$/);
    }
  }
});
