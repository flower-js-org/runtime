import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { buildBundle } from "./bundle.ts";
import { canonicalJson } from "./index.ts";

const bundle = await buildBundle(new URL("../examples/goblin-pizza.ts", import.meta.url).pathname);
const engine = readFileSync(new URL("../runtime/engine.js", import.meta.url), "utf8");
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const tenant = "tenant-0";
const shop = (index: number, owner = tenant): [string, string] => [owner, `store-${index}`];
const key = (id: string, index = 0, owner = tenant): string => canonicalJson([owner, `store-${index}`, id]);
const cell = (name: string, args: unknown): string => `cell:${canonicalJson([name, args])}`;

// Exercise the actual bundled application against Flower's reactive engine.
// Only the commit loop and trusted clock are simulated; failed evaluations
// never install their staged writes, just as in the HTTP/Raft service.
function kitchen(options: { tenants?: string[]; shops?: number; stockPerShop?: number; bakeMs?: number; leaseMs?: number } = {}) {
  const sandbox = createContext(Object.create(null));
  runInContext(bundle.javascript, sandbox, { timeout: 1_000 });
  runInContext(engine, sandbox, { timeout: 1_000 });
  const module = sandbox.__flowerBundle.default;
  let data: Record<string, any> = {};
  let sequence = 0;
  let time = 1_000;
  let evaluated: string[] = [];
  function evaluateDerived(name: string, args: any, ctx: any) {
    const definition = module.definitions[name];
    if (!definition.aggregate) return definition.compute(ctx, args);
    // Independent reference path: rebuild from a keyed scan every time instead
    // of sharing the production Rust index/delta implementation under test.
    const { collection, fields } = definition.aggregate;
    const changes = ctx.scan({ kind: "collection", name: collection })
      .filter(({ value }: any) => fields.every((field: string, position: number) =>
        Object.hasOwn(value, field) && canonicalJson(value[field]) === canonicalJson(fields.length === 1 ? args : args[position])))
      .map(({ key, value }: any) => ({ key, new: value }));
    return definition.compute(undefined, { initialize: true, group: args, previous: null, changes });
  }
  function invoke(kind: "query" | "mutation", name: string, args: unknown) {
    const before = JSON.stringify(data);
    let output;
    try {
      output = plain(sandbox.flowerInvoke(data, { kind, name, args, requestId: `pizza-test-${sequence++}` },
        (method: string, input: unknown, ctx: unknown) => module.definitions[method].compute(ctx, input),
        evaluateDerived, time));
    } finally {
      assert.equal(JSON.stringify(data), before, "evaluation must preserve its input snapshot");
    }
    data = { ...data, ...output.puts };
    for (const key of output.deletes) delete data[key];
    evaluated = output.evaluated;
    return output;
  }
  const db = {
    get data() { return plain(data); },
    get manifest() { return module; },
    get evaluated() { return [...evaluated]; },
    get time() { return time; },
    set time(value: number) { time = value; },
    call(alias: string, args: unknown = alias === "pizza.dashboard" ? { tenant } : null) {
      const method = module.http[alias];
      assert.ok(method, `No public method ${alias}`);
      return invoke(method.kind, method.name, args).value;
    },
    maintenance() { return invoke("mutation", module.maintenance.name, null); },
  };
  db.call("pizza.setup", { tenants: options.tenants ?? [tenant], storesPerTenant: options.shops ?? 2, stockPerShop: options.stockPerShop ?? 100, bakeMs: options.bakeMs ?? 50, leaseMs: options.leaseMs ?? 100 });
  return db;
}

