// Build the application with the gateway's public key compiled in, and deploy it.
//   FLOWER_URL (default http://127.0.0.1:7101), FLOWER_ADMIN_TOKEN, FLOWER_PARTITION for a named partition,
//   TRINITY_AUTH_KEY (default .dev/auth.pem, created on first use).
// Under `node --watch-path=app`, it deploys again whenever the application changes.
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadSigningKey, publicKeyPem } from "../workers/auth.ts";
import { deployApp } from "../workers/deploy.ts";

const root = new URL("..", import.meta.url).pathname;
const adminToken = process.env.FLOWER_ADMIN_TOKEN;
if (!adminToken) throw new Error("Set FLOWER_ADMIN_TOKEN");
const keyPath = process.env.TRINITY_AUTH_KEY ?? join(root, ".dev", "auth.pem");
const key = await loadSigningKey(keyPath, process.env.TRINITY_AUTH_KEY === undefined);

const options = {
  flowerUrl: process.env.FLOWER_URL ?? "http://127.0.0.1:7101",
  adminToken,
  publicKeyPem: publicKeyPem(key),
  directory: join(root, ".dev", "build"),
  ...(process.env.FLOWER_PARTITION ? { partition: process.env.FLOWER_PARTITION } : {}),
};

// A freshly elected leader can refuse writes for a moment.
for (let attempt = 1; ; attempt++) {
  try {
    const deployed = await deployApp(options);
    console.log(`deployed ${deployed.hash.slice(0, 12)} at revision ${deployed.revision}`);
    break;
  } catch (error) {
    if (attempt === 30) throw error;
    await delay(1_000);
  }
}
