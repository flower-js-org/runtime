import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregate, collection, define } from "./index.ts";
import { collectionManifest, normalizeAggregateMetadata } from "./indexing.ts";
import type { Context } from "./index.ts";

const orders = collection<{ shop: string; cents: number }>("orders").index("shop", ["shop"]);
function sum() {
  return aggregate("total", {
    source: orders, index: "shop", initial: () => 0,
    add: (total, row) => total + row.cents,
    remove: (total, row) => total - row.cents,
  });
}

test("aggregate definitions keep serializable immutable metadata in the module", () => {
  const total = sum();
  const app = define({ collections: [orders], definitions: [total] });
  assert.deepEqual((app.definitions.total as typeof total).aggregate, { collection: "orders", fields: ["shop"] });
  assert.deepEqual(JSON.parse(JSON.stringify(app.collections)), [{ name: "orders", indexes: { shop: ["shop"] } }]);
  assert.ok(Object.isFrozen(app.collections));
  assert.ok(Object.isFrozen((app.definitions.total as typeof total).aggregate));
  assert.ok(Object.isFrozen((app.definitions.total as typeof total).aggregate!.fields));
  assert.equal(Object.hasOwn(define(), "collections"), false, "old bundles need no schema metadata");
});

test("aggregate callbacks add/remove changed rows and initialize empty groups", () => {
  const total = sum();
  const ctx = new Proxy({}, { get() { throw new Error("aggregate should not access context"); } }) as Context;
  assert.equal(total.compute(ctx, { initialize: true, group: "a", previous: null, changes: [] }), 0);
  assert.equal(total.compute(ctx, { initialize: true, group: "a", previous: null,
    changes: [{ key: "1", new: { shop: "a", cents: 10 } }, { key: "2", new: { shop: "a", cents: 20 } }] }), 30);
  assert.equal(total.compute(ctx, { initialize: false, group: "a", previous: 30,
    changes: [{ key: "1", old: { shop: "a", cents: 10 }, new: { shop: "a", cents: 15 } }, { key: "2", old: { shop: "a", cents: 20 } }] }), 15);
});

test("reducers capture callbacks and expose row identity and group to each callback", () => {
  const calls: unknown[] = [];
  const options = { source: orders, index: "shop", initial: (group: unknown) => { calls.push(["initial", group]); return 0; },
    add: (value: number, row: { cents: number }, key: string, group: unknown) => { calls.push(["add", key, group]); return value + row.cents; },
    remove: (value: number, row: { cents: number }, key: string, group: unknown) => { calls.push(["remove", key, group]); return value - row.cents; } };
  const total = aggregate("sum", options);
  options.initial = () => 100;
  assert.equal(total.compute({} as Context, { initialize: true, group: "a", previous: null,
    changes: [{ key: "k", old: { cents: 3 }, new: { cents: 5 } }] }), 2);
  assert.deepEqual(calls, [["initial", "a"], ["remove", "k", "a"], ["add", "k", "a"]]);
});

test("collection and reducer metadata reject accessors without invoking them", () => {
  let invoked = false;
  const invalid = { get name() { invoked = true; return "orders"; }, kind: "collection", indexes: {} };
  assert.throws(() => collectionManifest([invalid]), /collection references/);
  assert.equal(invoked, false);
  assert.throws(() => normalizeAggregateMetadata({ collection: "orders", get fields() { invoked = true; return ["shop"]; } }), /data properties/);
  assert.equal(invoked, false);
  for (const value of [null, [], { collection: "orders", fields: [] }, { collection: "orders", fields: ["shop", "shop"] }, { collection: "orders", fields: ["shop"], extra: true }]) {
    assert.throws(() => normalizeAggregateMetadata(value), TypeError);
  }
  assert.throws(() => collectionManifest([orders, orders]), /Duplicate collection/);
  assert.throws(() => aggregate("bad", { source: orders, index: "missing", initial: () => 0, add: (v) => v, remove: (v) => v }), /Unknown aggregate index/);
});

test("ordered range references snapshot scalar options and reject ambiguous bounds", () => {
  const source = collection<{ tenant: string; due: number }>("timers").index("due", ["tenant", "due"]);
  const prefix = ["a"];
  const range = source.by("due").range({ prefix, gte: -0, lt: 30, limit: 4 });
  prefix[0] = "other";
  assert.deepEqual(range, {kind:"range",collection:"timers",fields:["tenant","due"],options:{prefix:["a"],gte:0,lt:30,limit:4}});
  assert.ok(Object.isFrozen(range.options));
  assert.ok(Object.isFrozen(range.options.prefix));
  for(const options of [null,{}, {limit:0},{limit:1.5},{limit:Infinity},{limit:1,extra:true},{limit:1,prefix:["a",1,2]},
    {limit:1,prefix:["a",1],gte:0},{limit:1,gt:1,gte:2},{limit:1,lt:2,lte:2},{limit:1,prefix:[NaN]},
    {limit:1,prefix:[{}]},{limit:1,after:null},{limit:1,reverse:1}]) assert.throws(()=>source.by("due").range(options as any),TypeError);
  let invoked=false;
  assert.throws(()=>source.by("due").range({limit:1,get prefix(){invoked=true;return [];}}),/data properties/);
  assert.equal(invoked,false);
  const accessor = ["a"];
  Object.defineProperty(accessor,"0",{get(){invoked=true;return "a";}});
  assert.throws(()=>source.by("due").range({limit:1,prefix:accessor}),/accessor/);
  assert.equal(invoked,false);
});
