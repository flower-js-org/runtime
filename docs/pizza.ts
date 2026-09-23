import { collection, define, derive, mutation, query } from "@flower-js/sdk";

const orders = collection<{ topping: string }>("orders");

const order = mutation("order", (ctx, args: { id: string; topping: string }) => {
  if (!args || typeof args.id !== "string" || !args.id ||
      typeof args.topping !== "string" || !args.topping) {
    throw new Error("An order ID and topping, please.");
  }
  if (ctx.get(orders, args.id)) throw new Error("Already ordered!");
  ctx.set(orders, args.id, { topping: args.topping });
  ctx.materialize(board, null);
  return { accepted: args.id };
});

const board = derive("board", (ctx, _args: null) => {
  const pizzas = ctx.scan(orders).map(({ value }) => value);
  return {
    orders: pizzas.length,
    mushroom: pizzas.filter(pizza => pizza.topping === "mushroom").length,
  };
});
const dashboard = query("dashboard", ctx => ctx.get(board, null));

export default define({
  definitions: [board],
  http: { "pizza.order": order, "pizza.board": dashboard },
});
