import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

async function releasePort(reservation) {
  if (!reservation.server.listening) return;
  await new Promise((resolve, reject) => reservation.server.close((error) => error ? reject(error) : resolve()));
}

async function waitForExit(runtime, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      runtime.exited.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function discoveryTimeout(timeoutMs) {
  const error = new Error(`elect a leader with a serving quorum timed out after ${timeoutMs} ms`);
  error.code = "DISCOVERY_TIMEOUT";
  return error;
}

async function waitForDiscovery(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(discoveryTimeout(timeoutMs)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** An isolated, disposable cluster. Never connects to or deletes an existing database. */
export class LocalCluster {
  constructor(options = {}) {
    this.nodeCount = options.nodes ?? 3;
    if (![1, 3].includes(this.nodeCount)) throw new Error("nodes must be 1 or 3");
    this.binary = resolve(options.binary ?? join(root, "target/release/flower"));
    this.startupTimeoutMs = positiveInteger(options.startupTimeoutMs ?? 30_000, "startupTimeoutMs");
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? 2_000, "requestTimeoutMs");
    this.keepData = options.keepData ?? false;
    this.onProcess = options.onProcess;
    this.adminToken = randomUUID();
    this.members = [];
    this.leader = null;
    this.directory = null;
    this.events = [];
    this._generations = [];
    this._reservations = [];
    this._controller = new AbortController();
    this._discovering = null;
    this._recovering = null;
    this._recoveryObservation = null;
    this._closing = null;
    this._starting = null;
    this._started = false;
    this._probeName = `__flower_benchmark_probe_${randomUUID()}`;
  }

  get url() {
    if (!this.leader) throw new Error("Cluster has no known serving leader");
    return this.leader.url;
  }

  get pids() {
    return this.members.filter((node) => node.process && !node.process.ended)
      .map((node) => ({ id: node.id, pid: node.process.child.pid }));
  }

  _assertOpen() {
    this._controller.signal.throwIfAborted();
  }

  _assertHealthy() {
    this._assertOpen();
    for (const node of this.members) {
      const runtime = node.process;
      if (runtime?.ended && !runtime.intentional) {
        throw new Error(`Flower node ${node.id} exited unexpectedly: ${runtime.error?.message ?? JSON.stringify(runtime.exit)}`);
      }
    }
  }

  _eligible(node, runtime = node?.process) {
    return Boolean(runtime && node.process === runtime && !runtime.ended && !runtime.intentional);
  }

  _startNode(node) {
    this._assertOpen();
    const child = spawn(this.binary, ["--id", String(node.id), "--listen", node.address, "--data", node.directory], {
      cwd: root,
      env: {
        ...process.env, FLOWER_ADMIN_TOKEN: this.adminToken,
        RUST_LOG: process.env.FLOWER_BENCH_LOG ?? "flower=info,openraft=warn",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const runtime = { child, id: node.id, logs: "", error: null, ended: false, intentional: false };
    const collect = (chunk) => { runtime.logs = (runtime.logs + chunk.toString()).slice(-64_000); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => { runtime.error = error; runtime.ended = true; });
    runtime.exited = new Promise((resolve) => child.once("close", (code, signal) => {
      runtime.ended = true;
      runtime.exit = { code, signal };
      try { if (Number.isSafeInteger(child.pid)) this.onProcess?.({ type: "exit", pid: child.pid }); }
      catch (error) { this._controller.abort(error); }
      resolve();
    }));
    node.process = runtime;
    this._generations.push(runtime);
    // Register ownership before invoking an observer so reporting failures can
    // never strand a process outside the cluster's normal cleanup path.
    try { if (Number.isSafeInteger(child.pid)) this.onProcess?.({ type: "spawn", pid: child.pid }); }
    catch (error) { this._controller.abort(error); }
  }

  async _fetch(node, path, { method = "GET", body, timeoutMs = this.requestTimeoutMs, signal } = {}) {
    this._assertOpen();
    if (!node.process || node.process.ended) throw new Error(`Node ${node.id} is not running`);
    const headers = {};
    if (path.startsWith("/raft/")) headers.authorization = `Bearer ${this.adminToken}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(node.url + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([this._controller.signal, AbortSignal.timeout(Math.max(1, timeoutMs)), ...(signal ? [signal] : [])]),
    });
    // Consume the body under the same abort deadline as the response headers.
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { value = text; }
    return { status: response.status, ok: response.ok, value };
  }

  async metrics(node = this.leader) {
    if (!node) throw new Error("No node selected for metrics");
    const response = await this._fetch(node, "/raft/metrics");
    if (!response.ok) throw new Error(`Node ${node.id} metrics returned HTTP ${response.status}`);
    return response.value;
  }

  async _until(label, operation, timeoutMs = this.startupTimeoutMs, { pollMs = 75 } = {}) {
    const deadline = performance.now() + timeoutMs;
    let lastError;
    while (performance.now() < deadline) {
      this._assertHealthy();
      try {
        const result = await operation(Math.max(1, Math.min(this.requestTimeoutMs, Math.ceil(deadline - performance.now()))));
        if (result) return result;
      } catch (error) { lastError = error; }
      this._assertHealthy();
      await delay(Math.min(pollMs, Math.max(1, deadline - performance.now())), undefined, { signal: this._controller.signal });
    }
    const error = new Error(`${label} timed out after ${timeoutMs} ms${lastError ? `: ${lastError.message}` : ""}`, { cause: lastError });
    error.code = "CLUSTER_WAIT_TIMEOUT";
    throw error;
  }

  async start() {
    if (this._started) throw new Error("Cluster can only be started once");
    this._started = true;
    this._assertOpen();
    this._starting = (async () => {
      await access(this.binary, constants.X_OK);
      this.directory = await mkdtemp(join(tmpdir(), "flower-bench-"));
      for (let index = 0; index < this.nodeCount; index++) {
        const reservation = await reservePort();
        this._reservations.push(reservation);
        const id = index + 1;
        const address = `127.0.0.1:${reservation.port}`;
        this.members.push({ id, address, url: `http://${address}`, directory: join(this.directory, `node-${id}`) });
      }
      for (const [index, node] of this.members.entries()) {
        await releasePort(this._reservations[index]);
        this._startNode(node);
      }
      await this._until("start all Flower nodes", async (timeoutMs) => {
        const results = await Promise.all(this.members.map(async (node) => {
          try { return (await this._fetch(node, "/raft/metrics", { timeoutMs })).ok; } catch { return false; }
        }));
        return results.every(Boolean);
      });
      const response = await this._fetch(this.members[0], "/raft/initialize", {
        method: "POST", body: Object.fromEntries(this.members.map((node) => [node.id, node.address])),
        timeoutMs: this.startupTimeoutMs,
      });
      if (!response.ok) throw new Error(`Cluster initialization returned HTTP ${response.status}: ${JSON.stringify(response.value)}`);
      await this.discoverLeader();
      return this;
    })();
    try { return await this._starting; }
    catch (error) {
      error.clusterLogs = this.logTails();
      await this.close();
      throw error;
    }
  }

  _observeRecovery(field, node) {
    const observation = this._recoveryObservation;
    if (!observation || node.id === observation.event.oldLeader) return;
    observation.event[field] ??= performance.now() - observation.started;
  }

  async _probeLeader(timeoutMs) {
    const round = new AbortController();
    const deadline = performance.now() + timeoutMs;
    try {
      // A slow follower must not hold up a leader that has already established
      // a quorum. Reject nonleaders and take the first successful quorum probe.
      return await Promise.any(this.members.filter((node) => this._eligible(node)).map(async (node) => {
        const runtime = node.process;
        const response = await this._fetch(node, "/raft/metrics", { timeoutMs, signal: round.signal });
        const metrics = response.value;
        if (!this._eligible(node, runtime) || !response.ok) throw new Error("Stale metrics response");
        if (metrics.state === "Candidate") this._observeRecovery("candidateObservedMs", node);
        if (metrics.state !== "Leader" || Number(metrics.current_leader) !== node.id) throw new Error("Not leader");
        this._observeRecovery("leaderObservedMs", node);
        const probe = await this._fetch(node, "/v1/query", {
          method: "POST", body: { name: this._probeName, args: null },
          timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())), signal: round.signal,
        });
        // Check process generation again: responses can complete after SIGKILL,
        // before the process close event, or after that node has restarted.
        if (!this._eligible(node, runtime) || probe.status !== 404
          || probe.value?.error?.code !== "METHOD_NOT_FOUND") throw new Error("No serving quorum");
        this._observeRecovery("quorumProbeMs", node);
        return { node, runtime };
      }));
    } catch { return null; }
    finally { round.abort(new Error("Leader discovery round finished")); }
  }

  /** Concurrent callers share one election/linearizability probe loop. */
  async discoverLeader({ timeoutMs = this.startupTimeoutMs } = {}) {
    positiveInteger(timeoutMs, "timeoutMs");
    const deadline = performance.now() + timeoutMs;
    try {
      while (performance.now() < deadline) {
        this._assertHealthy();
        if (!this._discovering) {
          const discovering = this._until("elect a leader with a serving quorum",
            (requestTimeoutMs) => this._probeLeader(requestTimeoutMs),
            Math.max(1, Math.ceil(deadline - performance.now())), { pollMs: 25 });
          // Clear once on settlement, before all waiting callers resume. They
          // recheck this slot, so only one can launch the next polling loop.
          const shared = discovering.finally(() => {
            if (this._discovering === shared) this._discovering = null;
          });
          this._discovering = shared;
        }
        const pending = this._discovering;
        const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
        let found;
        try { found = await waitForDiscovery(pending, remaining); }
        catch (error) {
          // A short-lived RPC retry may have created this shared polling loop.
          // Its budget must not shorten a recovery caller's longer deadline.
          if (error.code === "CLUSTER_WAIT_TIMEOUT" && performance.now() < deadline) continue;
          throw error;
        }
        this._assertHealthy();
        if (this._eligible(found.node, found.runtime)) {
          this.leader = found.node;
          return found.node;
        }
      }
      throw discoveryTimeout(timeoutMs);
    } catch (error) { error.clusterLogs = this.logTails(); throw error; }
  }

  /** Kill a leader, restore quorum service, then restart its durable data directory. */
  async crashLeaderAndRecover({ restartAfterMs = 250, timeoutMs = this.startupTimeoutMs } = {}) {
    if (this.nodeCount < 3) throw new Error("Leader failover requires a three-node cluster");
    if (!Number.isSafeInteger(restartAfterMs) || restartAfterMs < 0) throw new Error("restartAfterMs must be a non-negative integer");
    positiveInteger(timeoutMs, "timeoutMs");
    if (this._recovering) throw new Error("A leader crash is already in progress");
    const recovery = this._crashAndRecover(restartAfterMs, timeoutMs);
    this._recovering = recovery;
    try { return await recovery; }
    catch (error) { error.clusterLogs = this.logTails(); throw error; }
    finally {
      if (this._recovering === recovery) this._recovering = null;
      this._recoveryObservation = null;
    }
  }

  async _crashAndRecover(restartAfterMs, timeoutMs) {
    const previous = await this.discoverLeader({ timeoutMs });
    this._assertHealthy();
    const started = performance.now();
    const event = { oldLeader: previous.id, crashedAt: new Date().toISOString() };
    this.events.push(event);
    this._recoveryObservation = { event, started };
    previous.process.intentional = true;
    previous.process.child.kill("SIGKILL");
    this.leader = null;
    if (!await waitForExit(previous.process, 5_000)) throw new Error(`Killed node ${previous.id} did not exit`);
    // The stopped process is immediately ineligible, so RPC retries and this
    // recovery path can share exactly the same discovery loop.
    const next = await this.discoverLeader({ timeoutMs });
    event.newLeader = next.id;
    event.quorumRecoveryMs = performance.now() - started;
    const restartDelay = Math.max(0, restartAfterMs - (performance.now() - started));
    if (restartDelay) await delay(restartDelay, undefined, { signal: this._controller.signal });
    const target = (await this.metrics(next)).last_applied?.index ?? 0;
    this._startNode(previous);
    await this._until(`restarted node ${previous.id} catches up`, async (requestTimeoutMs) => {
      const response = await this._fetch(previous, "/raft/metrics", { timeoutMs: requestTimeoutMs });
      return response.ok && response.value.last_applied?.index >= target
        && Number(response.value.current_leader) === next.id;
    }, timeoutMs);
    event.restartCatchUpMs = performance.now() - started;
    return event;
  }

  logTails() {
    return this._generations.map((runtime, index) => ({
      node: runtime.id, generation: index + 1, pid: runtime.child.pid,
      exit: runtime.exit ?? null, error: runtime.error?.message ?? null, tail: runtime.logs.slice(-12_000),
    }));
  }

  async close() {
    if (this._closing) return this._closing;
    this._controller.abort(new Error("Benchmark cluster is closing"));
    this._closing = (async () => {
      // Let any in-flight port/directory allocation settle before collecting it.
      await this._starting?.catch(() => {});
      await Promise.all(this._reservations.map(releasePort));
      await Promise.all(this._generations.map(async (runtime) => {
        runtime.intentional = true;
        if (!runtime.ended) runtime.child.kill("SIGTERM");
        if (!await waitForExit(runtime, 1_000)) {
          runtime.child.kill("SIGKILL");
          if (!await waitForExit(runtime, 5_000)) throw new Error(`Could not stop Flower process ${runtime.child.pid}`);
        }
      }));
      await Promise.allSettled([this._recovering, this._discovering]);
      if (this.directory && !this.keepData) await rm(this.directory, { recursive: true, force: true });
    })();
    return this._closing;
  }
}
