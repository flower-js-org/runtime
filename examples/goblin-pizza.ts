import { aggregate, canonicalJson, collection, define, derive, mutation, query } from "../sdk/index.ts";
import type { Context } from "../sdk/index.ts";
import { scheduler } from "../sdk/scheduler.ts";
import { workQueue } from "../sdk/temporal.ts";
import type { LeaseIdentity } from "../sdk/temporal.ts";

// Goblins run the kitchens; drones carry the pizzas. Everything here, including
// oven timers, lease policy, stock accounting, and the leaderboard, is TypeScript.
// Money is an integer number of copper coins. Successful records stay available
// for the benchmark's independent audit; start a fresh database for each run.
export const UNIT_PRICE = 7;
export const MAX_LEASE_MS = 60_000;
export type ShopRef = [tenant: string, store: string];
export const shopKey = (shop: ShopRef): string => canonicalJson(shop);
export const orderKey = (shop: ShopRef, id: string): string => canonicalJson([...shop, id]);

export interface PizzaConfig {
  tenantIds: string[];
  shopIds: ShopRef[];
  storesPerTenant: number;
  initialStock: number;
  bakeMs: number;
  leaseMs: number;
  unitPrice: number;
}
export interface PizzaShop {
  id: ShopRef;
  key: string;
  name: string;
  initialStock: number;
  stock: number;
  revenue: number;
  tips: number;
}
export interface PizzaOrder {
  id: string;
  key: string;
  shop: ShopRef;
  quantity: number;
  status: "baking" | "ready" | "delivered";
  createdAt: number;
  dueAt: number;
  readyAt: number | null;
  deliveredAt: number | null;
}
export interface OrderStats {
  orders: number;
  baking: number;
  ready: number;
  delivered: number;
  orderedQuantity: number;
  deliveredQuantity: number;
}
export interface ShopSummary extends PizzaShop, OrderStats {}

export const configuration = collection<PizzaConfig>("pizza.config");
export const shops = collection<PizzaShop>("pizza.shops");
export const orders = collection<PizzaOrder>("pizza.orders").index("byShop", ["shop"]);
// Each tenant's workers seek only their own queue in one declared index. Composite identities are
// canonical JSON arrays, so separators in identifiers cannot cause collisions.
export const deliveriesFor = (tenant: string) => workQueue<{ orderId: string; shop: ShopRef; quantity: number }, { deliveredAt: number }>(
  "pizza.deliveries", { maxLeaseMs: MAX_LEASE_MS, scope: tenant },
);

function reject(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Arguments must be an object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Arguments must be a plain object");
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !fields.includes(key) || !("value" in property) || !property.enumerable) {
      throw new TypeError("Arguments contain an unsupported property");
    }
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(value)) {
    throw new TypeError(`${label} must be 1–96 letters, digits, underscores, or hyphens`);
  }
}

function config(ctx: Context): PizzaConfig {
  return ctx.get(configuration, "world") ?? reject("NOT_INITIALIZED", "The goblin kitchens are not open yet");
}

function shopIdentity(value: unknown): asserts value is ShopRef {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError("Shop ID must be [tenant, store]");
  identifier(value[0], "Tenant ID");
  identifier(value[1], "Store ID");
}

function tenantConfig(ctx: Context, tenant: unknown): PizzaConfig {
  identifier(tenant, "Tenant ID");
  return ctx.get(configuration, `tenant:${canonicalJson(tenant)}`)
    ?? reject("TENANT_NOT_FOUND", `No tenant named ${tenant}`);
}

function shopRecord(ctx: Context, id: unknown): PizzaShop {
  shopIdentity(id);
  return ctx.get(shops, shopKey(id)) ?? reject("SHOP_NOT_FOUND", `No goblin kitchen named ${canonicalJson(id)}`);
}

// Rust keeps a durable equality index and feeds only changed orders into these
// reversible reducers. A tip does not touch order totals; an order change costs
// one remove/add pair, regardless of how many pizzas the kitchen has sold.
function adjustOrders(total: OrderStats, order: PizzaOrder, direction: number): OrderStats {
  return {
    orders: total.orders + direction,
    baking: total.baking + direction * Number(order.status === "baking"),
    ready: total.ready + direction * Number(order.status === "ready"),
    delivered: total.delivered + direction * Number(order.status === "delivered"),
    orderedQuantity: total.orderedQuantity + direction * order.quantity,
    deliveredQuantity: total.deliveredQuantity + direction * (order.status === "delivered" ? order.quantity : 0),
  };
}
export const orderStats = aggregate("pizza.orderStats", {
  source: orders, index: "byShop",
  initial: (): OrderStats => ({ orders: 0, baking: 0, ready: 0, delivered: 0, orderedQuantity: 0, deliveredQuantity: 0 }),
  add: (total, order) => adjustOrders(total, order, 1),
  remove: (total, order) => adjustOrders(total, order, -1),
});

