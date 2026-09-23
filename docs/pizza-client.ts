import { FlowerClient } from "@flower-js/sdk";

const pizza = new FlowerClient("http://127.0.0.1:7101");
await pizza.mutate("pizza.order", {
  id: "first-pizza", topping: "mushroom",
}, { requestId: "first-pizza" }); // Keep this ID when retrying.

for await (const { value } of pizza.watch("pizza.board")) {
  console.log(value); // { orders: 1, mushroom: 1 }
}
