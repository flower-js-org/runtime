// Run after cargo build: node tests/e2e.mjs
// Exercises the real HTTP service, QuickJS evaluator, disk store, and Raft peers.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { FlowerClient, FlowerError } from "../sdk/index.ts";
import { buildBundle } from "../sdk/bundle.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.env.E2E_FLOWER_BIN ? resolve(process.env.E2E_FLOWER_BIN) : join(root, "target/debug/flower");
const stageTimeout = Number(process.env.E2E_TIMEOUT_MS ?? 30_000);
assert.ok(Number.isFinite(stageTimeout) && stageTimeout > 0, "E2E_TIMEOUT_MS must be positive");
const processes = [];
const reservations = [];
const adminToken = randomUUID();
let directory;

async function bounded(label, operation, timeout = stageTimeout) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout} ms`)), timeout);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function until(label, operation) {
  const deadline = Date.now() + stageTimeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`, { cause: lastError });
}

async function reservePort() {
  const server = createServer();
  reservations.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

async function closeReservation(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function start(node) {
  const child = spawn(binary, ["--id", String(node.id), "--listen", node.address, "--data", node.directory], {
    cwd: root,
    env: { ...process.env, FLOWER_ADMIN_TOKEN: adminToken, RUST_LOG: "flower=info,openraft=warn" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runtime = { child, node, logs: "", error: null, ended: false };
  const collect = (chunk) => { runtime.logs = (runtime.logs + chunk.toString()).slice(-256_000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", (error) => { runtime.error = error; runtime.ended = true; });
  runtime.exited = new Promise((resolve) => child.once("close", (code, signal) => {
    runtime.ended = true;
    runtime.exit = { code, signal };
    resolve();
  }));
  node.process = runtime;
  processes.push(runtime);
}

async function stop(node, signal = "SIGKILL") {
  const process = node.process;
  if (process && !process.ended) {
    process.child.kill(signal);
    await bounded(`stop node ${node.id}`, () => process.exited, 5_000);
  }
}

async function json(node, path) {
  if (node.process.error) throw node.process.error;
  if (node.process.ended) throw new Error(`Node ${node.id} exited: ${JSON.stringify(node.process.exit)}`);
  const response = await fetch(node.url + path, {
    signal: AbortSignal.timeout(2_000),
    headers: path.startsWith("/raft/") ? { authorization: `Bearer ${adminToken}` } : undefined,
  });
  if (!response.ok) throw new Error(`Node ${node.id} ${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

async function waitLeader(nodes) {
  return until("elect a leader with a serving quorum", async () => {
    const observed = await Promise.all(nodes.filter((node) => !node.process.ended).map(async (node) => {
      try {
        const metrics = await json(node, "/raft/metrics");
        if (metrics.state !== "Leader" || Number(metrics.current_leader) !== node.id) return null;
        const probe = await fetch(node.url + "/v1/query", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "__e2e_missing_query__", args: null }),
          signal: AbortSignal.timeout(2_000),
        });
        if (probe.status === 503) return null;
        return node;
      } catch { return null; }
    }));
    return observed.find(Boolean);
  });
}

function assertOrder(result, subtotal, shippingCents) {
  assert.deepEqual(result.value, { order: { shippingCents }, subtotal, total: subtotal + shippingCents });
}

async function expectConflict(label, operation, code) {
  await assert.rejects(bounded(label, operation), (error) =>
    error instanceof FlowerError && error.status === 409 && error.code === code);
}

async function expectNotExposed(client, name, args = null, options = {}) {
  await assert.rejects(bounded(`reject unexposed method ${name}`, () => client.call(name, args, options)),
    (error) => error instanceof FlowerError && error.status === 404);
}

async function workerValue(client, name, args = null) {
  return (await bounded(name, () => client.call(name, args))).value;
}

async function expectLostLease(client, claim) {
  await assert.rejects(bounded("reject obsolete lease completion", () => client.call("jobs.complete", {
    id: claim.id, owner: claim.owner, token: claim.token, result: "obsolete worker result",
  })), (error) => error instanceof FlowerError && error.status === 422 && /LEASE_LOST/.test(error.message));
}

async function restartAndCatchUp(node, leader) {
  const applied = (await json(leader, "/raft/metrics")).last_applied.index;
  start(node);
  await until(`restarted node ${node.id} catches up`, async () => {
    const metrics = await json(node, "/raft/metrics");
    return metrics.last_applied?.index >= applied && Number(metrics.current_leader) === leader.id;
  });
}

async function checkWorkers(nodes, initialLeader) {
  let leader = initialLeader;
  for (const node of nodes) if (node.process.ended) await restartAndCatchUp(node, leader);

  const entry = join(directory, "workers-with-orders.ts");
  await writeFile(entry, `
import { define, query, mutation } from ${JSON.stringify(join(root, "sdk/index.ts"))};
import { subtotal, total } from ${JSON.stringify(join(root, "examples/orders.ts"))};
import application, { cache, jobs } from ${JSON.stringify(join(root, "examples/workers.ts"))};
const definitions = application.definitions;
const http = Object.fromEntries(Object.entries(application.http).map(([alias, entry]) => [alias, definitions[entry.name]]));
const rawCache = query("internal.test.cacheRaw", (ctx, key: string) => ctx.get(cache.records, key));
const rawJob = query("internal.test.jobRaw", (ctx, key: string) => ctx.get(jobs.records, key));
const expiredCache = mutation("internal.test.expiredCache", (ctx, key: string) => {
  cache.set(ctx, key, "expired value", {afterUpdateMs: 0});
  return {stored: ctx.get(cache.records, key), visible: cache.get(ctx, key)};
});
export default define({
  definitions: [subtotal, total, ...Object.values(definitions)],
  http: {...http, "test.cache.raw": rawCache, "test.job.raw": rawJob, "test.cache.expired": expiredCache},
  maintenance: definitions[application.maintenance.name],
});
`);
  const bundle = await bounded("build worker and expiration module", () => buildBundle(entry));
  await bounded("deploy worker and expiration module", () => new FlowerClient(leader.url, { adminToken })
    .deploy(bundle, { requestId: "e2e-workers-deploy" }));
  let client = new FlowerClient(leader.url);
  await expectNotExposed(client, "internal.workers.maintenance");
  await expectNotExposed(client, "maintenance");
  const spoof = await fetch(leader.url + "/v1/call", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "jobs.get", args: "lease-job", requestId: "e2e-spoof-time", now: Number.MAX_SAFE_INTEGER }),
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(spoof.status, 400, "public callers cannot supply trusted time");

  const enqueued = await workerValue(client, "jobs.enqueue", { id: "lease-job", payload: { task: "assemble" } });
  assert.equal(enqueued.state, "pending");
  const contenders = await bounded("concurrent workers compete for one job", () => Promise.all([
    client.call("jobs.claim", { owner: "worker-a", leaseMs: 300 }),
    client.call("jobs.claim", { owner: "worker-b", leaseMs: 300 }),
  ]));
  const winners = contenders.map((result) => result.value).filter((value) => value !== null);
  assert.equal(winners.length, 1, "only one concurrent claim owns the pending job");
  const first = winners[0];
  assert.equal(first.id, "lease-job");
  assert.equal(first.attempt, 1);
  assert.deepEqual(first.payload, { task: "assemble" });
  assert.equal(contenders.filter((result) => result.value === null).length, 1);
  const expired = await until("lease becomes claimable after its deadline", async () => {
    const job = await workerValue(client, "jobs.get", "lease-job");
    return job.state === "pending" ? job : null;
  });
  assert.equal(expired.error.code, "LEASE_EXPIRED");
  const reclaimed = await workerValue(client, "jobs.claim", { owner: "worker-c", leaseMs: 1_000 });
  assert.equal(reclaimed.id, first.id);
  assert.ok(reclaimed.token > first.token, "reclaim issues a newer fencing token");
  assert.equal(reclaimed.attempt, 2);
  await expectLostLease(client, first);
  const failed = await workerValue(client, "jobs.fail", {
    id: reclaimed.id, owner: reclaimed.owner, token: reclaimed.token,
    error: { code: "RETRYABLE", message: "temporary worker failure" },
  });
  assert.equal(failed.state, "failed");
  assert.equal(failed.lease, null);
  assert.equal(failed.error.code, "RETRYABLE");
  assert.equal((await workerValue(client, "jobs.retry", first.id)).state, "pending");
  const retried = await workerValue(client, "jobs.claim", { owner: "worker-d", leaseMs: 1_000 });
  assert.equal(retried.attempt, 3);
  assert.ok(retried.token > reclaimed.token);
  const completed = await workerValue(client, "jobs.complete", {
    id: retried.id, owner: retried.owner, token: retried.token, result: { assembled: true },
  });
  assert.equal(completed.state, "completed");
  assert.equal(completed.lease, null);
  assert.deepEqual(completed.result, { assembled: true });
  await expectLostLease(client, reclaimed);
  assert.equal(await workerValue(client, "jobs.claim", { owner: "empty-queue-worker" }), null);

  const byCreation = await workerValue(client, "cache.set", {
    key: "creation-ttl", value: "first", expiration: { afterCreationMs: 300 },
  });
  await delay(80);
  const creationUpdated = await workerValue(client, "cache.set", {
    key: "creation-ttl", value: "second", expiration: { afterCreationMs: 300 },
  });
  assert.equal(creationUpdated.createdAt, byCreation.createdAt);
  assert.equal(creationUpdated.expiresAt, byCreation.createdAt + 300);
  assert.equal(creationUpdated.expiresAt, byCreation.expiresAt, "creation TTL is not renewed by an update");
  assert.ok(creationUpdated.updatedAt > byCreation.updatedAt);
  assert.equal(await workerValue(client, "cache.get", "creation-ttl"), "second");
  await until("creation TTL filters expired values", async () =>
    await workerValue(client, "cache.get", "creation-ttl") === null);
  await until("maintenance physically removes creation-expired records", async () =>
    await workerValue(client, "test.cache.raw", "creation-ttl") === null);

  const byUpdate = await workerValue(client, "cache.set", {
    key: "update-ttl", value: 1, expiration: { afterUpdateMs: 300 },
  });
  await delay(80);
  const updateRenewed = await workerValue(client, "cache.set", {
    key: "update-ttl", value: 2, expiration: { afterUpdateMs: 300 },
  });
  assert.equal(updateRenewed.createdAt, byUpdate.createdAt);
  assert.equal(updateRenewed.expiresAt, updateRenewed.updatedAt + 300);
  assert.ok(updateRenewed.expiresAt > byUpdate.expiresAt, "update TTL renews its deadline");
  assert.equal(await workerValue(client, "cache.get", "update-ttl"), 2);
  await until("update TTL eventually filters expired values", async () =>
    await workerValue(client, "cache.get", "update-ttl") === null);
  await until("maintenance physically removes update-expired records", async () =>
    await workerValue(client, "test.cache.raw", "update-ttl") === null);

  // Both observations happen in one TS transaction, so filtering is proven
  // independently of whether the asynchronous maintenance sweep has run.
  const hidden = await workerValue(client, "test.cache.expired", "immediate-expiry");
  assert.equal(hidden.stored.value, "expired value");
  assert.equal(hidden.visible, null);
  await until("private maintenance removes immediately expired storage", async () =>
    await workerValue(client, "test.cache.raw", "immediate-expiry") === null);
  const immortal = await workerValue(client, "cache.set", { key: "no-expiry", value: "durable", expiration: null });
  assert.equal(immortal.expiresAt, null);
  console.log("Competing leases, expiration/reclaim, fencing, complete/fail/retry, TTL policies, and private physical cleanup passed.");

  await workerValue(client, "jobs.enqueue", { id: "failover-job", payload: "survive leader loss" });
  const lostClaim = await workerValue(client, "jobs.claim", { owner: "lost-worker", leaseMs: 500 });
  const failoverCache = await workerValue(client, "cache.set", {
    key: "failover-ttl", value: "remove after leader loss", expiration: { afterUpdateMs: 500 },
  });
  assert.ok(failoverCache.expiresAt > failoverCache.updatedAt);
  assert.notEqual(await workerValue(client, "test.cache.raw", "failover-ttl"), null);
  const workerLeader = leader;
  await stop(workerLeader);
  leader = await waitLeader(nodes);
  assert.notEqual(leader.id, workerLeader.id);
  client = new FlowerClient(leader.url);
  await expectNotExposed(client, "internal.workers.maintenance");
  await until("replacement leader physically expires old cache storage", async () =>
    await workerValue(client, "test.cache.raw", "failover-ttl") === null);
  await until("replacement leader persists expired lease reclamation", async () =>
    (await workerValue(client, "test.job.raw", "failover-job")).state === "pending");
  const replacementClaim = await workerValue(client, "jobs.claim", { owner: "replacement-worker", leaseMs: 1_000 });
  assert.equal(replacementClaim.id, lostClaim.id);
  assert.ok(replacementClaim.token > lostClaim.token, "fencing survives leadership changes");
  await expectLostLease(client, lostClaim);
  assert.equal((await workerValue(client, "jobs.complete", {
    id: replacementClaim.id, owner: replacementClaim.owner, token: replacementClaim.token, result: "recovered",
  })).state, "completed");

  await restartAndCatchUp(workerLeader, leader);
  await stop(leader);
  leader = await waitLeader(nodes);
  client = new FlowerClient(leader.url);
  assert.equal((await workerValue(client, "jobs.get", "failover-job")).result, "recovered");
  assert.equal(await workerValue(client, "cache.get", "no-expiry"), "durable");
  await workerValue(client, "cache.set", { key: "restart-ttl", value: "cleanup after restart", expiration: { afterUpdateMs: 150 } });
  await until("maintenance remains active after restart and another failover", async () =>
    await workerValue(client, "test.cache.raw", "restart-ttl") === null);
  await expectNotExposed(client, "internal.workers.maintenance");
  console.log("Leases, fencing, TTL cleanup, and private maintenance survived leader loss, restart, and another failover.");
  return leader;
}

async function checkScheduling(nodes, initialLeader) {
  let leader = initialLeader;
  for (const node of nodes) if (node.process.ended) await restartAndCatchUp(node, leader);

  const entry = join(directory, "scheduling-with-orders.ts");
  await writeFile(entry, `
import { collection, define, derive, mutation, query } from ${JSON.stringify(join(root, "sdk/index.ts"))};
import { scheduler } from ${JSON.stringify(join(root, "sdk/scheduler.ts"))};
import { subtotal, total } from ${JSON.stringify(join(root, "examples/orders.ts"))};
import application, { publishDocument } from ${JSON.stringify(join(root, "examples/scheduling.ts"))};
const effects = collection("e2eScheduledEffects");
const audit = collection("e2eScheduledAudit");
const effectView = derive("internal.e2e.effectView", (ctx, key: string) => {
  const effect = ctx.get(effects, key);
  return effect === null ? null : {...effect, doubled: effect.count * 2};
});
const fail = mutation("internal.e2e.scheduledFailure", (ctx, args: any) => {
  ctx.set(effects, args.key, {value: "partial write", count: 100});
  ctx.set(audit, args.key, {partial: true});
  throw new Error("scheduled callback failed after writing");
});
const healthy = mutation("internal.e2e.scheduledHealthy", (ctx, args: any) => {
  const previous = ctx.get(effects, args.key);
  ctx.set(effects, args.key, {value: args.value, count: (previous?.count ?? 0) + 1});
  ctx.set(audit, args.key, {committed: true});
  return null;
});
const timers = scheduler("publicationTimers", {publish: publishDocument, fail, healthy},
  {maxAttempts: 2, retryDelayMs: 50, maxRetryDelayMs: 100});
const schedule = mutation("internal.e2e.schedule", (ctx, args: any) => {
  ctx.materialize(effectView, args.key);
  return timers.after(ctx, args.id, args.delayMs, args.handler, {key: args.key, value: args.value ?? null});
});
const status = query("internal.e2e.scheduleStatus", (ctx, id: string) => timers.get(ctx, id));
const inspect = query("internal.e2e.effects", (ctx, key: string) => ({
  derived: ctx.get(effectView, key), audit: ctx.get(audit, key),
}));
const definitions = application.definitions;
const oldMaintenance = application.maintenance;
const retained = Object.values(definitions).filter(definition =>
  definition.name !== oldMaintenance.name && definition.name !== oldMaintenance.onError?.name);
const http = Object.fromEntries(Object.entries(application.http).map(([alias, method]) => [alias, definitions[method.name]]));
export default define({
  definitions: [subtotal, total, effectView, fail, healthy, ...retained],
  http: {...http, "test.schedule": schedule, "test.schedule.status": status, "test.effects": inspect},
  maintenance: timers.maintenance,
});
`);
  const bundle = await bounded("build general scheduling module", () => buildBundle(entry));
  await bounded("deploy general scheduling module", () => new FlowerClient(leader.url, { adminToken })
    .deploy(bundle, { requestId: "e2e-scheduling-deploy" }));
  let client = new FlowerClient(leader.url);
  for (const name of ["internal.scheduler.publicationTimers.run", "internal.scheduler.publicationTimers.onError",
    "internal.documents.publish", "internal.e2e.scheduledFailure", "internal.e2e.scheduledHealthy"]) {
    await expectNotExposed(client, name);
  }

  const updated = await workerValue(client, "documents.update", {
    id: "delayed-document", text: "publish after this update", publishAfterMs: 200,
  });
  assert.equal(updated.document.status, "draft");
  assert.equal(updated.timer.state, "pending");
  assert.ok(updated.timer.dueAt >= updated.document.updatedAt + 200);
  assert.equal((await workerValue(client, "documents.get", "delayed-document")).status, "draft");
  const published = await until("delayed action publishes a document after its update", async () => {
    const document = await workerValue(client, "documents.get", "delayed-document");
    return document.status === "published" ? document : null;
  });
  assert.equal(published.text, "publish after this update");
  assert.ok(published.publishedAt >= updated.timer.dueAt);
  assert.equal(await workerValue(client, "documents.publication", "delayed-document"), null);

  const oldTimer = await workerValue(client, "test.schedule", {
    id: "debounced-effect", delayMs: 150, handler: "healthy", key: "debounced", value: "obsolete",
  });
  const replacement = await workerValue(client, "test.schedule", {
    id: "debounced-effect", delayMs: 600, handler: "healthy", key: "debounced", value: "latest",
  });
  assert.ok(replacement.dueAt > oldTimer.dueAt);
  await delay(250);
  assert.deepEqual(await workerValue(client, "test.effects", "debounced"), { derived: null, audit: null },
    "rescheduling one ID prevents the old due callback from writing");
  const effect = await until("rescheduled callback applies its latest arbitrary writes", async () => {
    const effect = await workerValue(client, "test.effects", "debounced");
    return effect.derived === null ? null : effect;
  });
  assert.deepEqual(effect, { derived: { value: "latest", count: 1, doubled: 2 }, audit: { committed: true } });
  assert.equal(await workerValue(client, "test.schedule.status", "debounced-effect"), null);

  await workerValue(client, "documents.update", { id: "cancelled-document", text: "keep as draft", publishAfterMs: 150 });
  assert.equal(await workerValue(client, "documents.cancelPublication", "cancelled-document"), true);
  assert.equal(await workerValue(client, "documents.publication", "cancelled-document"), null);
  await delay(350);
  assert.equal((await workerValue(client, "documents.get", "cancelled-document")).status, "draft");

  await workerValue(client, "test.schedule", {
    id: "poison-callback", delayMs: 0, handler: "fail", key: "rolled-back", value: "must not appear",
  });
  await workerValue(client, "test.schedule", {
    id: "healthy-callback", delayMs: 0, handler: "healthy", key: "healthy-progress", value: { finished: true },
  });
  const healthyProgress = await until("a failing callback does not block healthy due work", async () => {
    const effect = await workerValue(client, "test.effects", "healthy-progress");
    return effect.derived === null ? null : effect;
  });
  assert.deepEqual(healthyProgress.derived, { value: { finished: true }, count: 1, doubled: 2 });
  const failed = await until("private error handler records retries and terminal failure", async () => {
    const timer = await workerValue(client, "test.schedule.status", "poison-callback");
    return timer?.state === "failed" ? timer : null;
  });
  assert.equal(failed.attempts, 2);
  assert.equal(failed.error.code, "MAINTENANCE_FAILED");
  assert.match(failed.error.message, /scheduled callback failed after writing/);
  assert.deepEqual(await workerValue(client, "test.effects", "rolled-back"), { derived: null, audit: null },
    "all callback writes roll back before failure bookkeeping commits");
  assert.equal(await workerValue(client, "test.schedule.status", "healthy-callback"), null);
  console.log("Delayed actions, same-ID rescheduling, cancellation, reactive writes, rollback/retries, and healthy queue progress passed.");

  const durableTimer = await workerValue(client, "documents.update", {
    id: "failover-document", text: "timer survives the leader", publishAfterMs: 500,
  });
  assert.equal(durableTimer.document.status, "draft");
  const schedulerLeader = leader;
  await stop(schedulerLeader);
  leader = await waitLeader(nodes);
  assert.notEqual(leader.id, schedulerLeader.id);
  client = new FlowerClient(leader.url);
  const afterFailover = await until("replacement leader executes the durable scheduled action", async () => {
    const document = await workerValue(client, "documents.get", "failover-document");
    return document.status === "published" ? document : null;
  });
  assert.equal(afterFailover.text, "timer survives the leader");
  assert.ok(afterFailover.publishedAt >= durableTimer.timer.dueAt);
  assert.equal(await workerValue(client, "documents.publication", "failover-document"), null);
  await expectNotExposed(client, "internal.scheduler.publicationTimers.onError");

  await restartAndCatchUp(schedulerLeader, leader);
  await stop(leader);
  leader = await waitLeader(nodes);
  client = new FlowerClient(leader.url);
  assert.equal((await workerValue(client, "documents.get", "failover-document")).status, "published");
  await workerValue(client, "documents.update", { id: "restart-document", text: "scheduled after restart", publishAfterMs: 150 });
  await until("durable scheduler remains active after restart and another failover", async () =>
    (await workerValue(client, "documents.get", "restart-document")).status === "published");
  await workerValue(client, "test.schedule", {
    id: "post-restart-failure", delayMs: 0, handler: "fail", key: "restart-rollback", value: null,
  });
  await until("private failure handler persists through restart and failover", async () =>
    (await workerValue(client, "test.schedule.status", "post-restart-failure"))?.state === "failed");
  assert.deepEqual(await workerValue(client, "test.effects", "restart-rollback"), { derived: null, audit: null });
  await expectNotExposed(client, "internal.scheduler.publicationTimers.run");
  await expectNotExposed(client, "internal.scheduler.publicationTimers.onError");
  console.log("General scheduled actions and private failure handling survived leader loss, restart, and another failover.");
}

async function main() {
  directory = await mkdtemp(join(tmpdir(), "flower-e2e-"));
  const ports = await Promise.all([reservePort(), reservePort(), reservePort()]);
  const nodes = ports.map(({ port }, index) => ({
    id: index + 1,
    address: `127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}`,
    directory: join(directory, `node-${index + 1}`),
  }));
  for (let index = 0; index < nodes.length; index++) {
    await closeReservation(ports[index].server);
    start(nodes[index]);
  }
  await Promise.all(nodes.map((node) => until(`node ${node.id} startup`, () => json(node, "/health"))));
  for (const [path, method] of [["/raft/metrics", "GET"], ["/raft/initialize", "POST"], ["/admin/deploy", "POST"]]) {
    const response = await fetch(nodes[0].url + path, {
      method, headers: { "content-type": "application/json" },
      body: method === "POST" ? "{}" : undefined, signal: AbortSignal.timeout(2_000),
    });
    assert.equal(response.status, 401, `${path} requires the admin credential`);
  }
  await bounded("cluster initialization", () => new FlowerClient(nodes[0].url, { adminToken })
    .initialize(Object.fromEntries(nodes.map((node) => [String(node.id), node.address]))));
  let leader = await waitLeader(nodes);
  let client = new FlowerClient(leader.url);
  console.log(`Cluster ready; node ${leader.id} leads.`);

  for (const [path, method] of [["/v1/snapshot", "GET"], ["/v1/events", "GET"], ["/v1/transactions", "POST"]]) {
    const response = await fetch(leader.url + path, {
      method, headers: { "content-type": "application/json" },
      body: method === "POST" ? "{}" : undefined, signal: AbortSignal.timeout(2_000),
    });
    assert.equal(response.status, 404, `${path} must not expose raw database access`);
  }
  const bundle = await bounded("build TypeScript module", () => buildBundle(join(root, "examples/orders.ts")));
  const deployed = await bounded("deploy TypeScript bundle", () => new FlowerClient(leader.url, { adminToken })
    .deploy(bundle, { requestId: "e2e-deploy" }));
  assert.equal(deployed.revision, 1);

  const initialArgs = JSON.parse(await readFile(join(root, "examples/orders.create.json"), "utf8"));
  const initialOptions = { requestId: "e2e-initial-order", expectedRevision: deployed.revision };
  const initial = await bounded("generic call dispatches mutation", () => client.call("order.create", initialArgs, initialOptions));
  assert.equal(initial.duplicate, false);
  assert.equal(initial.revision, 2);
  assertOrder(initial, 3200, 500); // Mutation return reads its own staged sources and derived values.
  const beforeUpdate = await bounded("generic call dispatches query", () => client.call("order.get", "order-42"));
  assertOrder(beforeUpdate, 3200, 500);
  assert.equal(beforeUpdate.revision, initial.revision, "queries do not commit a revision");

  const watcher = client.watchPoll("order.get", "order-42", { intervalMs: 5 });
  assertOrder((await bounded("initial watched query", () => watcher.next())).value, 3200, 500);
  const updateArgs = JSON.parse(await readFile(join(root, "examples/orders.update.json"), "utf8"));
  const updateOptions = { requestId: "e2e-update-lines", expectedRevision: initial.revision };
  const updated = await bounded("update line method", () => client.mutate("order.updateLine", updateArgs, updateOptions));
  assert.equal(updated.revision, 3);
  assertOrder(updated, 4600, 500);
  const watchedUpdate = (await bounded("watch updated order", () => watcher.next())).value;
  assertOrder(watchedUpdate, 4600, 500);
  assert.equal(watchedUpdate.revision, updated.revision);
  await watcher.return();
  const afterUpdate = await bounded("query updated order", () => client.query("order.get", "order-42"));
  assertOrder(afterUpdate, 4600, 500);

  const duplicate = await bounded("deduplicate old method", () => client.call("order.create", initialArgs, initialOptions));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.revision, initial.revision);
  assert.deepEqual(duplicate.value, initial.value, "retry returns the original method result, not today's value");
  await expectConflict("reject reused request ID", () => client.call("order.create", {
    ...initialArgs, shippingCents: 999,
  }, initialOptions), "REQUEST_ID_REUSED");
  await expectConflict("reject stale expected revision", () => client.mutate("order.updateLine", updateArgs, {
    requestId: "e2e-stale-revision", expectedRevision: initial.revision,
  }), "REVISION_CONFLICT");
  for (const [label, call] of [
    ["mutation through query endpoint", () => client.query("order.updateLine", updateArgs)],
    ["query through mutation endpoint", () => client.mutate("order.get", "order-42")],
    ["derived value as public query", () => client.query("order.total", "order-42")],
    ["missing public method", () => client.query("no.such.method", null)],
  ]) {
    await assert.rejects(bounded(label, call), (error) => error instanceof FlowerError && [400, 404, 422].includes(error.status));
  }
  // The code owns HTTP aliases. Valid internal definitions are not HTTP entry points.
  for (const [name, args] of [
    ["internal.order.read", "order-42"],
    ["internal.order.create", initialArgs],
    ["internal.order.updateLine", updateArgs],
    ["internal.order.updateShipping", { orderId: "order-42", shippingCents: 999 }],
    ["internal.order.reset", "order-42"],
    ["order.total", "order-42"],
  ]) await expectNotExposed(client, name, args);
  // The handler stages the order before validating its lines; an error must roll it all back.
  await assert.rejects(bounded("rollback throwing method", () => client.mutate("order.create", {
    orderId: "failed-order", shippingCents: 100, lines: [{ id: "bad-line", quantity: -1, unitCents: 100 }],
  })), (error) => error instanceof FlowerError && error.status === 422);
  await assert.rejects(bounded("rolled-back order is absent", () => client.query("order.get", "failed-order")),
    (error) => error instanceof FlowerError && error.status === 422);
  const afterRejected = await bounded("query after rejected methods", () => client.query("order.get", "order-42"));
  assert.equal(afterRejected.revision, updated.revision);
  assert.deepEqual(afterRejected, afterUpdate);
  console.log("Code-owned HTTP aliases, generic dispatch, reactive reads, query watch, rollback, and deduplication passed.");

  // Change only the public exposure in a new deployed TS module. Keep all of the
  // original definitions, including the formerly public method and private one.
  const exposureEntry = join(directory, "alternate-exposure.ts");
  await writeFile(exposureEntry, `
import { define } from ${JSON.stringify(join(root, "sdk/index.ts"))};
import { subtotal, total, privateReset, getOrder, createOrder, updateLine, updateShipping } from ${JSON.stringify(join(root, "examples/orders.ts"))};
export default define({
  definitions: [subtotal, total, privateReset, getOrder, createOrder, updateLine, updateShipping],
  http: {
    "orders.inspect": getOrder,
    "orders.create": createOrder,
    "order.updateLine": updateLine,
    "order.updateShipping": updateShipping,
  },
});
`);
  const exposureBundle = await bounded("build changed HTTP exposure", () => buildBundle(exposureEntry));
  const exposure = await bounded("deploy changed HTTP exposure", () => new FlowerClient(leader.url, { adminToken })
    .deploy(exposureBundle, { requestId: "e2e-change-exposure" }));
  assert.equal(exposure.revision, updated.revision + 1);
  await expectNotExposed(client, "order.get", "order-42");
  await expectNotExposed(client, "order.create", initialArgs, initialOptions);
  await expectNotExposed(client, "internal.order.read", "order-42");
  await expectNotExposed(client, "internal.order.reset", "order-42");
  const inspect = await bounded("new HTTP alias dispatches existing query", () => client.call("orders.inspect", "order-42"));
  assertOrder(inspect, 4600, 500);
  assert.equal(inspect.revision, exposure.revision, "changing aliases is one deployment; queries still do not commit");

  // Bypass the SDK constructor to test host-side registry validation directly.
  const invalidJavascript = `var __flowerBundle = {default: {
    definitions: {valid: {kind: 'queryMethod', name: 'valid', compute: () => 1}},
    http: {broken: {name: 'missing-definition', kind: 'query'}}
  }};`;
  const invalidBundle = {
    javascript: invalidJavascript,
    hash: createHash("sha256").update(invalidJavascript).digest("hex"),
  };
  await assert.rejects(bounded("reject invalid HTTP registry deployment", () => new FlowerClient(leader.url, { adminToken })
    .deploy(invalidBundle, { requestId: "e2e-invalid-registry" })),
  (error) => error instanceof FlowerError && error.status === 422);
  const afterInvalid = await bounded("prior code and registry survive rejected deployment", () => client.call("orders.inspect", "order-42"));
  assert.deepEqual(afterInvalid, inspect);
  await expectNotExposed(client, "broken");
  await expectNotExposed(client, "order.get", "order-42");
  await expectNotExposed(client, "order.create", initialArgs, initialOptions);
  const aliasCreated = await bounded("new mutation alias dispatches existing method", () => client.call("orders.create", {
    orderId: "alias-order", shippingCents: 0, lines: [],
  }, { requestId: "e2e-new-mutation-alias", expectedRevision: exposure.revision }));
  assert.equal(aliasCreated.revision, exposure.revision + 1);
  assertOrder(aliasCreated, 0, 0);
  console.log("Deployment changed public exposure atomically; an invalid registry left the previous code and aliases intact.");

  const crashed = leader;
  await stop(crashed);
  leader = await waitLeader(nodes);
  assert.notEqual(leader.id, crashed.id);
  client = new FlowerClient(leader.url);
  const afterFailover = await bounded("new alias survives leader loss", () => client.call("orders.inspect", "order-42"));
  assert.equal(afterFailover.revision, aliasCreated.revision);
  assertOrder(afterFailover, 4600, 500);
  await expectNotExposed(client, "order.get", "order-42");
  await expectNotExposed(client, "order.create", initialArgs, initialOptions);
  await expectNotExposed(client, "internal.order.reset", "order-42");
  const recoveredReceipt = await bounded("retry receipt after leader loss", () => client.mutate("order.updateLine", updateArgs, updateOptions));
  assert.equal(recoveredReceipt.duplicate, true);
  assert.equal(recoveredReceipt.revision, updated.revision);
  assert.deepEqual(recoveredReceipt.value, updated.value);
  const shippingArgs = { orderId: "order-42", shippingCents: 800 };
  const shippingOptions = { requestId: "e2e-after-failover", expectedRevision: aliasCreated.revision };
  const shipped = await bounded("mutate with surviving quorum", () => client.mutate("order.updateShipping", shippingArgs, shippingOptions));
  assert.equal(shipped.revision, aliasCreated.revision + 1);
  assertOrder(shipped, 4600, 800);
  assertOrder(await bounded("post-failover query", () => client.query("orders.inspect", "order-42")), 4600, 800);
  console.log(`Leader loss recovered; node ${leader.id} committed a new reactive update.`);

  const applied = (await json(leader, "/raft/metrics")).last_applied.index;
  start(crashed);
  await until("restarted node catches up from its durable directory", async () => {
    const metrics = await json(crashed, "/raft/metrics");
    return metrics.last_applied?.index >= applied && Number(metrics.current_leader) === leader.id;
  });
  // The recovered node must now participate in the next quorum after another loss.
  await stop(leader);
  leader = await waitLeader(nodes);
  client = new FlowerClient(leader.url);
  const final = await bounded("new alias survives recovery and second failover", () => client.call("orders.inspect", "order-42"));
  assert.equal(final.revision, shipped.revision);
  assertOrder(final, 4600, 800);
  await expectNotExposed(client, "order.get", "order-42");
  await expectNotExposed(client, "order.create", initialArgs, initialOptions);
  await expectNotExposed(client, "internal.order.read", "order-42");
  await expectNotExposed(client, "internal.order.reset", "order-42");
  const finalReceipt = await bounded("durable receipt after second failover", () => client.mutate("order.updateShipping", shippingArgs, shippingOptions));
  assert.equal(finalReceipt.duplicate, true);
  assert.equal(finalReceipt.revision, shipped.revision);
  assert.deepEqual(finalReceipt.value, shipped.value);
  const originalReceipt = await bounded("original allowed-method result survives restart", () => client.call("order.updateLine", updateArgs, updateOptions));
  assert.equal(originalReceipt.duplicate, true);
  assert.equal(originalReceipt.revision, updated.revision);
  assert.deepEqual(originalReceipt.value, updated.value);
  console.log("Restart, replica catch-up, second failover, durable method results, and persisted HTTP exposure passed.");
  leader = await checkWorkers(nodes, leader);
  await checkScheduling(nodes, leader);
}

try {
  await main();
  console.log("Flower end-to-end checks passed.");
} catch (error) {
  console.error(error);
  for (const process of processes) {
    console.error(`\n--- Node ${process.node.id}, PID ${process.child.pid ?? "not started"} ---\n${process.logs}`);
    if (process.error) console.error(process.error);
  }
  process.exitCode = 1;
} finally {
  // Stop all generations, including restarted processes, on success or failure.
  for (const process of processes) {
    if (!process.ended) process.child.kill("SIGKILL");
  }
  await Promise.allSettled(processes.map((process) => bounded("process cleanup", () => process.exited, 5_000)));
  await Promise.allSettled(reservations.map(closeReservation));
  if (directory) await rm(directory, { recursive: true, force: true });
}