// Materialized once per kitchen, together with its order-statistics dependency.
// Source changes update summaries in the same transaction.
export const shopSummary = derive("pizza.shopSummary", (ctx, id: ShopRef): ShopSummary => ({
  ...shopRecord(ctx, id),
  ...ctx.get(orderStats, id),
}));

// Rankings are an observational projection of the snapshot's durable summaries.
// Computing them on read avoids sorting and replicating a whole tenant ranking
// for every tip. Watching the dashboard still sees a coherent ranking and totals.
export const leaderboard = derive("pizza.leaderboard", (ctx, tenant: string): ShopSummary[] =>
  tenantConfig(ctx, tenant).shopIds.map((id) => ctx.get(shopSummary, id)).sort((a, b) =>
    (b.revenue + b.tips) - (a.revenue + a.tips) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
);

// A private callback represents the oven bell. The status transition and queue
// insertion commit together; an interrupted attempt cannot publish half a pizza.
export const finishBaking = mutation("internal.pizza.finishBaking", (ctx, args: { id: string; shop: ShopRef }) => {
  const input = object(args, ["id", "shop"]);
  identifier(input.id, "Order ID");
  shopIdentity(input.shop);
  const key = orderKey(input.shop, input.id);
  const order = ctx.get(orders, key) ?? reject("ORDER_NOT_FOUND", "The oven lost its order");
  if (order.status !== "baking") return null;
  ctx.set(orders, key, { ...order, status: "ready", readyAt: ctx.now() });
  deliveriesFor(order.shop[0]).enqueue(ctx, key, { orderId: order.id, shop: order.shop, quantity: order.quantity });
  return null;
});

export const ovens = scheduler("pizza.ovens", { bake: finishBaking }, {
  maxAttempts: 3, retryDelayMs: 100, maxRetryDelayMs: 1_000,
});

export const setup = mutation("internal.pizza.setup", (ctx, args: {
  tenants: string[]; storesPerTenant: number; stockPerShop: number; bakeMs: number; leaseMs: number;
}): PizzaConfig => {
  const input = object(args, ["tenants", "storesPerTenant", "stockPerShop", "bakeMs", "leaseMs"]);
  if (!Array.isArray(input.tenants) || !input.tenants.length) throw new TypeError("tenants must be a nonempty array");
  for (const tenant of input.tenants) identifier(tenant, "Tenant ID");
  if (new Set(input.tenants).size !== input.tenants.length) throw new TypeError("Tenant IDs must be distinct");
  const tenantIds = input.tenants as string[];
  integer(input.storesPerTenant, "Stores per tenant", 1, Number.MAX_SAFE_INTEGER);
  integer(tenantIds.length * input.storesPerTenant, "Total store count", 1, Number.MAX_SAFE_INTEGER);
  integer(input.stockPerShop, "Stock per shop", 1, 1_000_000);
  integer(input.bakeMs, "Baking duration", 0, 60_000);
  integer(input.leaseMs, "Maximum lease duration", 1, MAX_LEASE_MS);
  if (ctx.get(configuration, "world") !== null) reject("ALREADY_INITIALIZED", "The kitchens are already open; use a fresh database for another run");
  const names = ["The Crispy Cauldron", "Mushroom Mayhem", "The Sizzling Slime", "Dough or Die", "The Goblin's Slice", "Dragon Breath Delivery"];
  const storesPerTenant = input.storesPerTenant;
  const shopIds: ShopRef[] = tenantIds.flatMap((tenant) => Array.from({ length: storesPerTenant }, (_, index): ShopRef => [tenant, `store-${index}`]));
  const settings: PizzaConfig = {
    tenantIds, shopIds, storesPerTenant, initialStock: input.stockPerShop, bakeMs: input.bakeMs, leaseMs: input.leaseMs, unitPrice: UNIT_PRICE,
  };
  ctx.set(configuration, "world", settings);
  for (const tenant of tenantIds) ctx.set(configuration, `tenant:${canonicalJson(tenant)}`, {
    ...settings, tenantIds: [tenant], shopIds: shopIds.filter(([owner]) => owner === tenant),
  });
  for (let index = 0; index < shopIds.length; index++) {
    const id = shopIds[index];
    const key = shopKey(id);
    ctx.set(shops, key, { id, key, name: `${names[index % names.length]} · ${id[1]}`, initialStock: input.stockPerShop, stock: input.stockPerShop, revenue: 0, tips: 0 });
    ctx.materialize(shopSummary, id);
  }
  return settings;
});

export const placeOrder = mutation("internal.pizza.order", (ctx, args: { id: string; shop: ShopRef; quantity: number }): PizzaOrder => {
  const input = object(args, ["id", "shop", "quantity"]);
  identifier(input.id, "Order ID");
  integer(input.quantity, "Pizza quantity", 1, 4);
  const shop = shopRecord(ctx, input.shop);
  const settings = tenantConfig(ctx, shop.id[0]);
  const key = orderKey(shop.id, input.id);
  if (ctx.get(orders, key) !== null) reject("ORDER_EXISTS", "That pizza order already exists in this store");
  if (shop.stock < input.quantity) reject("OUT_OF_STOCK", "The goblins have run out of enchanted dough");
  const order: PizzaOrder = {
    id: input.id, key, shop: shop.id, quantity: input.quantity, status: "baking",
    createdAt: ctx.now(), dueAt: ctx.now() + settings.bakeMs, readyAt: null, deliveredAt: null,
  };
  ctx.set(shops, shop.key, { ...shop, stock: shop.stock - order.quantity });
  ctx.set(orders, key, order);
  ovens.after(ctx, `bake:${key}`, settings.bakeMs, "bake", { id: order.id, shop: shop.id });
  return order;
});

export const claimDelivery = mutation("internal.pizza.claim", (ctx, args: { tenant: string; owner: string; leaseMs?: number }) => {
  const input = object(args, ["tenant", "owner", "leaseMs"]);
  identifier(input.owner, "Drone name");
  const settings = tenantConfig(ctx, input.tenant);
  const duration = input.leaseMs === undefined ? settings.leaseMs : input.leaseMs;
  integer(duration, "Lease duration", 1, settings.leaseMs);
  return deliveriesFor(input.tenant as string).claim(ctx, input.owner, duration);
});

export const deliverPizza = mutation("internal.pizza.deliver", (ctx, args: LeaseIdentity & { tenant: string }): PizzaOrder => {
  const input = object(args, ["tenant", "id", "owner", "token", "history"]);
  tenantConfig(ctx, input.tenant);
  if (typeof input.id !== "string") throw new TypeError("Delivery ID must be a composite order key");
  identifier(input.owner, "Drone name");
  integer(input.token, "Fencing token", 1, Number.MAX_SAFE_INTEGER);
  const identity: LeaseIdentity = { id: input.id, owner: input.owner, token: input.token, ...(input.history===undefined?{}:{history:input.history as LeaseIdentity["history"]}) };
  const deliveredAt = ctx.now();
  // Validate the lease before accounting. An expired/replaced drone cannot
  // collect coins; a failed transaction also discards this staged completion.
  const job = deliveriesFor(input.tenant as string).complete(ctx, identity, { deliveredAt });
  if (job.payload.shop[0] !== input.tenant || orderKey(job.payload.shop, job.payload.orderId) !== identity.id) reject("LEASE_LOST", "Delivery tenant and identity must match");
  const order = ctx.get(orders, identity.id) ?? reject("ORDER_NOT_FOUND", "This drone has no pizza");
  if (order.status !== "ready") reject("ORDER_NOT_READY", "Only a ready pizza can be delivered");
  const shop = shopRecord(ctx, order.shop);
  const delivered: PizzaOrder = { ...order, status: "delivered", deliveredAt };
  ctx.set(orders, order.key, delivered);
  ctx.set(shops, shop.key, { ...shop, revenue: shop.revenue + order.quantity * UNIT_PRICE });
  return delivered;
});

export const tipKitchen = mutation("internal.pizza.tip", (ctx, args: { shop: ShopRef; amount: number }) => {
  const input = object(args, ["shop", "amount"]);
  integer(input.amount, "Tip", 1, 1_000_000);
  const shop = shopRecord(ctx, input.shop);
  const tips = shop.tips + input.amount;
  integer(tips, "Total tips", 0, Number.MAX_SAFE_INTEGER - shop.initialStock * UNIT_PRICE);
  ctx.set(shops, shop.key, { ...shop, tips });
  return { shop: shop.id, tips };
});

export const inspectShop = query("internal.pizza.shop", (ctx, id: ShopRef) => {
  shopIdentity(id);
  return ctx.get(shopSummary, id);
});
// Browsing can use a replica's coherent applied snapshot without contacting the
// leader. This preview may lag; stock checks and money updates stay in mutations.
export const inspectShopLocal = query("internal.pizza.shop.local", inspectShop.compute,
  { consistency: "replica-local" });

// This deliberately public audit method returns raw business records as well as
// derived summaries, so a benchmark can independently verify every invariant.
export const inspectWorld = query("internal.pizza.world", (ctx, args: null) => {
  if (args !== null) throw new TypeError("pizza.world takes null");
  const settings = config(ctx);
  return {
    config: settings,
    shops: ctx.scan(shops).map((row) => row.value),
    orders: ctx.scan(orders).map((row) => row.value),
    jobs: settings.tenantIds.flatMap((tenant) => deliveriesFor(tenant).scan(ctx).map((row) => ({ ...row.value, id: row.key }))),
    timers: ovens.scan(ctx),
    summaries: settings.shopIds.map((id) => ctx.get(shopSummary, id)),
    leaderboards: Object.fromEntries(settings.tenantIds.map((tenant) => [tenant, ctx.get(leaderboard, tenant)])),
  };
});

// One public value drives the entire dashboard. Stable object keys let SSE
// patches address one order/job instead of shifting a table's array indexes.
// Keep the latest 120 orders on screen; summaries still cover the whole world.
// This observational view tolerates replication lag, including older code and
// aliases. Use pizza.world for a fresh audit; actions validate current state.
export const inspectDashboard = query("internal.pizza.dashboard", (ctx, args: { tenant: string }) => {
  const input = object(args, ["tenant"]);
  const settings = tenantConfig(ctx, input.tenant);
  const tenant = input.tenant as string;
  const tenantShops = settings.shopIds;
  const summaries = tenantShops.map((id) => ctx.get(shopSummary, id));
  const recent = tenantShops.flatMap((id) => ctx.query(orders.by("byShop").eq(id)))
    .sort((a, b) => b.createdAt - a.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, 120);
  const visible = new Set(recent.map(({ key }) => key));
  return {
    tenant, tenantIds: config(ctx).tenantIds,
    config: settings,
    summaries: Object.fromEntries(summaries.map((shop) => [shop.key, shop])),
    orders: Object.fromEntries(recent.map((order) => [order.key, order])),
    jobs: Object.fromEntries(deliveriesFor(tenant).scan(ctx).filter(({ key }) => visible.has(key))
      .map(({ key, value }) => [key, { ...value, id: key }])),
    timers: Object.fromEntries(ovens.scan(ctx).filter((timer) => timer.id.startsWith("bake:") && visible.has(timer.id.slice(5)))
      .map((timer) => [timer.id, timer])),
    leaderboard: ctx.get(leaderboard, tenant).map((shop) => shop.key),
    totals: summaries.reduce((total, shop) => ({
      orders: total.orders + shop.orders, baking: total.baking + shop.baking,
      ready: total.ready + shop.ready, delivered: total.delivered + shop.delivered,
      pizzas: total.pizzas + shop.deliveredQuantity, revenue: total.revenue + shop.revenue,
      tips: total.tips + shop.tips,
    }), { orders: 0, baking: 0, ready: 0, delivered: 0, pizzas: 0, revenue: 0, tips: 0 }),
  };
}, { consistency: "replica-local" });
export type PizzaDashboard = ReturnType<typeof inspectDashboard.compute>;

export default define({
  collections: [orders, ovens.records, deliveriesFor("").records],
  definitions: [orderStats, shopSummary, leaderboard],
  maintenance: ovens.maintenance,
  http: {
    "pizza.setup": setup,
    "pizza.order": placeOrder,
    "pizza.claim": claimDelivery,
    "pizza.deliver": deliverPizza,
    "pizza.tip": tipKitchen,
    "pizza.shop": inspectShop,
    "pizza.shop.local": inspectShopLocal,
    "pizza.world": inspectWorld,
    "pizza.dashboard": inspectDashboard,
  },
});
