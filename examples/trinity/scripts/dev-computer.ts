// Development bootstrap: organization "dev" with user "dev" as its admin, and this machine as
// its default computer, running tools in TRINITY_WORKSPACE (default .dev/workspace).
// Sign in to the web client as "dev" and sessions can use tools straight away.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FlowerClient, FlowerError } from "@flower-js/sdk";
import type app from "../app/index.ts";
import { loadSigningKey, signToken } from "../workers/auth.ts";
import { blobStoreFromEnv } from "../workers/blobs.ts";
import { runLocalWorker } from "../workers/local.ts";

const root = new URL("..", import.meta.url).pathname;
const flowerUrl = process.env.FLOWER_URL ?? "http://127.0.0.1:7101";
const user = process.env.TRINITY_DEV_USER ?? "dev";
const org = process.env.TRINITY_DEV_ORG ?? "dev";
const computer = process.env.TRINITY_DEV_COMPUTER ?? "dev-computer";
const workspace = process.env.TRINITY_WORKSPACE ?? join(root, ".dev", "workspace");

const key = await loadSigningKey(process.env.TRINITY_AUTH_KEY ?? join(root, ".dev", "auth.pem"));
const as = (claims: Parameters<typeof signToken>[1]) =>
  new FlowerClient<typeof app>(flowerUrl, { credentials: { token: signToken(key, claims, 3_600) } });

const signedIn = as({ sub: user, role: "user" });
try {
  await signedIn.mutate("org.create", { id: org, name: "Development" }, { retry: true });
} catch (error) {
  if (!(error instanceof FlowerError && error.failure?.code === "ORG_EXISTS")) throw error;
}

const member = as({ sub: user, role: "user", org });
await member.mutate("computer.register", { id: computer, name: "This machine" }, { retry: true });
const { value: current } = await member.query("org.get");
if (current.org.settings.computer === null) await member.mutate("org.update", { settings: { computer } }, { retry: true });

await mkdir(workspace, { recursive: true });
console.log(`sign in as "${user}": organization ${org} runs tools on ${computer} in ${workspace}`);

const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
const computerToken = () => ({ token: signToken(key, { sub: `computer:${computer}`, role: "computer", computer, org }, 3_600) });
await runLocalWorker(new FlowerClient<typeof app>(flowerUrl, { credentials: computerToken }), {
  signal: stop.signal,
  computer,
  workspace,
  ...(process.env.TRINITY_BLOBS ? { blobs: blobStoreFromEnv() } : {}),
  onEvent: (event) => { if (event.type !== "waiting") console.log(JSON.stringify(event.type === "claimed" ? { claimed: event.job.id } : event)); },
});
