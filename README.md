# Flower

The [web handbook](https://flower-js-org.github.io/runtime/) walks through application code, HTTP methods, scheduling, leases, and cluster operation. Its static GitHub Pages site lives in `docs/`, with `flower.js.org` in `docs/CNAME` pending domain setup. Each page file holds only its content; run `node scripts/build-docs.mjs` after editing to regenerate navigation, highlighting and redirects, and to check every link. The page list is `scripts/docs/pages.mjs`.

Flower is a working prototype of a **Raft-backed database of reactive TypeScript values**. TypeScript defines both the dependency graph and the database's public methods. Every external data read or write goes through a named method.

The [external worker guide](https://flower-js-org.github.io/runtime/guide/workers.html) designs reactive result reconciliation and durable job processing, including worker pools, sharding, and high availability. Its runnable [application](docs/reactive-worker.ts) and [client](docs/reactive-worker-client.ts) demonstrate conditional result publication.

The [architecture review](DESIGN.md) records the implemented improvements and larger experiments still under consideration. The [retention contract](RETENTION.md) covers bounded retries, acknowledgements, transaction closure, key lifecycle and recovery fencing.

```ts
import { collection, define, derive, mutation, query } from "./sdk/index.ts";

const counters = collection<number>("counters");

const doubled = derive("counter.doubled", (ctx, id: string) =>
  (ctx.get(counters, id) ?? 0) * 2,
);

const increment = mutation("internal.counter.increment", (ctx, id: string) => {
  ctx.set(counters, id, (ctx.get(counters, id) ?? 0) + 1);
  ctx.materialize(doubled, id);
  return ctx.get(doubled, id); // sees this mutation's writes
});

const get = query("internal.counter.get", (ctx, id: string) => ({
  count: ctx.get(counters, id) ?? 0,
  doubled: ctx.get(doubled, id),
}));

export default define({
  definitions: [doubled],
  http: {
    "counter.increment": increment,
    "counter.get": get,
  },
});
```

The complete [order example](examples/orders.ts) uses collections, equality queries, derived subtotals, input validation, mutation methods, and a public query. Bundles run in QuickJS inside Wasmtime. Each callback starts from an isolated pristine Wasm image; module globals do not persist between calls. Rust owns database state, transaction overlays, queries, and dependency-graph maintenance.

`import { nacl, jwt } from "@flower-js/sdk/crypto"` exposes native cryptography inside those callbacks: TweetNaCl's high-level byte API, HS256/RS256/ES256/EdDSA JWT signing and verification, and authenticated `dir`/`A256GCM` JWT encryption/decryption. Binary inputs go straight from Wasm memory to native code. Fresh randomness is mutation-only; JWT validation uses the invocation clock and disables stale query caching. See the [ticket example](examples/crypto.ts), [API and tradeoffs](https://flower-js-org.github.io/runtime/reference/crypto.html), and `node tests/e2e-crypto.mjs` after building the server.

[Managed keys and prepared-key caching](SECRETS.md) provision encrypted key catalogs separately from code, keep private material out of QuickJS, and reuse native prepared contexts under current authorization. Rotation, historical verification/decryption, retire/revoke/destroy and wrapping-key rewrap are supported.

## Install

Download the server archive for your platform from [GitHub Releases](https://github.com/flower-js-org/runtime/releases). Each archive contains the standalone `flower` server, its MIT license and third-party notices, with a SHA-256 checksum alongside. The server embeds QuickJS/Wasm and needs no Node installation.

For TypeScript applications and clients:

Npm publication is pending. The commands below apply once it is enabled; use a source checkout or the tested Actions tarball in the meantime.

```sh
npm install @flower-js/sdk
npx flower --help
```

```ts
import { collection, define, mutation, query, FlowerClient } from "@flower-js/sdk";
import { scheduler } from "@flower-js/sdk/scheduler";
import { workQueue } from "@flower-js/sdk/temporal";
```

The npm `flower` command builds modules, deploys and calls methods; the server executable is distributed separately. Use `./flower` to select a downloaded server if both commands are on your path. Node-specific H2 transport and bundling helpers are available from `@flower-js/sdk/http2` and `@flower-js/sdk/bundle`. Releases include compiled ESM and TypeScript declarations.

## Run it

Requirements: Rust 1.96 or newer, a C compiler for native dependencies, and Node.js 22.18 or newer for SDK/build tools. The server runs independently of Node.

```sh
npm ci
cargo build
```

On Nix, `nix develop -c cargo build` uses the pinned Rust 1.98.1 toolchain; the development shell also includes Node 26.10.0. `nix build` builds the standalone server without Node.

[OpenTelemetry reporting](TELEMETRY.md) adds opt-in request traces and detailed query, writer, evaluator, storage, and Raft metrics. The [benchmark profiler](bench/README.md#opentelemetry-reporting) captures a local report without a separate collector service.

Choose an operator token and use the same value in both terminals. It protects deployment, cluster administration, and peer RPCs; ordinary method callers do not receive it.

Start a single-node cluster:

```sh
export FLOWER_ADMIN_TOKEN='local-development-secret'
./target/debug/flower --id 1 --listen 127.0.0.1:7101 --data .flower/node1
```

In another terminal, initialize it **once**, deploy the example, and call its methods:

```sh
export FLOWER_ADMIN_TOKEN='local-development-secret'
node sdk/cli.ts init --members 1=127.0.0.1:7101
node sdk/cli.ts deploy examples/orders.ts

node sdk/cli.ts call order.create @examples/orders.create.json --request-id create-order-42
node sdk/cli.ts call order.get '"order-42"'
# value: { order: { shippingCents: 500 }, subtotal: 3200, total: 3700 }

node sdk/cli.ts mutate order.updateLine @examples/orders.update.json --request-id update-line-2
node sdk/cli.ts query order.get '"order-42"'
# value: { order: { shippingCents: 500 }, subtotal: 4600, total: 5100 }

node sdk/cli.ts watch order.get '"order-42"'
```

The cluster needs a brief election after initialization. If a request reports `UNAVAILABLE` immediately after bootstrap, retry when authenticated `/raft/metrics` reports `state: "Leader"`. Do not initialize again when restarting an existing data directory.

For three nodes, start three server processes with distinct IDs, listen addresses, and data directories, all sharing the operator token. Initialize once with the full membership:

```sh
node sdk/cli.ts init --members 1=127.0.0.1:7101,2=127.0.0.1:7102,3=127.0.0.1:7103
```

Point `--url http://127.0.0.1:7101` or `FLOWER_URL` at any reachable member. Servers forward mutations and deployments to the current leader, preserving request IDs across retries. Queries and watches execute on the addressed replica and remain fresh by default. Authenticated `/raft/metrics` exposes leadership for operators; SDK callers do not need it. `--advertise HOST:PORT` sets the peer address when it differs from the listen address. Three nodes tolerate one failed node; a minority cannot acknowledge mutations or serve strong reads. Application code can explicitly permit replica-local reads during quorum loss.

Raft defaults target a low-latency local network: 50 ms heartbeats and a randomized 150–300 ms election delay. OpenRaft also waits a 300 ms leader lease after the last leader contact, so failure detection normally starts an election after roughly 450–600 ms, plus timer ticks, network, storage, and scheduling delay. This is a timing policy, not a recovery-time guarantee. Strong reads and mutation acknowledgements still require a quorum.

For slower networks, storage, or heavily scheduled hosts, set the same overrides on every member before starting it:

```sh
export FLOWER_RAFT_HEARTBEAT_MS=200
export FLOWER_RAFT_ELECTION_MIN_MS=800
export FLOWER_RAFT_ELECTION_MAX_MS=1600
```

These environment-only settings are integer milliseconds in `1..3600000`, with `heartbeat < election minimum < election maximum`. The example restores the earlier conservative timing: a committed leader's failure detector waits about 2.4–3.2 seconds before election overhead. Lower values shorten recovery but can cause unnecessary elections when ordinary communication, durable writes, or runtime scheduling exceed the timeout. Keep the same values across the cluster; these settings do not alter durability or quorum requirements.

Run `npm run bench:stress` to measure serving-quorum recovery under the mixed workload, with a leader crash and an independent audit in every group; see the [benchmark guide](bench/README.md) for accounting and workload controls.

To run an automated temporary three-process cluster, including leader crashes and recovery:

```sh
cargo build
node tests/e2e.mjs
```

## Methods are the public interface

| Definition | Capabilities | External invocation |
| --- | --- | --- |
| `aggregate(name, options)` | Maintain indexed groups with add/remove deltas | Internal only |
| `transaction(name, planner)` | Coordinate exposed methods across Raft groups | Only when listed in `http` |
| `derive(name, fn)` | Read sources and derived values; return JSON | Internal only |
| `query(name, fn, options?)` | Read one consistent snapshot; fresh by default | Only when listed in `http` |
| `mutation(name, fn)` | Read, stage writes, change materialization, return JSON | Only when listed in `http` |

`define({ collections, definitions, http })` owns the complete HTTP allowlist. Definitions are private unless explicitly exposed in `http`; exposed methods are registered automatically. Public aliases can differ from internal names, and several aliases can share a method. Derived values cannot be exposed directly.

`POST /v1/call` invokes a public alias; Flower determines whether it is a query, mutation, or cross-group transaction from the deployed code. The SDK's `call` and CLI's `call` command use this endpoint. `/v1/query` and `/v1/mutate` use the same allowlist and additionally assert the method's kind. Unknown or removed aliases return `404 METHOD_NOT_FOUND`.

There are no public record, snapshot, transaction-patch, or raw changefeed endpoints. Callers cannot invoke a derived definition directly, invoke a mutation through the query route, or attach raw writes to a method call.

Query and mutation methods can contain arbitrary synchronous application logic, including argument validation and reads across collections. Methods decide what data to expose. TypeScript types assist authors; this version validates JSON structure but does not enforce application record schemas automatically.

Inside functions, `ctx.get(collection, key)` returns a record or `null`. `ctx.scan(collection, options?)` returns `{key, value}` rows. Options select an ordered `index`, constrain its `prefix` and `gt`/`gte`/`lt`/`lte` bounds, and apply `reverse`, `offset`, and `limit`. Without an index, scans order and constrain source keys. `ctx.query(collection.by(index).eq(value))` returns matching record values. Plain scans and equality queries use lexical primary-key order; multi-field equality indexes accept a tuple.

Declare indexed collections in `define({ collections: [orders], ... })` to persist equality and ordered scalar indexes and track dependencies. `aggregate` maintains retained group accumulators from changed rows; see the [complete indexed aggregate example](INDEXES.md). Use `ctx.range(ref.by(index).range({prefix, gte, lte, limit, after, reverse}))` for bounded `{rows,cursor}` pages; bounds select the field after the prefix. Cursors continue against the next invocation’s snapshot. Undeclared collections retain a Rust scan fallback. Ordered ranges conservatively depend on their entire index; equality queries depend on matching buckets.

Mutation methods additionally have `ctx.set`, `ctx.delete`, `ctx.materialize`, and `ctx.unmaterialize`. All reads see prior writes from the same invocation, including fresh derived results. A thrown method error aborts the entire mutation. Returning an error object is a successful result unless the method throws.

```ts
import { FlowerClient } from "./sdk/index.ts";

const client = new FlowerClient("http://127.0.0.1:7101");
const receipt = await client.call("counter.increment", "visits", {
  requestId: "visit-123",
});
// { revision, value, duplicate }

const result = await client.call("counter.get", "visits");
// { revision, value, duplicate: false }
```

### Spread reads across replicas

Queries and SSE watches evaluate on the node receiving the request. By default they are linearizable: the serving node obtains a quorum-backed read fence from the leader and waits until its own committed state has applied that fence before capturing a snapshot. This distributes query CPU across replicas while retaining fresh reads. Quorum loss can make fresh reads unavailable.

Configure read endpoints separately from the primary write URL:

```ts
const client = new FlowerClient("http://127.0.0.1:7101", {
  queryUrls: [
    "http://127.0.0.1:7101",
    "http://127.0.0.1:7102",
    "http://127.0.0.1:7103",
  ],
});
await client.query("counter.get", "visits");
// Concurrent queries rotate through these endpoints.
const updates = client.watch("counter.get", "visits");
```

`query()`, new `watch()`/`watchDeltas()` subscriptions, and new `watchPoll()` subscriptions share a round-robin endpoint list. Each watch stays on its selected endpoint for its lifetime. Mutations, deployments, initialization, and generic `call()` use the primary URL. That URL may name any reachable member: servers forward writes and deployments to the current leader with the original request identity. Initialization still addresses the uninitialized group directly. A query through `/v1/call` can run on a follower, but use `client.query()` to distribute SDK reads. Omitting `queryUrls` retains one-endpoint behavior. Endpoint selection does not change consistency, retry failed requests, or discover members automatically; the HTTP/2 transport pools a session per configured origin.

For a read that may tolerate lag, opt in within the deployed TypeScript:

```ts
const getLocal = query("internal.counter.local", (ctx, id: string) =>
  ctx.get(counters, id) ?? 0,
  { consistency: "replica-local" },
);
// Expose getLocal through define({ http: { "counter.local": getLocal } }).
```

Replica-local queries and watches use one coherent, locally applied committed snapshot without a per-read quorum fence. After startup recovery completes, they can run during a partition, but there is **no bounded-staleness guarantee**. A restarted node whose durable log extends beyond its recovered application checkpoint first needs a quorum-confirmed read fence and local replay before serving these reads. State, deployed code, and the HTTP allowlist can all lag; removing a local-read alias takes effect on a disconnected replica only when it applies that deployment. Separate calls on different replicas may return decreasing revisions. A deployed authorization hook or managed-key declaration requires fresh policy, so those queries and watches obtain a quorum-backed snapshot even when declared replica-local. Neither an HTTP caller nor a client option can weaken a method's declared policy. Omitting the option, or explicitly selecting `"linearizable"`, keeps fresh-read semantics; mutations and maintenance reject consistency metadata.

### HTTP/2 from Node.js

The same server port accepts HTTP/1.1 and HTTP/2. By default it serves cleartext h2c with prior knowledge; configuring the three `FLOWER_TLS_*_FILE` settings enables native TLS with h2/HTTP1 ALPN. HTTP/1.1 Upgrade is not supported. Internal traffic uses pooled HTTP/2 with verified HTTPS when TLS is enabled. See [TLS.md](TLS.md) for certificates, CA trust, separate peer/operator credentials and rotation.

To multiplex Node.js application calls over HTTP/2, use the optional transport:

```ts
import { FlowerClient } from "./sdk/index.ts";
import { createHttp2Transport } from "./sdk/http2.ts";

const transport = createHttp2Transport({ requestTimeoutMs: 10_000 });
const client = new FlowerClient("http://127.0.0.1:7101", {
  fetch: transport.fetch,
});
try {
  const result = await client.call("counter.increment", "visits", {
    requestId: "visit-over-h2-001",
    signal: AbortSignal.timeout(5_000),
  });
  console.log(result);
} finally {
  await transport.close();
}
```

The package subpath is `@flower-js/sdk/http2`. It is Node-only and stays out of application bundles and browser clients. It accepts `http://` and `https://` origins, reuses a multiplexed session per origin and buffers bounded ordinary JSON responses with a 30-second default whole-request deadline. SSE watches stream their response body immediately; that deadline covers response headers only, and the caller’s signal or `close()` controls their lifetime. `close()` cancels active streams and closes owned sessions. The transport does not automatically retry, redirect, or downgrade to HTTP/1.1; preserve request IDs after uncertain responses. Aborting a request stops waiting, not a mutation that may already have committed. HTTPS validates certificates and hostnames; optional `ca` accepts PEM strings, Uint8Arrays or arrays of them to replace the transport’s trusted roots. Otherwise Node’s configured trust defaults apply. There is no verification bypass.

An HTTP/2-enabled curl can check the cleartext listener:

```sh
curl --http2-prior-knowledge -i http://127.0.0.1:7101/health
```

### Retry-safe methods

An optional `expectedRevision` on mutations rejects stale writes. Keep the **same request ID and arguments** after an uncertain response. Request receipts persist the original method result, so retries after failover or code deployment return that result without executing the method again, provided the alias remains exposed as a mutation. Exposure is checked before receipt lookup: removing an alias also blocks retries through it. Reusing an ID with different request content is a conflict. Separate CLI invocations generate different IDs unless `--request-id` is supplied.

### Watch a query over SSE

`watch(query, args, {signal})` opens `POST /v1/watch` and yields reconstructed `{revision, value}` results. The server sends an initial snapshot, then JSON Patch deltas when the returned value changes; small replacements can use another snapshot. Unrelated revisions with identical values produce no event. Watch one query that returns all related values to keep a page consistent.

```ts
const stop = new AbortController();
for await (const { revision, value } of client.watch("counter.get", "visits", {
  signal: stop.signal,
})) {
  console.log(revision, value);
  // Break the loop or call stop.abort() to close the stream.
}
```

Identical invocations share evaluation, diffing, and immutable encoded updates within a node and logical database, scoped by the full admitted principal, deployment, and consistency. Each subscriber independently runs authorization and its read fence, including idle ticks; credentials are never shared. A consumer that misses a producer update receives a full reset snapshot at an increasing sequence. Patches always name the exact preceding sequence. Deployment or principal-scope changes end the stream with `WATCH_SCOPE_CHANGED` and require a new watch.

Use `watchDeltas(...)` to receive `{type: "snapshot", sequence, revision, value}` and `{type: "patch", sequence, baseSequence, revision, patch}` directly. Patches use RFC 6902 `add`, `remove`, and `replace`, with escaped JSON Pointer paths. SDK reconstruction isolates yielded values, so editing a received object does not corrupt the next update. Explicit `watchPoll(query, args, {intervalMs, signal})` retains polling compatibility; `intervalMs` does not apply to SSE.

Every reevaluation rechecks the exposed-query allowlist and its declared consistency. Fresh watches establish a quorum-backed read fence for each evaluation; idle clock-independent watches still check quorum on the 250 ms tick. Replica-local watches use the local applied state and registry, including their replication lag. Commits wake watchers; the tick reevaluates clock-dependent queries, which can change at the same revision. Tick processing can be delayed by load. Streams send updates immediately while their one-item output queue has room. When a changed update finds the queue full, they wait for space and batch intermediate changes into one refresh of the latest value, rechecking admission, the read fence and authorization before sending. This can skip intermediate commits. There is no fixed watch-count ceiling. Each stream has bounded buffering and a configurable timeout for waiting for room to send a changed update (five seconds by default); the shared node preparation pool bounds evaluation concurrency. Refresh and heartbeat intervals are configurable too.

A terminal server error becomes `FlowerError` and closes the watch. The SDK does not reconnect automatically: start a new watch after a disconnect, on any reachable replica that can serve its consistency policy. `queryUrls` spreads new subscriptions but never moves an existing stream. Every new connection begins with a full snapshot at the shared producer’s current sequence (which may be nonzero); `Last-Event-ID` does not resume history. This is a live view, not a durable event log. Both HTTP/1.1 and the Node HTTP/2 transport support watches.

### A live pizza dashboard

The [Goblin Pizza dashboard](examples/pizza-dashboard) watches **one `pizza.dashboard({tenant})` value** for the selected tenant's stores, orders, timers, delivery leases, and leaderboard. New streams rotate across running replicas; switching tenants closes the previous stream. **This observational view is replica-local: data, code, and aliases may lag without a bound, and reconnecting can show an older revision even while connected.** The page labels this policy and marks disconnected data. Countdown labels use approximate local time; mutations determine actual deadlines.

```sh
cargo build --release --bin flower
npm run demo:pizza
# Optional fixed port, initially paused arrivals, and automatic shutdown:
npm run demo:pizza -- --port 3030 --paused --duration 120
```

Open the printed local URL. The launcher creates a fresh three-node Rust/QuickJS cluster with three tenants and two stores each, runs tenant-scoped delivery workers, and offers buttons to place an order, tip a kitchen, pause arrivals, or crash the leader. Pausing arrivals leaves workers running. Order creation is capped at 160 attempts, including button clicks; workers continue polling until shutdown, and the board includes the latest 120 orders while totals cover the whole run. Ctrl+C stops owned processes and removes their temporary data. It never attaches to an existing database.

Store identity is the tuple `[tenant, store]`. Shops use its canonical JSON encoding as a key; order keys encode `[tenant, store, orderId]`. Different tenants and stores can reuse the same local order ID. Each tenant has its own delivery queue and derived leaderboard. Store summaries and order totals are materialized; rankings compute from those summaries when read, so tips do not sort or replicate whole rankings. The scheduler uses composite timer IDs; order and dashboard queries use the durable store index.

```ts
await client.mutate("pizza.setup", {
  tenants: ["goblins", "elves"], storesPerTenant: 2,
  stockPerShop: 1_000, bakeMs: 1_800, leaseMs: 4_000,
});
await client.mutate("pizza.order", { shop: ["goblins", "store-0"], id: "lunch", quantity: 2 });
await client.query("pizza.shop.local", ["goblins", "store-0"]); // may lag
await client.query("pizza.shop", ["goblins", "store-0"]);       // fresh
const { value: job } = await client.mutate("pizza.claim", { tenant: "goblins", owner: "drone-1" });
if (job) await client.mutate("pizza.deliver", { tenant: "goblins", id: job.id, owner: job.owner, token: job.token, ...(job.history ? { history: job.history } : {}) });
```

Customer previews use `pizza.shop.local` by default in the benchmark; pass `--read-consistency fresh` to compare fresh reads. `pizza.world(null)` stays a fresh, group-wide audit method. Tenant keys provide logical separation in this unauthenticated demo; they are **not authorization**. A production application must bind allowed tenants to authenticated callers. Independent Raft groups can host disjoint tenant sets; the benchmark explicitly routes each complete tenant to its configured group, without automatic partition discovery.

## Durable scheduled business logic

Use the [TypeScript scheduler](sdk/scheduler.ts) to run a private method after a deadline. It stores named callbacks and JSON arguments as ordinary records. Scheduling a callback inside a mutation commits the timer and the business update together.

```ts
import { collection, define, mutation, query } from "flower";
import { scheduler } from "@flower-js/sdk/scheduler";

const invoices = collection<{ total: number; status: string }>("invoices");
const finalize = mutation("internal.invoice.finalize", (ctx, id: string) => {
  const invoice = ctx.get(invoices, id);
  if (invoice) ctx.set(invoices, id, { ...invoice, status: "ready" });
  return null;
});
const timers = scheduler("invoiceTimers", { finalize });

const update = mutation("internal.invoice.update", (ctx, args: { id: string; total: number }) => {
  ctx.set(invoices, args.id, { total: args.total, status: "draft" });
  return timers.after(ctx, `finalize:${args.id}`, 5_000, "finalize", args.id);
});
const get = query("internal.invoice.get", (ctx, id: string) => ctx.get(invoices, id));

export default define({
  collections: [timers.records],
  maintenance: timers.maintenance,
  http: { "invoice.update": update, "invoice.get": get },
});
```

Every update replaces the pending timer with the same ID. The example finalizes an invoice after five seconds without another update. Use a distinct ID for each update when every update needs its own later action. This is explicit application code in the mutation method, so derived functions remain pure.

`timers.at(ctx, id, epochMilliseconds, handler, args)` sets an absolute deadline. `cancel` removes a pending or failed timer, `get` and `scan` inspect timers, and `retry` requeues a failed timer. Handler aliases come from the scheduler's TypeScript registry and are separate from HTTP aliases. Captured closures are not serialized; arguments are JSON, and pending timers use the currently deployed handler code. Renaming a handler requires migrating pending records or keeping its old alias available.

One due callback runs per maintenance transaction, selected through the declared `(state, dueAt)` index and ordered by deadline and ID. Its database changes and timer removal commit atomically through Raft. A callback may reschedule its own ID, including to implement recurring work. If it throws or exhausts its execution budget, the host discards all its writes and runs a separate private error handler against the original snapshot. That TypeScript handler records the error and applies bounded retries with backoff, eventually retaining a failed timer for inspection. Other due timers remain eligible between retries.

The scheduler's third argument configures `{maxAttempts, retryDelayMs, maxRetryDelayMs}`. Defaults are three attempts, an initial 1,000 ms retry delay, and a 60,000 ms cap. Delays double after each failure and start when the failed attempt finishes. Replacing a timer or explicitly retrying a failed timer starts a new attempt budget. If the private error handler itself fails, neither patch commits; the error is logged and replacement code can be deployed.

Deadlines mean **not before**, using Flower's server time. Execution can be late during load, elections, or quorum loss. A 250 ms maintenance poll starts a bounded catch-up burst when callbacks remain due. Each callback has its own transaction; a burst stops at its serialized-batch budget or after an invocation takes it past the configured time window, 50 ms by default. Timer records survive restart and failover. Callback code can execute again before a successful commit, while the timer removal and database effects commit together once for that timer. For network calls or other external work, have the callback enqueue a job for the leased worker queue.

The complete [scheduling example](examples/scheduling.ts) includes delayed business updates, cancellation, and timer inspection. TTL deletion can be just another scheduled callback; the expiration helper below additionally hides expired values before physical cleanup runs.

## Worker leases and expiring keys

These policies live in [TypeScript helpers](sdk/temporal.ts), built from ordinary records and methods. The [worker example](examples/workers.ts) exposes enqueue, claim, complete, fail, retry, and expiring-cache methods. Deploy it to a fresh cluster with `node sdk/cli.ts deploy examples/workers.ts`.

```ts
import { expiringCollection, workQueue } from "./sdk/temporal.ts";

const jobs = workQueue("jobs", { maxLeaseMs: 30_000 });
const sessions = expiringCollection("sessions", {
  expiration: { afterUpdateMs: 60_000 },
});
const tokens = expiringCollection("tokens", {
  expiration: { afterCreationMs: 10_000 },
});
```

Inside mutation methods, `jobs.enqueue(ctx, id, payload)` creates work and `jobs.claim(ctx, owner, leaseMs)` atomically claims one available job, returning `{id, payload, owner, token, expiresAt, attempt, history?}` or `null`. Expired claims become available again even if cleanup has not run. The configured maximum bounds each claim; there is no renewal operation.

`jobs.complete(ctx, identity, result)` and `jobs.fail(ctx, identity, error)` require the current, unexpired claim. Pass its `{id, owner, token, history?}` fields unchanged; after retention initialization, the optional history binds database/incarnation and rejects restored-history claims. Each new claim gets a strictly increasing fencing token, retained independently of job deletion or replacement. An old worker cannot finish a newer worker's claim. Failed jobs remain visible until explicitly retried with `jobs.retry(ctx, id)`; `jobs.get(ctx, id)` reports the current effective state.

For example, a worker calling the deployed example uses:

```ts
import type { Claim } from "./sdk/temporal.ts";

const claimArgs = { owner: "worker-1", leaseMs: 10_000 };
const { value: lease } = await client.call<typeof claimArgs, Claim | null>("jobs.claim", claimArgs);
if (lease) {
  // After doing the work, send the claim's id, owner, and token:
  await client.call("jobs.complete", {
    id: lease.id, owner: lease.owner, token: lease.token,
    ...(lease.history ? { history: lease.history } : {}),
    result: { processed: true },
  });
}
```

Check for a `null` claim before starting work. Use stable request IDs for retries of one invocation. A retried claim returns its original receipt and can already be expired; use a new request ID to acquire fresh work. Lease expiry cannot stop a worker process or undo external effects. Downstream services should enforce fencing tokens or accept idempotency keys when duplicate work would matter.

Expiring collections provide `set`, `get`, `entry`, `scan`, `delete`, and `sweep`. Reads hide a record at `ctx.now() >= expiresAt`, including inside reactive functions. `entry` returns its value and `createdAt`, `updatedAt`, and `expiresAt` metadata. Updates preserve a live record's creation time; replacing an expired record starts a new lifetime.

Each `set(ctx, key, value, expiration?)` uses its supplied policy or the collection default. Supported policies are `{afterCreationMs: n}`, `{afterUpdateMs: n}`, `{at: epochMilliseconds}`, and `null` for no expiry. The override applies to that write. Absolute deadlines let TypeScript implement other rules, such as the earlier of an idle timeout and a maximum lifetime. Internal code can access `.records` for raw envelopes; application methods should use the helpers when they want expiration filtering.

Expiry after access can be an ordinary mutation method that reads the live value and writes it back with an updated deadline. Policies remain application code; a read-only query never silently refreshes a lifetime. The helpers are also available through the package's `@flower-js/sdk/temporal` export.

Declare `cache.records` and `jobs.records` in `define({collections})` for indexed expiry and lease selection. Work queues support `{scope: tenant}` on one shared backing collection; their raw keys are canonical `[scope,id]` tuples. `queue.scan(ctx)` inspects only the selected scope. Claims seek pending jobs and inspect expired leases in bounded pages to preserve creation-order FIFO; completed history and valid leases are excluded. Scopes provide logical separation, not authentication.

For physical cleanup, register a private mutation with `define({ maintenance, http, definitions })`. The example's maintenance method calls `cache.sweep(ctx)` and `jobs.sweep(ctx)`. Flower attempts this on the leader every 250 ms, with an ordinary atomic mutation context and `null` arguments. The handler is not callable over HTTP unless separately exposed. Its code and registration replicate with the bundle. Exceptions roll back cleanup; public methods and deployment remain usable. Cleanup can be delayed by load, election, or quorum loss, and must be safe to repeat. Idle sweeps do not advance revisions; actual changes can invalidate `expectedRevision`. Background commits do not accumulate client retry receipts.

A maintenance result containing `{ $flower: { continue: true } }` requests another invocation against its successful staged patch. The host stops after the first invocation that takes the configured burst past its time budget (50 ms by default), when the serialized Raft batch would exceed its byte budget, or on an idle patch. There is no independent callback-count cap. The scheduler supplies this hint when more timers are already due. Each invocation gets a fresh time, resource budget, rollback boundary, and application revision. Successful patches share a durable group commit; a later callback failure still allows the preceding successful patches to commit. Handlers without the hint retain the ordinary polling cadence.

`ctx.now()` is the small host primitive behind these helpers: a fixed epoch-millisecond timestamp for the entire evaluation, including all derived previews. Mutations commit it with their changes, and future mutations never move behind committed time. Queries use a fresh timestamp and temporarily refresh time-dependent derived values without writing. Reactive clock dependencies update on mutations and maintenance; source-only applications need no background handler.

Time comes from the serving node, bounded below by committed time and the process's monotonic clock floor. Keep node clocks synchronized for accurate real-time durations: skew can expire a lease early or delay expiry, and query timestamps can move back between serving nodes when an earlier query's time was never committed. Fresh-read guarantees concern database state, not synchronized clocks. Deadlines are checked at invocation time, so slow evaluation or commitment may consume the remaining lease before the response arrives. Claims return an absolute deadline; successful acquisition is not a guarantee of a full duration remaining at receipt.

## Reactive semantics

A materialized root maintains its transitive derived dependencies. Instance identity is `(definition name, canonical JSON argument)`; omitted arguments mean `null`. Removing a root collects derived instances that are no longer reachable. Querying an unmaterialized derived instance evaluates it temporarily without persisting it.

Dependencies follow actual reads, including missing records. Scans and equality queries on undeclared indexes depend on their entire collection. Queries on declared durable indexes depend on the matching equality bucket and rows, including inserts into a previously empty bucket. Successful evaluations replace old dependencies. Failed evaluations retain old and newly observed dependencies to allow recovery.

Ordinary derived exceptions become stored error outcomes and propagate to dependents. A method may catch such an error intentionally. Cycles and shared transaction-budget failures abort the proposal even if application code tries to catch them. Failed computed values are not served as their previous successful result.

Unchanged source values do not invalidate. For a single changed dependency, unchanged derived outcomes stop downstream propagation; multiple dirty branches conservatively retain the full dependency order. Explicit aggregates update retained accumulators from changed rows; see [indexes and reducers](INDEXES.md) for their callback contract and rebuild behavior.

Functions return finite JSON values. There is no network, filesystem, process, timer or ambient date access. Mutation-only crypto entropy comes from the native OS CSPRNG; it is separate from deterministic business PRNG state. Queries and derived values cannot request fresh crypto randomness. Time is supplied through `ctx.now()`; other external facts enter through mutation methods. Promises, nonfinite numbers, sparse arrays, cyclic objects, and other unsupported values are rejected instead of silently serialized.

Deployment uses a SHA-256-addressed JavaScript bundle. Initialization, the HTTP allowlist, and optional maintenance registration are checked before activation; changed bundles recompute live instances. Code, registrations, input changes, dependencies, and derived outcomes publish atomically. These are included in durable state and snapshots. A failed deployment leaves the previous code and registrations active. Deployment does not run the old maintenance handler, so a broken handler can be replaced.

Applications register definitions, indexed collections, and public aliases through `define({ definitions, collections, http })`, with optional maintenance. No methods are exposed without an explicit HTTP allowlist. Flower is unreleased; APIs and stored/wire formats may change without backward compatibility or a migration path.

## Replication

The leader evaluates mutations outside the async consensus runtime, then proposes a concrete batch containing the expected revision, changes, and method result. OpenRaft orders the batches; followers apply replicated changes without reexecuting those mutations. Every replica can execute query methods against its applied committed state. Compare-and-set validation prevents obsolete computations from replacing newer state.

Redb stores votes, logs, applied indexes, application state, receipts, and snapshot checkpoint metadata. Mutation acknowledgements wait for a quorum to durably retain the Raft log entry and for local atomic application. Votes and log appends use immediate durability. Application checkpoints can lag after a crash; committed log entries reconstruct the missing records and receipts without reexecuting TypeScript. Snapshots include code, its HTTP allowlist, and dependency metadata, allowing recovered nodes to become leaders and evaluate future methods.

Application records and request receipts use separate redb tables. Each apply writes changed records, receipts, revision, membership, and applied-index metadata in one atomic redb transaction with deferred durability (`Durability::None`), then publishes the committed snapshot. It does not perform another fsync for every apply. A subsequent immediate log, vote, snapshot, or purge transaction also makes prior apply checkpoints durable. Raft snapshot checkpoints retain immediate durability but write only metadata: the existing application tables are the recovery source. Full transfer images are encoded lazily into temporary files when a peer reads them, preserving a consistent captured state without repeatedly storing another copy. Snapshot installation and log purging retain immediate durability. This reuses the existing redb log and transaction engine; it does not introduce a separate WAL or background checkpoint scheduler.

At startup, a durable log beyond the recovered applied position arms a serving barrier shared by all logical partitions on that node. A recovering leader first quorum-commits and applies a fresh internal recovery entry; followers obtain its read fence and wait for local application. This confirms the chosen log prefix even when the same leader and term resume after a crash, without assuming every durable tail entry was committed. The recovery entry changes no application records, revisions or receipts. Until recovery succeeds, even replica-local application reads can be unavailable; peer traffic and operator diagnostics remain available. Once released, replica-local reads again need no per-read quorum.

Opening supported data migrates checkpoint metadata forward and marks the prior format unreadable by older binaries. Downgrading that directory is unsupported. The state-machine compatibility contract rejects mixed pre-graph-generation and current nodes; use a coordinated upgrade rather than treating this change as a compatible rolling release. Unsupported older redb formats remain rejected. Other compatible builds can follow the [rolling-upgrade procedure](MEMBERSHIP.md).

Concurrent mutations enter a bounded queue and share durable Raft commits. By default, the writer adapts group size to measured preparation cost, durable commit time, and queued work. Idle requests start immediately. Preparation has a 50 ms maximum window, and serialized commands including the batch envelope have a 32 MiB allowance. Adaptive mode has no fixed command-count cap; admission capacity bounds retained requests, and an explicit batch-size setting can impose a cap. These are [operator settings](bench/LIMITS.md); fixed mode is available for comparisons. Each method sees preceding staged writes and retains its own revision, retry receipt, and rollback boundary. Replies wait for durable quorum commitment and local application of the group. A full queue returns `503`; clients can retry the same request ID. Under sustained load, the writer overlaps preparation of the next group with durable quorum commitment and local application of the current group. It coalesces later arrivals while an existing predecessor commits, without adding an idle batching delay. Its private snapshot shares immutable data and retry history; queries and SSE continue to see only committed state. A failed or uncertain commit discards the prepared successor, returns retryable errors, and starts the next window from a fresh quorum read. Within a group, bounded preparation waves can run concurrently. The ordered lane validates read/negative/index-range dependencies, write bases, code/policy and reactive dependency shape against preceding staged changes; it reauthorizes the complete principal and rechecks retry/CAS/transaction-lock rules. Invalid candidates rerun serially. Every wave shares one fixed time, and discarded entropy/results are never published. Hot conflicts reduce the speculative width and add serial cooldown. `FLOWER_WRITER_PREPARATION_WORKERS` defaults to the shared preparation-worker count; set it to 1 for serial preparation. Shared admission reserves active memory, and candidate output stays byte-accounted through its durable group. Deployments drain the pipeline, and maintenance gets a turn between bounded 250 ms writer windows (checked between methods, so a slow callback can exceed the window).

Initialization rejects duplicate peer addresses. Raft RPCs check the target and responding node IDs, so two addresses pointing at the same process cannot count as two voters.

Public queries are linearizable by default: a replica obtains the leader's quorum-backed applied-index fence, waits for local application, then captures a snapshot. After the startup recovery barrier, explicit replica-local queries skip per-read fences and can return older state and code. Query execution has no durable effects and never sees the writer's speculative successor batch. Every acknowledged mutation publishes its final source records and materialized results at one revision.

### Upgrading existing storage

Current builds use redb 4.3. Legacy redb v2 data files are unsupported.

## Control plane

`POST /admin/deploy` accepts a bundle and request ID. `/raft/initialize` and `/raft/metrics` require `Authorization: Bearer <operator-token>`; internal peer RPCs use the separately configurable peer credential. Deployment and cluster administration are privileged operations separate from application methods. `/health` checks process availability without reading database data or establishing quorum.

Native TLS protects HTTP/1.1 and HTTP/2 when configured; cleartext h2c remains the default for local experiments. Set a distinct `FLOWER_PEER_TOKEN` to separate internal traffic from `FLOWER_ADMIN_TOKEN` operator endpoints (omission falls back to the operator token). Deployed `define({authorize})` code establishes end-user principals; Flower does not supply an identity provider. Trusted peers can replicate state and forward privileged work, so route separation is not a sandbox for compromised peers. See [TLS.md](TLS.md) for the exact trust and rotation contract. The embedded runtime has not undergone a security audit.

## Tests and boundaries

Goblin Pizza Express is a complete TypeScript example: durable oven timers bake
pizzas, delivery drones claim leased work, and reactive kitchen summaries feed a
leaderboard. Its benchmark runs a fresh local Raft cluster, drives concurrent
customers and drones, replays requests, abandons leases, and independently audits
inventory, money, jobs, timers, and derived results.

```sh
cargo build --release --bin flower --bin flower-bench-driver
npm run bench
npm run bench:stress     # More concurrency plus a leader crash during load
npm run bench -- --help
```

See [the example](examples/goblin-pizza.ts) and [benchmark guide](bench/README.md)
for workload controls and measurement limits. Reports default to
`bench/results/latest.json` and a self-contained HTML report with charts at
`bench/results/latest.html`. Use `--baseline earlier.json` for a before/after
comparison. Any invariant violation, unexpected request failure,
or incomplete drain makes the command fail.

```sh
npm run check          # Types, SDK, dependency engine and randomized differential checks
cargo test            # QuickJS, allocation budgets, storage conformance and real Raft recovery
cargo build
node tests/e2e.mjs     # Methods → HTTP → QuickJS → three processes, including SIGKILL failover
node tests/e2e-http2.mjs # Multiplexed HTTP/2 methods, HTTP/1 compatibility, and failover
node tests/e2e-watch.mjs # SSE deltas, clocks, revocation, cancellation, HTTP/2 and reconnect
```

One leader per Raft group orders mutation commits and eagerly maintains affected values; safely validated preparation can run concurrently. Evaluations share immutable Rust record trees and copy only changed paths; normal storage applies persist only changed records. Quorum reads use a separately published committed snapshot, so a later storage transaction does not hold their snapshot lock. Live application state remains memory-resident. Retry retention is opt-in: replicated epoch floors and explicit session acknowledgements collect results without reviving old intents; uninitialized databases retain receipts indefinitely. Distributed transaction detail can be collected after durable participant closure floors; admissible aborted retry IDs and incomplete transactions block closure. See [RETENTION.md](RETENTION.md) for the exact contract and restore tradeoffs. Cluster nodes must share the compatibility contract, and restarted binaries must support their local data format.

Evaluation uses configurable deadlines and memory/byte budgets. Defaults are five seconds, 128 MiB of aggregate live guest linear memory, 128 MiB of estimated Rust transaction allocation, 2 MiB of source, 16 MiB of evaluation input/output, and an 8 MiB HTTP body. For undeclared indexes, an optional temporary equality-index cache retains up to 16 MiB and falls back to scanning when full; declared indexes are durable records. These are not process RSS caps. Genuine recursive-stack and wasm32 representation bounds remain; see the complete [limits audit and configuration reference](bench/LIMITS.md).

Each node defaults to one query worker per available CPU, independently of its ordered writer lane. Fresh reads on every replica batch concurrent quorum proofs, sealing each cohort before the proof begins; a later arrival always needs a later proof. SSE uses the same declared consistency and can be distributed across replicas. HTTP/2 advertises no concurrent-stream ceiling by default; operators can configure one.

The server embeds a [vendored QuickJS-NG guest](vendor/quickjs-ng) built from pinned upstream sources. Its only Wasm imports are Flower's database and crypto bridges: it has no WASI runtime, filesystem, networking or ambient clock. Mutation-only crypto entropy is supplied through the native capability bridge. A small C bridge binds arguments, loads optional bytecode, and invokes the callback in one Wasm entry. Normal Rust builds embed the checked-in guest and need no guest cross-compiler or WASI SDK.

The server shares a Wasmtime engine, compiled modules, linked imports, pristine memory images, and pooled instance allocations. Every callback receives the same isolated logical state, either in a new Store or in a completely restored resident instance. A 4 KiB input allocation reserved in each image avoids an extra guest allocator call for small invocations; larger inputs allocate normally. Input bytes reset between callbacks and count toward the usual memory budget. Default bundles restore a base QuickJS sandbox and load cached QuickJS bytecode, preserving per-invocation module initialization. For modules whose initialization is independent of invocation bindings, opt into a fully initialized application snapshot:

```sh
node sdk/cli.ts build examples/orders.ts orders.flower.json --initialization static
node sdk/cli.ts deploy orders.flower.json
# Or build and deploy in one step:
node sdk/cli.ts deploy examples/orders.ts --initialization static
```

The equivalent SDK option is `buildBundle(path, { initialization: "static" })`. Static initialization runs before invocation bindings exist; methods receive all request information through their context and arguments. The mode is part of the hashed bundle. Closures, globals, prototypes, and guest memory reset to that pristine snapshot for every callback. Wasmtime uses file-backed copy-on-write images where the host supports them. Before capturing a base or initialized application image, the host collects unreachable QuickJS cycles and resets the collection threshold to live allocated bytes plus 50%, its normal post-collection policy. Automatic collection and execution/memory limits remain enabled. Frozen method and derived context objects are constructed during trusted setup, before application initialization; overriding `Object.freeze` in application code does not intercept that construction. Cached application images are bounded; heap mutations never carry into another callback. The original JavaScript coordinator remains a test-only differential oracle, executed through the same vendored Wasm engine. No native JavaScript engine is linked.

A synchronous serial mutation batch may retain instances on its blocking worker thread. Before reuse, it restores linear memory and every mutable numeric Wasm global, replaces host callbacks and authorization/key caches, and charges the next invocation’s memory budget anew. Linux and macOS track the exact set of pages ever written in that instance: untouched pages stay read-only, and every previously written page is copied from the pristine image after each callback. Other platforms, or `FLOWER_WASM_DIRTY_PAGES=0`, use full-memory copies. Traps, growth and failed evaluations discard the instance; batch completion releases idle instances. `FLOWER_WASM_RECYCLE=0` disables resident reuse. `FLOWER_WASM_RECYCLE_BYTES` bounds idle linear memory per process (96 MiB by default); zero or an image larger than the allowance bypasses retention without rejecting the callback. This trades retained memory and pool slots for fewer allocations and page faults; see the [resource limits](bench/LIMITS.md).

Successful clock-independent query results can be reused for identical method arguments and authenticated principal across unrelated committed revisions. Every request still checks the HTTP allowlist and its declared consistency; fresh reads establish a quorum fence even on a cache hit. Identical concurrent cacheable reads share their first evaluation. Calls to `ctx.now()`, including through computed dependencies, disable this optimization; so does any stored clock dependency. Each hit validates a dependency certificate against its selected snapshot: present/missing records, collection and index membership, derived outcomes, code, schema, and managed policy. Certificates retain weak allocation identities rather than old JSON payloads. Matching index rows track value changes while unrelated equality buckets can remain cached. Each logical database retains up to `FLOWER_QUERY_CACHE_BYTES` (default 16 MiB) of estimated result/key/certificate data; `FLOWER_QUERY_FLIGHT_BYTES` (default 512 KiB) bounds the active shared-evaluation registry. Zero disables either tier, and there is no entry-count ceiling. Certificates are process-local optimization metadata, rebuilt from immutable applied state after restart or snapshot installation; they neither persist nor replace Raft durability or the selected read fence.

Public HTTP cache hits use a bounded probe without waiting for heavy preparation. `FLOWER_QUERY_WORKERS` bounds concurrent probes and authorization callbacks; heavy query evaluation instead shares `FLOWER_PREPARATION_WORKERS` with writers and watches. Probes try a slot immediately, reserve retained input/key bytes, and keep all current registry, policy, transaction and certificate checks. A miss or busy probe releases its temporary snapshot before entering normal fair admission and capturing a new one. Applications with authorization hooks or managed keys keep the full admitted path; SSE behavior is unchanged. The encoded response reserves shared user bytes through transport, even if its cache entry is evicted, and retains no snapshot or evaluation slot. See the [resource budget reference](bench/LIMITS.md) for the memory and fairness tradeoffs.

Reactive invalidation discovers potentially affected cells, then skips a parent callback when its only changed derived dependency produces the same outcome. Dependency changes still update graph edges, cycle checks, and collection. Parents with several potentially changed branches rerun in application read order, so an obsolete branch cannot introduce a spurious cycle. This reduces callback work; it does not eliminate the initial invalidation walk.

Durable equality indexes and incremental aggregates, membership changes and compatible rolling upgrades, and cross-group transactions are implemented:

- [Indexes and reducers](INDEXES.md): declare collection indexes; update retained totals using row deltas.
- [Membership and rolling operation](MEMBERSHIP.md): catch up learners, change voters through joint consensus, and restart compatible builds one member at a time.
- [Cross-group transactions](TRANSACTIONS.md): code-owned plans, durable two-phase commit, and recovery after failure.

Distributed preparation blocks fresh reads and writes in each participating logical partition (or default group namespace) until its durable decision is applied; unrelated named partitions continue serving, and opt-in replica-local reads may observe older state. Direct deployment supports optimistic preparation and an explicit blocking fallback. The [staged deployment API](INDEXES.md#resumable-staged-deployment) durably backfills indexes and rebuilds materialized roots in separate pages while source mutations maintain both graph generations, then atomically activates code/policy/indexes and the prepared graph. Each root dependency closure and clock/key refresh still obeys evaluation budgets. Ordinary derived functions reevaluate when invalidated, with unchanged intermediate outcomes stopping eligible downstream work. External actions remain outside database callbacks.

The [architecture review](bench/ARCHITECTURE.md) explains the remaining boundaries: independent groups, shared tenant costs, read-cache invalidation, cross-group coordination, and durable-history growth.

Publish the first npm package manually, then configure its trusted publisher; subsequent version tags publish through OIDC automatically, with no enable flag or token secret. See [RELEASING.md](RELEASING.md) for the exact setup.

## License

Flower is [MIT licensed](LICENSE-MIT). Bundled third-party code retains its own licenses and notices.

## Movable partitions and group resizing

A named partition is a complete logical database: application bundle, source and derived state, indexes, timers, lease counters, revision, and retry receipts. Several partitions can share a physical Raft group and execute independent writer preparation. Moving a partition briefly pauses that database; unrelated partitions continue, subject to shared CPU, disk and Raft contention. Existing tenant keys in the default database are not automatically extracted into partitions.

Configure participating servers with `FLOWER_GROUP`, `FLOWER_CATALOG_GROUP`, and `FLOWER_GROUPS` (bootstrap host:port peers for the local group and catalog). Provision and initialize physical groups separately, then register them through any configured gateway:

```ts
import { FlowerClient } from "@flower-js/sdk/client";

const cluster = new FlowerClient("http://catalog-1:7101", {
  adminToken: process.env.FLOWER_ADMIN_TOKEN,
});
await cluster.registerGroup({ id: "west", addresses: ["west-1:7101", "west-2:7101", "west-3:7101"] });
await cluster.createPartition("tenant-a", "west", { requestId: "create-a" });
await cluster.waitForPartition("tenant-a");
const tenant = cluster.partition("tenant-a"); // deploy and invoke its code-owned methods
// After registering another initialized group named east:
await cluster.resize(["west", "east"], { requestId: "grow-to-two" });
console.log(await cluster.layout());
```

`resize` durably balances partition counts, moving one partition at a time. It neither starts servers nor balances bytes or measured CPU. Live pre-copy, source freeze, final difference transfer, catalog cutover, destination activation and source retirement are recoverable and idempotent. The source keeps serving while its durable base is copied. After a brief freeze it sends changed records and receipts, including deletions; a large difference falls back to a full frozen image. Migration rolls forward after it starts; unavailable required groups can prolong the frozen phase. An interrupted client does not cancel the work. Logical-partition transaction methods are supported; freeze waits for unresolved participants and coordinators while completion remains available.

Active routes are cached for `FLOWER_ROUTE_CACHE_MS` (default 1,000 ms). Expired routes require the catalog; a catalog outage then affects named calls and watches. Native epoch/status checks independently fence writes and fresh reads. Streams terminate on ownership changes; reconnect at the stable partition URL for a fresh snapshot. Migration retains a durable base until retirement, and export caches the complete encoded base, difference, or fallback image in memory despite chunked transport. Optional `FLOWER_PARTITION_BASE_MAX_BYTES` bounds base admission and `FLOWER_PARTITION_TAIL_MAX_BYTES` chooses when to fall back to a full frozen transfer; neither is set by default. Partition names are logical boundaries, not authentication. The [complete SDK and operations reference](https://flower-js-org.github.io/runtime/reference/partitions.html#partitions) documents every method, phase, default and tradeoff.
