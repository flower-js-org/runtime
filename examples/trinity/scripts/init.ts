// Make the development Flower node a one-member cluster, once, and wait until it leads.
// Later runs find the membership already there and only wait.
//   FLOWER_URL (default http://127.0.0.1:7101), FLOWER_ADMIN_TOKEN.
import { setTimeout as delay } from "node:timers/promises";
import { FlowerAdmin } from "@flower-js/sdk";

const url = process.env.FLOWER_URL ?? "http://127.0.0.1:7101";
const adminToken = process.env.FLOWER_ADMIN_TOKEN;
if (!adminToken) throw new Error("Set FLOWER_ADMIN_TOKEN");

interface Metrics { state: string; membership_config?: { membership?: { configs?: number[][] } } }

async function metrics(): Promise<Metrics> {
  const response = await fetch(new URL("/raft/metrics", url), { headers: { authorization: `Bearer ${adminToken}` } });
  if (!response.ok) throw new Error(`/raft/metrics answered ${response.status}`);
  return response.json() as Promise<Metrics>;
}

if ((await metrics()).membership_config?.membership?.configs?.length === 0) {
  await new FlowerAdmin(url, { adminToken }).initialize({ 1: new URL(url).host });
  console.log(`initialized a one-member cluster at ${new URL(url).host}`);
}

for (let waited = 0; (await metrics()).state !== "Leader"; waited += 200) {
  if (waited > 30_000) throw new Error("The node did not become leader within 30 seconds");
  await delay(200);
}
console.log("flower is ready");
