// Run after cargo build: node tests/e2e-http2.mjs
// Raw Node HTTP/2 proves the server contract independently of the SDK adapter.
import assert from "node:assert/strict";
import { connect, constants } from "node:http2";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalCluster } from "../bench/cluster.mjs";
import { buildBundle } from "../sdk/bundle.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.env.E2E_FLOWER_BIN ? resolve(process.env.E2E_FLOWER_BIN) : join(root, "target/debug/flower");
const cluster = new LocalCluster({ nodes: 3, binary });
const sessions = new Set();
const streamIds = new Set();
let active = 0;
let peakActive = 0;

function session(url) {
  const client = connect(url);
  // Connection errors also reach the affected streams. Keep the session event
  // handled when the failover test kills a process with an idle connection.
  client.on("error", () => {});
  sessions.add(client);
  return client;
}

function request(client, path, body, token, peerHeaders = {}) {
  return new Promise((resolve, reject) => {
    const stream = client.request({
      ":method": body === undefined ? "GET" : "POST", ":path": path,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...peerHeaders,
    });
    active++;
    peakActive = Math.max(peakActive, active);
    let status;
    let encoded = "";
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`HTTP/2 ${path} timed out`));
      stream.close(constants.NGHTTP2_CANCEL);
    }, 15_000);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      active--;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    }
    stream.setEncoding("utf8");
    stream.on("response", (headers) => {
      streamIds.add(stream.id);
      status = headers[":status"];
    });
    stream.on("data", (chunk) => { encoded += chunk; });
    stream.on("error", (error) => finish(error));
    stream.on("aborted", () => finish(new Error(`HTTP/2 ${path} stream aborted`)));
    stream.on("close", () => { if (!settled) finish(new Error(`HTTP/2 ${path} closed before its response ended`)); });
    stream.on("end", () => {
      try { finish(null, { status, value: JSON.parse(encoded) }); }
      catch (error) { finish(error); }
    });
    stream.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function success(client, path, body, token) {
  const response = await request(client, path, body, token);
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
}