test("goblin ovens run at their deadline and deliveries update reactive accounting atomically", () => {
  const db = kitchen();
  const order = db.call("pizza.order", { id: "pepperoni", shop: shop(0), quantity: 3 });
  assert.equal(order.status, "baking");
  assert.equal(order.createdAt, 1_000);
  assert.equal(order.dueAt, 1_050);
  let world = db.call("pizza.world");
  assert.equal(world.timers[0].dueAt, 1_050);
  assert.equal(world.jobs.length, 0);
  assert.deepEqual({ stock: world.summaries[0].stock, baking: world.summaries[0].baking, quantity: world.summaries[0].orderedQuantity }, { stock: 97, baking: 1, quantity: 3 });
  db.time = 1_049;
  assert.equal(db.maintenance().value, null);
  assert.equal(db.call("pizza.claim", { tenant, owner: "drone-1" }), null);
  db.time = 1_050;
  assert.deepEqual(db.maintenance().value, { id: `bake:${key("pepperoni")}`, $flower: { continue: false } });
  const claim = db.call("pizza.claim", { tenant, owner: "drone-1" });
  assert.deepEqual(claim.payload, { orderId: "pepperoni", shop: shop(0), quantity: 3 });
  const delivered = db.call("pizza.deliver", { tenant, id: claim.id, owner: claim.owner, token: claim.token });
  assert.equal(delivered.deliveredAt, 1_050);
  assert.ok(delivered.readyAt >= delivered.dueAt);
  world = db.call("pizza.world");
  assert.equal(world.timers.length, 0);
  assert.equal(world.jobs[0].state, "completed");
  assert.equal(world.jobs[0].result.deliveredAt, delivered.deliveredAt);
  assert.equal(world.summaries[0].revenue, 21);
  assert.equal(world.summaries[0].deliveredQuantity, 3);
  assert.equal(world.summaries[0].ready, 0);
  assert.equal(world.summaries[0].baking, 0);
  assert.deepEqual(world.leaderboards[tenant][0].id, shop(0));
  const materialized = db.data[cell("pizza.shopSummary", shop(0))];
  assert.deepEqual(materialized.outcome.value, world.summaries[0], "materialized summary tracks completed delivery");
});

test("invalid orders, duplicate IDs, and exhausted dough leave no partial stock or timers", () => {
  const db = kitchen({ stockPerShop: 3 });
  db.call("pizza.order", { id: "last-pizza", shop: shop(0), quantity: 3 });
  for (const args of [
    { id: "last-pizza", shop: shop(0), quantity: 1 },
    { id: "too-many", shop: shop(0), quantity: 1 },
    { id: "bad-count", shop: shop(1), quantity: 0 },
    { id: "bad-count", shop: shop(1), quantity: 1.5 },
    { id: "bad-count", shop: shop(1), quantity: 5 },
    { id: "bad-shop", shop: shop(9), quantity: 1 },
    { id: "has spaces", shop: shop(1), quantity: 1 },
    { id: "extra", shop: shop(1), quantity: 1, discount: 100 },
    null,
  ]) {
    const before = db.data;
    assert.throws(() => db.call("pizza.order", args));
    assert.deepEqual(db.data, before);
  }
  const world = db.call("pizza.world");
  assert.equal(world.orders.length, 1);
  assert.equal(world.timers.length, 1);
  assert.equal(world.shops[0].stock, 0);
  assert.equal(world.shops[1].stock, 3);
});

test("abandoned drones lose their lease and fencing rejects stale and repeated deliveries", () => {
  const db = kitchen({ bakeMs: 0, leaseMs: 20 });
  db.call("pizza.order", { id: "mushroom", shop: shop(0), quantity: 2 });
  db.maintenance();
  const first = db.call("pizza.claim", { tenant, owner: "sleepy-drone" });
  assert.equal(first.expiresAt, 1_020);
  db.time = 1_019;
  assert.equal(db.call("pizza.claim", { tenant, owner: "rescue-drone" }), null);
  db.time = 1_020;
  const second = db.call("pizza.claim", { tenant, owner: "rescue-drone" });
  assert.equal(second.id, first.id);
  assert.equal(second.attempt, 2);
  assert.ok(second.token > first.token);
  let before = db.data;
  assert.throws(() => db.call("pizza.deliver", { tenant, id: first.id, owner: first.owner, token: first.token }), (error: any) => error.code === "LEASE_LOST");
  assert.deepEqual(db.data, before);
  const identity = { tenant, id: second.id, owner: second.owner, token: second.token };
  db.call("pizza.deliver", identity);
  before = db.data;
  assert.throws(() => db.call("pizza.deliver", identity), (error: any) => error.code === "LEASE_LOST");
  assert.deepEqual(db.data, before);
  const world = db.call("pizza.world");
  assert.equal(world.shops[0].revenue, 14);
  assert.equal(world.summaries[0].delivered, 1);
  assert.equal(world.jobs[0].attempts, 2);
});

