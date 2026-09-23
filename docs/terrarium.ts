import { canonicalJson, collection, define, derive, mutation, query } from "@flower-js/sdk";
import { scheduler } from "@flower-js/sdk/scheduler";

type Seed = { garden: string; id: string };
const GARDEN_SIZE = 12;
const flowers = collection<Seed & { plantedAt: number; bloomed: boolean }>("flowers")
  .index("garden", ["garden"]);

const garden = derive("garden", (ctx, id: string) => {
  const rows = ctx.query(flowers.by("garden").eq(id));
  return {
    spacesLeft: GARDEN_SIZE - rows.length,
    blooming: rows.filter(flower => flower.bloomed).length,
    flowers: Object.fromEntries(rows.map(flower =>
      [flower.id, flower.bloomed ? "🌼" : "🌱"])),
  };
});
const view = query("view", (ctx, id: string) => ctx.get(garden, id),
  { consistency: "replica-local" });

type Season = { key: string; plantedAt: number };
const bloom = mutation("internal.bloom", (ctx, event: Season) => {
  const flower = ctx.get(flowers, event.key);
  if (flower?.plantedAt === event.plantedAt) {
    ctx.set(flowers, event.key, { ...flower, bloomed: true });
  }
  return null;
});
const perish = mutation("internal.perish", (ctx, event: Season) => {
  if (ctx.get(flowers, event.key)?.plantedAt === event.plantedAt) {
    ctx.delete(flowers, event.key);
  }
  return null;
});
const seasons = scheduler("seasons", { bloom, perish });

const plant = mutation("plant", (ctx, seed: Seed) => {
  if (!seed || ![seed.garden, seed.id].every(v => typeof v === "string" && v)) {
    throw new Error("Give your garden and seed a name.");
  }
  const key = canonicalJson([seed.garden, seed.id]);
  if (ctx.get(flowers, key)) throw new Error("That spot is already planted.");
  if (ctx.query(flowers.by("garden").eq(seed.garden)).length >= GARDEN_SIZE) {
    throw new Error("Garden full! Wait for a flower to make room.");
  }
  const plantedAt = ctx.now();
  ctx.set(flowers, key, { garden: seed.garden, id: seed.id, plantedAt, bloomed: false });
  const event = { key, plantedAt }; // An old timer cannot affect a replacement.
  seasons.at(ctx, `bloom:${key}`, plantedAt + 5_000, "bloom", event);
  seasons.at(ctx, `perish:${key}`, plantedAt + 35_000, "perish", event);
  ctx.materialize(garden, seed.garden);
  return { planted: seed.id };
});

export default define({
  collections: [flowers, seasons.records],
  definitions: [garden, bloom, perish],
  maintenance: seasons.maintenance,
  http: { "garden.plant": plant, "garden.view": view },
});
