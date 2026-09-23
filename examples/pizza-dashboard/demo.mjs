#!/usr/bin/env node
// Development launcher: Rust/QuickJS runs the database; Node builds browser
// assets, owns a temporary cluster, and generates example customers/workers.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { LocalCluster } from "../../bench/cluster.mjs";
import { buildBundle } from "../../sdk/bundle.ts";
import { FlowerClient, FlowerError } from "../../sdk/client.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const maxOrders = 160;
const tenants = ["tenant-0", "tenant-1", "tenant-2"];
const storesPerTenant = 2;

export async function startPizzaDemo({ port = 0, binary, auto = true, signal } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("port must be 0..65535");
  const shutdown = new AbortController();
  const cluster = new LocalCluster({ nodes: 3, binary });
  const connections = new Set();
  const tasks = [];
  let server;
  let listening;
  let paused = !auto;
  let sequence = 0;
  let watchSequence = 0;
  let crash;
  let origin;
  let closing;
  const sleep = (ms) => delay(ms, undefined, { signal: shutdown.signal });
  async function mutate(name, args) {
    const requestId = randomUUID();
    const deadline = Date.now() + 12_000;
    let last;
    while (!shutdown.signal.aborted && Date.now() < deadline) {
      try {
        return await new FlowerClient(cluster.url).mutate(name, args, {
          requestId, signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(2_000)]),
        });
      } catch (error) {
        last = error;
        if (error instanceof FlowerError && error.status < 500) throw error;
        await cluster.discoverLeader({ timeoutMs: 2_000 }).catch(() => {});
        await sleep(50);
      }
    }
    throw last ?? shutdown.signal.reason ?? new Error("Mutation retry deadline exceeded");
  }
  async function order(shop) {
    if (sequence >= maxOrders) throw new Error(`This bounded demo has reached ${maxOrders} orders. Restart it for a fresh kitchen.`);
    const index = sequence++;
    return mutate("pizza.order", { id: `pizza-${String(index + 1).padStart(4, "0")}`,
      shop: shop ?? [tenants[index % tenants.length], `store-${Math.floor(index / tenants.length) % storesPerTenant}`], quantity: index % 3 + 1 });
  }
  async function json(request) {
    if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json") throw new Error("Use application/json");
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 4_096) throw new Error("Demo request exceeds 4 KiB");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  const reply = (response, status, value) => {
    if (!response.headersSent) response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      shutdown.abort(new Error("Pizza dashboard closed"));
      signal?.removeEventListener("abort", interrupted);
      // A listener can still be opening when shutdown arrives. Settle that
      // acquisition before collecting sockets and closing the owned server.
      await listening?.catch(() => {});
      for (const socket of connections) socket.destroy();
      if (server?.listening) await new Promise((done) => server.close(done));
      await cluster.close();
      await Promise.allSettled(tasks);
    })();
    return closing;
  }
  const interrupted = () => { void close(); };
  signal?.addEventListener("abort", interrupted, { once: true });
  try {
    if (signal?.aborted) { await close(); throw signal.reason; }
    const output = resolve(root, ".flower/pizza-dashboard");
    await mkdir(output, { recursive: true });
    shutdown.signal.throwIfAborted();
    await build({ entryPoints: [resolve(here, "app.ts")], bundle: true, format: "esm",
      platform: "browser", target: "es2022", outfile: resolve(output, "app.js"), sourcemap: true });
    shutdown.signal.throwIfAborted();
    const assets = new Map(await Promise.all([
      ["/", resolve(here, "index.html"), "text/html; charset=utf-8"],
      ["/style.css", resolve(here, "style.css"), "text/css; charset=utf-8"],
      ["/app.js", resolve(output, "app.js"), "text/javascript; charset=utf-8"],
    ].map(async ([path, file, type]) => [path, { type, body: await readFile(file) }])));
    shutdown.signal.throwIfAborted();
    await cluster.start();
    shutdown.signal.throwIfAborted();
    const bundle = await buildBundle(resolve(root, "examples/goblin-pizza.ts"), { initialization: "static" });
    shutdown.signal.throwIfAborted();
    await new FlowerClient(cluster.url, { adminToken: cluster.adminToken }).deploy(
      bundle, { signal: shutdown.signal });
    shutdown.signal.throwIfAborted();
    await mutate("pizza.setup", { tenants, storesPerTenant, stockPerShop: 1_000, bakeMs: 1_800, leaseMs: 4_000 });
    shutdown.signal.throwIfAborted();

    server = createServer((request, response) => {
      void (async () => {
        if (request.method === "GET" && assets.has(request.url)) {
          const asset = assets.get(request.url);
          response.writeHead(200, { "content-type": asset.type, "cache-control": "no-store",
            "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'" });
          response.end(request.url === "/" ? asset.body.toString("utf8").replace("</head>", `<meta name="pizza-demo-paused" content="${paused}"></head>`) : asset.body);
          return;
        }
        if (request.method !== "POST" || !["/v1/watch", "/demo/action"].includes(request.url)) {
          reply(response, 404, { error: "Unknown demo route" }); return;
        }
        if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) {
          reply(response, 403, { error: "Use the dashboard's local origin" }); return;
        }
        const input = await json(request);
        if (request.url === "/v1/watch") {
          if (input?.name !== "pizza.dashboard" || !input.args || Array.isArray(input.args) ||
              Object.keys(input.args).length !== 1 || !tenants.includes(input.args.tenant) ||
              Object.keys(input).some((key) => !["name", "args"].includes(key))) {
            reply(response, 400, { error: "This demo watches only pizza.dashboard({tenant}) for its configured tenants" }); return;
          }
          const controller = new AbortController();
          const disconnect = () => controller.abort(new Error("Dashboard disconnected"));
          response.once("close", disconnect);
          try {
            // Spread independent streams across replicas. A stream stays on its
            // chosen node; reconnecting selects another local applied snapshot.
            const replicas = cluster.members.filter((node) => node.process && !node.process.ended && !node.process.intentional);
            if (!replicas.length) throw new Error("No running pizza replicas");
            const replica = replicas[watchSequence++ % replicas.length];
            const upstream = await fetch(replica.url + "/v1/watch", {
              method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" },
              body: JSON.stringify(input), signal: AbortSignal.any([shutdown.signal, controller.signal]),
            });
            response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json",
              "cache-control": "no-cache", "x-accel-buffering": "no" });
            if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
            else response.end();
          } finally { response.removeListener("close", disconnect); controller.abort(); }
          return;
        }
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["action", "shop"].includes(key))) throw new Error("Invalid demo action");
        if (input.shop !== undefined && (!Array.isArray(input.shop) || input.shop.length !== 2 ||
            !tenants.includes(input.shop[0]) || !["store-0", "store-1"].includes(input.shop[1]))) throw new Error("Unknown kitchen");
        switch (input.action) {
          case "order": await order(input.shop); break;
          case "tip": await mutate("pizza.tip", { shop: input.shop ?? [tenants[0], "store-0"], amount: 3 }); break;
          case "pause": paused = !paused; break;
          case "crash":
            if (crash) throw new Error("A leader recovery is already in progress");
            crash = cluster.crashLeaderAndRecover();
            try { await crash; } finally { crash = undefined; }
            break;
          default: throw new Error("Unknown demo action");
        }
        reply(response, 200, { ok: true, paused });
      })().catch((error) => {
        if (response.destroyed) return;
        if (response.headersSent) response.destroy();
        else reply(response, 400, { error: error.message });
      });
    });
    server.on("connection", (socket) => { connections.add(socket); socket.on("close", () => connections.delete(socket)); });
    let ready, failed;
    listening = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
    server.once("error", failed);
    try { server.listen(port, "127.0.0.1", ready); } catch (error) { failed(error); }
    await listening;
    shutdown.signal.throwIfAborted();
    origin = `http://127.0.0.1:${server.address().port}`;
    // Every write goes through an exposed method, including customers and drones.
    tasks.push((async () => {
      while (!shutdown.signal.aborted) {
        if (!paused && sequence < maxOrders) await order().catch((error) => { if (!shutdown.signal.aborted) console.error("Arrival:", error.message); });
        await sleep(1_300);
      }
    })().catch(() => {}));
    for (let index = 0; index < 3; index++) tasks.push((async () => {
      let claims = 0;
      while (!shutdown.signal.aborted) {
        try {
          const tenant = tenants[index % tenants.length];
          const { value: claim } = await mutate("pizza.claim", { tenant, owner: `drone-${index + 1}` });
          if (claim) {
            // One drone occasionally disappears; another later reclaims its lease.
            if (++claims % 9 === 0 && index === 0) await sleep(4_300);
            else {
              await sleep(700 + index * 220);
              await mutate("pizza.deliver", { tenant, id: claim.id, owner: claim.owner, token: claim.token });
            }
          }
        } catch (error) { if (!shutdown.signal.aborted) console.error("Drone:", error.message); }
        await sleep(400);
      }
    })().catch(() => {}));
    return { url: origin, close, pids: () => cluster.pids, maxOrders };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { port: { type: "string", default: "0" }, binary: { type: "string" },
    duration: { type: "string" }, paused: { type: "boolean", default: false } } });
  const duration = values.duration === undefined ? undefined : Number(values.duration);
  if (duration !== undefined && (!Number.isFinite(duration) || duration < 1 || duration > 3_600)) throw new Error("duration must be 1..3600 seconds");
  const controller = new AbortController();
  let timer;
  const interrupt = () => { clearTimeout(timer); controller.abort(new Error("Demo interrupted")); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const demo = await startPizzaDemo({ port: Number(values.port), binary: values.binary, auto: !values.paused, signal: controller.signal });
    console.log(`Goblin Pizza live: ${demo.url}\nOne watched value: pizza.dashboard({tenant}). Three tenants, two stores each; three Rust/QuickJS replicas.\nReplica-local views may lag. Automatic arrivals stop at ${demo.maxOrders} orders. Ctrl+C removes this temporary cluster.`);
    if (duration !== undefined) {
      timer = setTimeout(() => { void demo.close().catch((error) => { console.error(error); process.exitCode = 1; }); }, duration * 1_000);
      timer.unref();
    }
  } catch (error) { if (!controller.signal.aborted) throw error; }
}