test("tips and order transitions propagate through per-shop summaries into the leaderboard", () => {
  const db = kitchen({ shops: 3, bakeMs: 0 });
  for (let index = 0; index < 9; index++) {
    db.call("pizza.order", { id: `pizza-${index}`, shop: shop(index % 3), quantity: index % 4 + 1 });
    db.maintenance();
    const claim = db.call("pizza.claim", { tenant, owner: `drone-${index}` });
    db.call("pizza.deliver", { tenant, id: claim.id, owner: claim.owner, token: claim.token });
  }
  db.call("pizza.tip", { shop: shop(1), amount: 100 });
  db.call("pizza.tip", { shop: shop(1), amount: 13 });
  const world = db.call("pizza.world");
  const expected = world.shops.map((shop: any) => {
    const orders = world.orders.filter((order: any) => canonicalJson(order.shop) === canonicalJson(shop.id));
    const quantity = orders.reduce((sum: number, order: any) => sum + order.quantity, 0);
    assert.equal(shop.initialStock - shop.stock, quantity);
    assert.equal(shop.revenue, quantity * world.config.unitPrice);
    return { ...shop, orders: orders.length, baking: 0, ready: 0, delivered: orders.length, orderedQuantity: quantity, deliveredQuantity: quantity };
  });
  assert.deepEqual(world.summaries, expected);
  expected.sort((a: any, b: any) => (b.revenue + b.tips) - (a.revenue + a.tips) || a.key.localeCompare(b.key));
  assert.deepEqual(world.leaderboards[tenant], expected);
  assert.deepEqual(world.leaderboards[tenant][0].id, shop(1));
  assert.equal(world.leaderboards[tenant][0].tips, 113);
  assert.deepEqual(db.call("pizza.shop", shop(2)), world.summaries[2]);
});

test("tips reuse order statistics while order creation, baking, and delivery refresh them", () => {
  const db = kitchen();
  const stats = cell("pizza.orderStats", shop(0));
  assert.ok(db.evaluated.includes(stats), "setup retains the order-statistics dependency");
  db.call("pizza.order", { id: "cached-mushroom", shop: shop(0), quantity: 2 });
  assert.ok(db.evaluated.includes(stats), "new orders refresh order statistics");
  const before = db.data[stats];
  db.time += 1;
  db.call("pizza.tip", { shop: shop(0), amount: 11 });
  assert.deepEqual(db.evaluated.sort(), [
    cell("pizza.shopSummary", shop(0)),
  ], "a tip recomputes its accounting summary without rescanning orders or sorting rankings");
  assert.deepEqual(db.data[stats], before);
  assert.deepEqual(before.deps, ['collection:"pizza.orders"']);
  assert.equal(db.call("pizza.shop", shop(0)).tips, 11);

  db.time = 1_050;
  db.maintenance();
  assert.ok(db.evaluated.includes(stats), "baking refreshes order status totals");
  assert.equal(db.data[stats].outcome.value.ready, 1);
  const claim = db.call("pizza.claim", { tenant, owner: "stats-drone" });
  assert.ok(!db.evaluated.includes(stats), "leasing work leaves order statistics unchanged");
  db.call("pizza.deliver", { tenant, id: claim.id, owner: claim.owner, token: claim.token });
  assert.ok(db.evaluated.includes(stats), "delivery refreshes order statistics");
  assert.deepEqual(db.data[stats].outcome.value, {
    orders: 1, baking: 0, ready: 0, delivered: 1, orderedQuantity: 2, deliveredQuantity: 2,
  });
  const summary = db.call("pizza.shop", shop(0));
  assert.equal(summary.revenue, 14);
  assert.equal(summary.tips, 11);
});

test("rankings compute from current summaries on read without entering durable state", () => {
  const db = kitchen({ shops: 3 });
  const ranking = cell("pizza.leaderboard", tenant);
  assert.equal(Object.hasOwn(db.data, ranking), false);
  assert.equal(Object.hasOwn(db.data, ranking.replace(/^cell:/, "root:")), false);
  let world = db.call("pizza.world");
  assert.deepEqual(world.leaderboards[tenant].map((row: any) => row.id), [shop(0), shop(1), shop(2)]);
  for (const [index, amount] of [[2, 9], [1, 15], [0, 21]]) {
    db.call("pizza.tip", { shop: shop(index), amount });
    assert.deepEqual(db.evaluated, [cell("pizza.shopSummary", shop(index))]);
    const before = db.data;
    world = db.call("pizza.world");
    assert.deepEqual(world.leaderboards[tenant][0].id, shop(index));
    const board = db.call("pizza.dashboard");
    assert.equal(board.leaderboard[0], canonicalJson(shop(index)));
    assert.equal(board.summaries[board.leaderboard[0]].tips, amount);
    assert.deepEqual(db.data, before, "observing a ranking must not install a durable cell or root");
    assert.equal(Object.hasOwn(db.data, ranking), false);
  }
});