const interrupt = () => {
  for (const client of sessions) client.destroy();
  void cluster.close();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  await cluster.start();
  const seed = cluster.members.find((node) => node.id !== cluster.leader.id);
  const client = session(seed.url);
  await success(client, "/health");
  assert.equal(client.socket.remotePort, Number(new URL(seed.url).port));
  assert.equal((await request(client, "/raft/metrics")).status, 401);
  const metrics = await success(client, "/raft/metrics", undefined, cluster.adminToken);
  assert.equal(metrics.id, seed.id);
  assert.notEqual(metrics.id, cluster.leader.id, "all public writes initially enter a follower");
  const membership = await success(client, "/raft/membership", undefined, cluster.adminToken);
  const c = membership.compatibility;
  const contract = `raft${c.raftWire}-state${c.stateMachine}-snapshot${c.snapshotFormat}-value${c.valueFormat}-qjs${c.quickjsSha256}`;
  const peerHeaders = {
    "x-flower-target-node-id": String(seed.id), "x-flower-target-address": seed.address,
    "x-flower-source-node-id": String(cluster.leader.id), "x-flower-source-address": cluster.leader.address,
    "x-flower-compatibility": contract, "x-flower-forward-kind": "mutate",
  };
  const probe = { name: "not.exposed", args: null, requestId: "h2-internal-probe" };
  assert.equal((await request(client, "/raft/forward", probe)).status, 401);
  assert.equal((await request(client, "/raft/forward", probe, cluster.adminToken)).status, 409);
  assert.equal((await request(client, "/raft/forward", probe, cluster.adminToken,
    { ...peerHeaders, "x-flower-compatibility": "incompatible" })).status, 426);
  assert.equal((await request(client, "/raft/forward", probe, cluster.adminToken,
    { ...peerHeaders, "x-flower-source-address": "127.0.0.1:1" })).status, 403);
  assert.equal((await request(client, "/raft/forward", probe, cluster.adminToken, peerHeaders)).status, 503,
    "internal forwarding never forwards recursively from a follower");

  const bundle = await buildBundle(join(root, "examples/orders.ts"));
  const deployment = { requestId: "h2-deploy", bundle };
  assert.equal((await request(client, "/admin/deploy", deployment)).status, 401);
  await success(client, "/admin/deploy", deployment, cluster.adminToken);
  await success(client, "/v1/call", {
    name: "order.create", requestId: "h2-create", args: {
      orderId: "h2-order", shippingCents: 5,
      lines: [{ id: "h2-line", quantity: 1, unitCents: 7 }],
    },
  });
  const calls = Array.from({ length: 16 }, (_, index) => ({
    name: "order.updateLine", args: { lineId: "h2-line", quantity: index + 2 },
    requestId: `h2-update-${index}`,
  }));
  const results = await Promise.all(calls.map(async (call) => {
    // These streams all share one session/socket and can complete independently.
    const [receipt, query] = await Promise.all([
      success(client, "/v1/mutate", call),
      success(client, "/v1/query", { name: "order.get", args: "h2-order" }),
    ]);
    assert.equal(receipt.value.subtotal, call.args.quantity * 7);
    assert.equal(receipt.value.total, call.args.quantity * 7 + 5);
    assert.equal(query.duplicate, false);
    assert.equal(query.value.total, query.value.subtotal + 5);
    return receipt;
  }));
  assert.equal(new Set(results.map(({ revision }) => revision)).size, calls.length);
  assert.ok(peakActive >= 32, "queries and mutations must overlap on the HTTP/2 session");
  assert.ok(streamIds.size >= 32, "the session must use separate HTTP/2 streams");
  const last = results.reduce((a, b) => a.revision > b.revision ? a : b);
  const current = await success(client, "/v1/query", { name: "order.get", args: "h2-order" });
  assert.deepEqual(current.value, last.value);
  assert.equal(current.revision, last.revision);
  const staleCas = await request(client, "/v1/mutate", {
    ...calls[0], requestId: "h2-stale-cas", expectedRevision: current.revision - 1,
  });
  assert.equal(staleCas.status, 409);
  assert.equal(staleCas.value.error.code, "REVISION_CONFLICT");
  for (const [index, call] of calls.entries()) {
    const retry = await success(client, "/v1/call", call);
    assert.deepEqual(retry, { ...results[index], duplicate: true });
  }
  assert.equal((await request(client, "/v1/call", { ...calls[0], args: { lineId: "h2-line", quantity: 999 } })).status, 409);
  assert.equal((await request(client, "/v1/query", { name: "internal.order.read", args: "h2-order" })).status, 404);

  // The same application and listener continue to serve existing HTTP/1 clients.
  const h1 = await fetch(seed.url + "/v1/query", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "order.get", args: "h2-order" }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(h1.status, 200);
  assert.deepEqual(await h1.json(), current);

  const oldLeaderStopped = cluster.leader.process.exited;
  const recovery = cluster.crashLeaderAndRecover();
  await oldLeaderStopped;
  // Keep the exact same seed and socket, issuing a mutation while an election
  // is in progress. The server owns discovery and repeats the original ID.
  const duringElection = success(client, "/v1/mutate", calls[0]);
  const [event, uncertainRetry] = await Promise.all([recovery, duringElection]);
  assert.notEqual(event.newLeader, event.oldLeader);
  assert.deepEqual(uncertainRetry, { ...results[0], duplicate: true });
  assert.equal(client.socket.remotePort, Number(new URL(seed.url).port));
  const recovered = await success(client, "/v1/query", { name: "order.get", args: "h2-order" });
  assert.deepEqual(recovered, current);
  const retry = await success(client, "/v1/mutate", calls[0]);
  assert.deepEqual(retry, { ...results[0], duplicate: true });
  const after = await success(client, "/v1/call", {
    name: "order.updateLine", args: { lineId: "h2-line", quantity: 20 }, requestId: "h2-after-election",
    expectedRevision: current.revision,
  });
  assert.equal(after.revision, current.revision + 1);
  assert.equal(after.value.total, 145);
  console.log("PASS: HTTP/2 multiplexed methods through a follower, forwarding auth/identity/no loops, allowlist, receipts, HTTP/1, same-seed leader failover and durable replay");
} catch (error) {
  console.error(error);
  console.error(cluster.logTails());
  process.exitCode = 1;
} finally {
  for (const client of sessions) client.destroy();
  await cluster.close();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
