import { FlowerClient } from "@flower-js/sdk";

const terrarium = new FlowerClient("http://127.0.0.1:7101");
await terrarium.mutate("garden.plant", {
  garden: "moon-garden", id: "luna",
}, { requestId: "plant-moon-garden-luna" }); // Reuse this ID on retries.

for await (const { value } of terrarium.watch("garden.view", "moon-garden")) {
  console.log(value);
  // { spacesLeft: 11, blooming: 0, flowers: { luna: "🌱" } }
  // After 5s: a bloom. After 35s: an empty spot, ready for another seed.
}