test("setup and lease policy are enforced, and only explicit business aliases are exposed", () => {
  const db = kitchen({ leaseMs: 10 });
  const before = db.data;
  assert.throws(() => db.call("pizza.setup", { tenants: [tenant], storesPerTenant: 1, stockPerShop: 1, bakeMs: 0, leaseMs: 10 }), /already open/);
  assert.throws(() => db.call("pizza.claim", { tenant, owner: "drone", leaseMs: 11 }), /Lease duration/);
  assert.throws(() => db.call("pizza.claim", { tenant, owner: "drone", leaseMs: 0 }), /Lease duration/);
  assert.throws(() => db.call("pizza.tip", { shop: shop(0), amount: -1 }), /Tip/);
  assert.throws(() => db.call("pizza.world", {}), /takes null/);
  assert.deepEqual(db.data, before);
  assert.deepEqual(Object.keys(db.manifest.http).sort(), ["pizza.claim", "pizza.dashboard", "pizza.deliver", "pizza.order", "pizza.setup", "pizza.shop", "pizza.shop.local", "pizza.tip", "pizza.world"]);
  assert.equal(db.manifest.maintenance.name, "internal.scheduler.pizza.ovens.run");
  assert.equal(Object.hasOwn(db.manifest.http, "internal.pizza.finishBaking"), false);
  assert.equal(Object.hasOwn(db.manifest.http, "pizza.shopSummary"), false);
  assert.equal(Object.hasOwn(db.manifest.http, "pizza.orderStats"), false);
  for (const options of [{ shops: 0 }, { tenants: [] }, { tenants: [tenant, tenant] }, { stockPerShop: 0 }, { bakeMs: -1 }, { leaseMs: 60_001 }]) {
    assert.throws(() => kitchen(options));
  }
});

test("only observational pizza methods opt into replica-local reads", () => {
  const db = kitchen();
  for (const alias of ["pizza.shop.local", "pizza.dashboard"]) {
    const method = db.manifest.http[alias];
    assert.equal(method.kind, "query");
    assert.equal(method.consistency, "replica-local");
    assert.equal(db.manifest.definitions[method.name].consistency, "replica-local");
  }
  for (const alias of ["pizza.shop", "pizza.world", "pizza.setup", "pizza.order", "pizza.claim", "pizza.deliver", "pizza.tip"]) {
    assert.equal(Object.hasOwn(db.manifest.http[alias], "consistency"), false);
  }
  assert.equal(db.manifest.definitions[db.manifest.http["pizza.shop.local"].name].compute,
    db.manifest.definitions[db.manifest.http["pizza.shop"].name].compute);
  db.call("pizza.tip", { shop: shop(0), amount: 17 });
  assert.deepEqual(db.call("pizza.shop.local", shop(0)), db.call("pizza.shop", shop(0)),
    "both policies compute the same value from the same snapshot");
  const before = db.data;
  assert.throws(() => db.call("pizza.shop.local", "bad shop"), /Shop ID/);
  assert.throws(() => db.call("pizza.shop.local", shop(9)), /No goblin kitchen/);
  assert.deepEqual(db.data, before);
});

test("one dashboard value joins lifecycle records with stable keys and whole-world totals", () => {
  const db = kitchen({ bakeMs: 0 });
  db.call("pizza.order", { id: "dashboard-pizza", shop: shop(0), quantity: 2 });
  let board = db.call("pizza.dashboard");
  assert.equal(board.orders[key("dashboard-pizza")].status, "baking");
  assert.equal(board.timers[`bake:${key("dashboard-pizza")}`].handler, "bake");
  assert.deepEqual(board.totals, { orders: 1, baking: 1, ready: 0, delivered: 0, pizzas: 0, revenue: 0, tips: 0 });
  const before = db.data;
  assert.throws(() => db.call("pizza.dashboard", { raw: true }), /unsupported property/);
  assert.deepEqual(db.data, before);
  db.maintenance();
  const claim = db.call("pizza.claim", { tenant, owner: "dashboard-drone" });
  board = db.call("pizza.dashboard");
  assert.equal(board.jobs[claim.id].lease.token, claim.token);
  assert.equal(board.jobs[claim.id].lease.owner, "dashboard-drone");
  assert.deepEqual(board.timers, {});
  db.call("pizza.deliver", { tenant, id: claim.id, owner: claim.owner, token: claim.token });
  db.call("pizza.tip", { shop: shop(0), amount: 3 });
  board = db.call("pizza.dashboard");
  assert.equal(board.orders[claim.id].status, "delivered");
  assert.equal(board.jobs[claim.id].state, "completed");
  assert.deepEqual(board.totals, { orders: 1, baking: 0, ready: 0, delivered: 1, pizzas: 2, revenue: 14, tips: 3 });
  assert.deepEqual(board.summaries[canonicalJson(shop(0))], db.call("pizza.shop", shop(0)));
  db.time += 1;
  assert.deepEqual(db.call("pizza.dashboard"), board, "local countdowns do not force clock-only snapshots");
});

