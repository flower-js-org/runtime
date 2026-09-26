// The gateway: web client, token issuance, Slack connections, GitHub webhooks, uploads and downloads, and the
// public path to Flower's /v1 API. Configuration comes from the environment:
//   FLOWER_URL, TRINITY_AUTH_KEY (default .dev/auth.pem), PORT (default 8080),
//   TRINITY_BLOBS, TRINITY_DEV_LOGIN=1, TRINITY_WEB=dev to serve the web client from Vite's dev server instead of web/dist,
//   TRINITY_PUBLIC_URL, and SLACK_CLIENT_ID + SLACK_CLIENT_SECRET to install the Slack app from the web,
//   GITHUB_WEBHOOK_SECRET + GITHUB_BOT_LOGIN + TRINITY_GITHUB_OWNERS='{"acme-inc":"acme"}',
//   TRINITY_CELLS='{"acme":"cell-3"}' for organizations in named partitions.
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { ViteDevServer } from "vite";
import { loadSigningKey } from "../workers/auth.ts";
import { blobStoreFromEnv } from "../workers/blobs.ts";
import { createGateway } from "./server.ts";

const root = new URL("..", import.meta.url).pathname;
const env = process.env;
const webDir = join(root, "web");
const webDev = env.TRINITY_WEB === "dev";
let vite: ViteDevServer | undefined;
const server = createGateway({
  flowerUrl: env.FLOWER_URL ?? "http://127.0.0.1:7101",
  signingKey: await loadSigningKey(env.TRINITY_AUTH_KEY ?? join(root, ".dev", "auth.pem"), env.TRINITY_AUTH_KEY === undefined),
  ...(env.TRINITY_BLOBS ? { blobs: blobStoreFromEnv(env) } : {}),
  ...(webDev
    ? { webMiddleware: (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => vite!.middlewares(request, response, next) }
    : { webRoot: join(webDir, "dist") }),
  devLogin: env.TRINITY_DEV_LOGIN === "1",
  ...(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET ? { slack: { clientId: env.SLACK_CLIENT_ID, clientSecret: env.SLACK_CLIENT_SECRET } } : {}),
  ...(env.TRINITY_PUBLIC_URL ? { publicUrl: env.TRINITY_PUBLIC_URL } : {}),
  ...(env.TRINITY_CELLS ? { cells: JSON.parse(env.TRINITY_CELLS) } : {}),
  ...(env.GITHUB_WEBHOOK_SECRET ? { github: { secret: env.GITHUB_WEBHOOK_SECRET, botLogin: env.GITHUB_BOT_LOGIN ?? "trinity", owners: JSON.parse(env.TRINITY_GITHUB_OWNERS ?? "{}") } } : {}),
});
if (webDev) {
  // Hot updates travel over this server's own WebSocket upgrades, so the page needs no second port. The native
  // loader imports vite.config.ts as it is: the default bundles it to a temporary file, whose deletion restarts `node --watch`.
  const { createServer } = await import("vite");
  vite = await createServer({ root: webDir, appType: "spa", configLoader: "native", server: { middlewareMode: true, ws: { server } } });
} else if (!existsSync(join(webDir, "dist", "index.html"))) {
  console.error("The web client is not built: run `npm run build` (or set TRINITY_WEB=dev).");
}
const port = Number(env.PORT ?? 8080);
server.listen(port, env.HOST ?? "127.0.0.1", () => console.error(`trinity gateway on http://${env.HOST ?? "127.0.0.1"}:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void vite?.close(); server.close(() => process.exit(0)); });
