import { collection, define, derive, mutation, query } from "../sdk/index.ts";
import type { Context } from "../sdk/index.ts";

interface Order { shippingCents: number }
interface Line { orderId: string; quantity: number; unitCents: number }
interface CreateOrder { orderId: string; shippingCents: number; lines: { id: string; quantity: number; unitCents: number }[] }
interface UpdateLine { lineId: string; quantity: number }

export const orders = collection<Order>("orders");
export const lines = collection<Line>("orderLines").index("byOrder", ["orderId"]);

export const subtotal = derive("order.subtotal", (ctx, orderId: string) =>
  ctx.query(lines.by("byOrder").eq(orderId))
    .reduce((sum, line) => sum + line.quantity * line.unitCents, 0),
);

export const total = derive("order.total", (ctx, orderId: string) => {
  const order = ctx.get(orders, orderId);
  if (order === null) throw new Error(`Order ${orderId} does not exist`);
  return ctx.get(subtotal, orderId) + order.shippingCents;
});

function readOrder(ctx: Context, orderId: string) {
  const order = ctx.get(orders, orderId);
  if (order === null) throw new Error(`Order ${orderId} does not exist`);
  return { order, subtotal: ctx.get(subtotal, orderId), total: ctx.get(total, orderId) };
}

function nonnegativeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer`);
}

export const createOrder = mutation("internal.order.create", (ctx, args: CreateOrder) => {
  if (!args || typeof args.orderId !== "string" || !args.orderId) throw new Error("An orderId is required");
  nonnegativeInteger(args.shippingCents, "shippingCents");
  if (!Array.isArray(args.lines)) throw new Error("lines must be an array");
  if (ctx.get(orders, args.orderId)) throw new Error("Order already exists");
  ctx.set(orders, args.orderId, { shippingCents: args.shippingCents });
  for (const line of args.lines) {
    if (!line || typeof line.id !== "string" || !line.id) throw new Error("Every line requires an id");
    nonnegativeInteger(line.quantity, "quantity");
    nonnegativeInteger(line.unitCents, "unitCents");
    if (ctx.get(lines, line.id)) throw new Error(`Line ${line.id} already exists`);
    ctx.set(lines, line.id, { orderId: args.orderId, quantity: line.quantity, unitCents: line.unitCents });
  }
  ctx.materialize(total, args.orderId);
  return readOrder(ctx, args.orderId);
});

export const updateLine = mutation("internal.order.updateLine", (ctx, args: UpdateLine) => {
  if (!args || typeof args.lineId !== "string") throw new Error("A lineId is required");
  nonnegativeInteger(args.quantity, "quantity");
  const line = ctx.get(lines, args.lineId);
  if (line === null) throw new Error("Line does not exist");
  ctx.set(lines, args.lineId, { ...line, quantity: args.quantity });
  return readOrder(ctx, line.orderId);
});

export const updateShipping = mutation("internal.order.updateShipping", (ctx, args: { orderId: string; shippingCents: number }) => {
  if (!args || typeof args.orderId !== "string") throw new Error("An orderId is required");
  nonnegativeInteger(args.shippingCents, "shippingCents");
  if (ctx.get(orders, args.orderId) === null) throw new Error("Order does not exist");
  ctx.set(orders, args.orderId, { shippingCents: args.shippingCents });
  return readOrder(ctx, args.orderId);
});

export const getOrder = query("internal.order.read", (ctx, orderId: string) => readOrder(ctx, orderId));

// Registered for internal use, deliberately omitted from the HTTP allowlist.
export const privateReset = mutation("internal.order.reset", (ctx, orderId: string) => {
  ctx.unmaterialize(total, orderId);
  ctx.delete(orders, orderId);
  for (const line of ctx.scan(lines)) {
    if (line.value.orderId === orderId) ctx.delete(lines, line.key);
  }
  return null;
});

export default define({
  definitions: [subtotal, total, privateReset],
  http: {
    "order.create": createOrder,
    "order.updateLine": updateLine,
    "order.updateShipping": updateShipping,
    "order.get": getOrder,
  },
});