test("dashboard detail stays bounded while totals retain orders outside its recent window", () => {
  const db = kitchen({ stockPerShop: 1000, bakeMs: 60_000 });
  for (let index = 0; index < 121; index++) {
    db.time++;
    db.call("pizza.order", { id: `recent-${index}`, shop: shop(0), quantity: 1 });
  }
  const board = db.call("pizza.dashboard");
  assert.equal(Object.keys(board.orders).length, 120);
  assert.equal(Object.keys(board.timers).length, 120);
  assert.equal(Object.hasOwn(board.orders, key("recent-0")), false);
  assert.equal(Object.hasOwn(board.orders, key("recent-120")), true);
  assert.equal(board.totals.orders, 121);
  assert.equal(board.summaries[canonicalJson(shop(0))].orders, 121);
});

test("tenants reuse store and order IDs while queues, timers, queries, and accounting remain isolated", () => {
  const other = "tenant-1";
  const db = kitchen({ tenants: [tenant, other], shops: 2, bakeMs: 0 });
  const refs = [shop(0), shop(1), shop(0, other)];
  const placed = refs.map((ref) => db.call("pizza.order", { id: "same-order", shop: ref, quantity: 2 }));
  assert.equal(new Set(placed.map((order) => order.key)).size, 3);
  let world = db.call("pizza.world");
  assert.equal(world.orders.length, 3);
  assert.equal(new Set(world.timers.map((timer: any) => timer.id)).size, 3);
  for (let index = 0; index < 3; index++) db.maintenance();
  const first = db.call("pizza.claim", { tenant, owner: "same-worker" });
  const isolated = db.call("pizza.claim", { tenant: other, owner: "same-worker" });
  assert.equal(first.payload.shop[0], tenant);
  assert.equal(isolated.payload.shop[0], other);
  assert.notEqual(first.id, isolated.id);
  const beforeWrongTenant = db.data;
  assert.throws(() => db.call("pizza.deliver", { tenant, id: isolated.id, owner: isolated.owner, token: isolated.token }),
    (error: any) => error.code === "LEASE_LOST");
  assert.deepEqual(db.data, beforeWrongTenant);
  db.call("pizza.deliver", { tenant: other, id: isolated.id, owner: isolated.owner, token: isolated.token });
  assert.equal(db.call("pizza.claim", { tenant: other, owner: "same-worker" }), null,
    "a tenant with no work must not claim another tenant's pending order");
  const another = db.call("pizza.claim", { tenant, owner: "another-worker" });
  assert.equal(another.payload.shop[0], tenant);
  assert.notEqual(another.id, first.id);
  db.call("pizza.tip", { shop: shop(0, other), amount: 19 });
  assert.deepEqual(db.evaluated, [cell("pizza.shopSummary", shop(0, other))]);
  assert.ok(!db.evaluated.includes(cell("pizza.leaderboard", tenant)), "tips do not fan out across tenant leaderboards");
  const a = db.call("pizza.dashboard", { tenant });
  const b = db.call("pizza.dashboard", { tenant: other });
  assert.equal(a.totals.orders, 2);
  assert.equal(a.totals.revenue, 0);
  assert.equal(a.totals.tips, 0);
  assert.equal(b.totals.orders, 1);
  assert.equal(b.totals.revenue, 14);
  assert.equal(b.totals.tips, 19);
  for (const [owner, board] of [[tenant, a], [other, b]] as const) {
    assert.ok(Object.values(board.summaries).every((value: any) => value.id[0] === owner));
    assert.ok(Object.values(board.orders).every((value: any) => value.shop[0] === owner));
    assert.ok(Object.values(board.jobs).every((value: any) => value.payload.shop[0] === owner));
    assert.ok(board.config.shopIds.every((ref: string[]) => ref[0] === owner));
  }
  assert.deepEqual(db.call("pizza.shop.local", shop(0, other)), b.summaries[canonicalJson(shop(0, other))]);
  assert.throws(() => db.call("pizza.dashboard", { tenant: "missing" }), (error: any) => error.code === "TENANT_NOT_FOUND");
  assert.throws(() => db.call("pizza.claim", { tenant: "missing", owner: "worker" }), (error: any) => error.code === "TENANT_NOT_FOUND");
  world = db.call("pizza.world");
  assert.equal(world.shops.length, 4);
  assert.equal(world.orders.length, 3);
  assert.deepEqual(Object.keys(world.leaderboards), [tenant, other]);
});
