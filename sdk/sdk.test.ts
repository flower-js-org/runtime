import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { collection, define, derive, query, mutation, canonicalJson, FlowerClient, FlowerError } from "./index.ts";
import { buildBundle } from "./bundle.ts";

test("index descriptors support scalar and composite equality", () => {
  const records = collection<{ owner: string; active: boolean }>("records")
    .index("owner", ["owner"])
    .index("ownerActive", ["owner", "active"]);
  assert.deepEqual(records.by("owner").eq("alice"), {
    kind: "query", collection: "records", fields: ["owner"], value: "alice",
  });
  assert.deepEqual(records.by("ownerActive").eq(["alice", true]), {
    kind: "query", collection: "records", fields: ["owner", "active"], value: ["alice", true],
  });
  assert.throws(() => records.by("missing"), /Unknown index/);
  assert.throws(() => records.index("owner", ["owner"]), /already declared/);
  assert.throws(() => records.by("ownerActive").eq("alice"), /2-element tuple/);
  assert.throws(() => records.by("owner").eq(Number.NaN), /finite numbers/);
  assert.equal(JSON.stringify(records).includes("function"), false);
});

test("definition names and index names safely handle prototype names", () => {
  const definition = derive("__proto__", () => 42);
  const { definitions } = define({ definitions: [definition, definition] });
  assert.equal(Object.getPrototypeOf(definitions), null);
  assert.equal(definitions.__proto__.compute({} as any, null), 42);
  assert.throws(() => define({ definitions: [definition, derive("__proto__", () => 1)] }), /Conflicting definition/);
  const records = collection<{ key: string }>("constructor").index("__proto__", ["key"]);
  assert.equal(records.by("__proto__").eq("value").collection, "constructor");
  const read = query("read", () => 1);
  const write = mutation("write", () => 2);
  const module = define({ definitions: [read, write], http: { ["__proto__"]: read, constructor: write } });
  assert.equal(module.definitions.read.kind, "queryMethod");
  assert.equal(module.definitions.write.kind, "mutationMethod");
  assert.equal(Object.getPrototypeOf(module.http), null);
  assert.deepEqual(module.http.__proto__, { name: "read", kind: "query" });
  assert.deepEqual(module.http.constructor, { name: "write", kind: "mutation" });
});

test("HTTP exposure is explicit, aliased, and separate from private definitions", () => {
  const read = query("internal.read", () => 1);
  const write = mutation("internal.write", () => 2);
  const privateWrite = mutation("internal.private", () => 3);
  const module = define({ definitions: [read, privateWrite], http: { get: read, again: read, save: write } });
  assert.deepEqual(Object.keys(module.definitions).sort(), ["internal.private", "internal.read", "internal.write"]);
  assert.deepEqual({ ...module.http }, {
    get: { name: "internal.read", kind: "query" },
    again: { name: "internal.read", kind: "query" },
    save: { name: "internal.write", kind: "mutation" },
  });
  assert.equal(Object.hasOwn(module.http, "internal.read"), false);
  assert.equal(Object.hasOwn(module.http, "internal.private"), false);
  assert.deepEqual(Object.keys(define({ definitions: [read, write] }).http), []);
  assert.deepEqual(Object.keys(define().http), []);
  assert.ok(Object.isFrozen(module));
  assert.ok(Object.isFrozen(module.definitions));
  assert.ok(Object.isFrozen(module.http));
  assert.ok(Object.isFrozen(module.http.get));
  assert.throws(() => define({ definitions: [read], http: { get: query("internal.read", () => 1) } }), /Conflicting definition/);
});

test("maintenance auto-registers privately and accepts only a mutation", () => {
  const maintain = mutation("internal.maintenance", () => null);
  const module = define({ maintenance: maintain });
  assert.deepEqual(module.maintenance, { name: "internal.maintenance", kind: "mutation" });
  assert.equal(module.definitions[maintain.name].kind, "mutationMethod");
  assert.deepEqual(Object.keys(module.http), []);
  assert.ok(Object.isFrozen(module.maintenance));
  assert.equal(define().maintenance, null);
  assert.throws(() => define({ maintenance: query("read", () => 1) as any }), /mutation method/);
  assert.throws(() => define({ maintenance: derive("derived", () => 1) as any }), /mutation method/);
  const explicit = define({ definitions: [maintain], maintenance: maintain, http: { maintain } });
  assert.equal(explicit.http.maintain.name, maintain.name);
});

test("query consistency is code-owned, defaults fresh, and propagates to every alias", () => {
  const fresh = query("fresh", () => 1);
  const explicitFresh = query("explicit", () => 2, { consistency: "linearizable" });
  const local = query("local", () => 3, { consistency: "replica-local" });
  const module = define({ http: { fresh, explicitFresh, local, another: local } });
  assert.equal(Object.hasOwn(fresh, "consistency"), false);
  assert.equal(Object.hasOwn(explicitFresh, "consistency"), false);
  assert.equal(local.consistency, "replica-local");
  assert.ok(Object.isFrozen(local));
  assert.deepEqual({ ...module.http }, {
    fresh: { name: "fresh", kind: "query" },
    explicitFresh: { name: "explicit", kind: "query" },
    local: { name: "local", kind: "query", consistency: "replica-local" },
    another: { name: "local", kind: "query", consistency: "replica-local" },
  });
  assert.equal((module.definitions.local as typeof local).consistency, "replica-local");
  assert.ok(Object.isFrozen(module.definitions.local));
  assert.equal(Object.hasOwn(module.definitions.explicit, "consistency"), false);
});

test("consistency rejects invalid, accessor, mutation, and derived metadata", () => {
  for (const options of [null, [], { consistency: "stale" }, { consistency: null },
    { consistency: undefined }, { consistency: 1 }, { extra: "replica-local" }]) {
    assert.throws(() => query("read", () => 1, options as any), TypeError);
  }
  let executed = false;
  assert.throws(() => query("read", () => 1, {
    get consistency() { executed = true; return "replica-local" as const; },
  }), /accessors/);
  assert.equal(executed, false);
  for (const consistency of ["replica-local", "linearizable", "invalid", null, undefined]) {
    for (const definition of [mutation("write", () => null), derive("derived", () => 1)]) {
      assert.throws(() => define({ definitions: [{ ...definition, consistency } as any] }), /Consistency/);
    }
  }
  const mutable = { kind: "queryMethod" as const, name: "local", compute: () => 1,
    consistency: "replica-local" as "replica-local" | "linearizable" };
  const module = define({ http: { read: mutable } });
  mutable.consistency = "linearizable";
  assert.equal((module.definitions.local as typeof mutable).consistency, "replica-local");
  assert.deepEqual(module.http.read, { name: "local", kind: "query", consistency: "replica-local" });
});

test("maintenance error handlers are private and require a complete mutation pair", () => {
  const run = mutation("maintenance.run", () => null);
  const onError = mutation("maintenance.error", (_ctx, _failure: { error: { code: string; message: string }; failedAt: number }) => null);
  const module = define({ maintenance: { run, onError } });
  assert.deepEqual(module.maintenance, {
    name: "maintenance.run", kind: "mutation", onError: { name: "maintenance.error", kind: "mutation" },
  });
  assert.deepEqual(Object.keys(module.definitions).sort(), ["maintenance.error", "maintenance.run"]);
  assert.deepEqual(Object.keys(module.http), []);
  assert.ok(Object.isFrozen(module.maintenance!.onError));
  for (const maintenance of [{ run }, { onError }, { run, onError, extra: true }, { run, onError: query("bad", () => null) }]) {
    assert.throws(() => define({ maintenance: maintenance as any }), TypeError);
  }
});

test("module configuration rejects invalid and accessor descriptors without executing them", () => {
  const read = query("read", () => 1);
  const derived = derive("derived", () => 2);
  for (const invalid of [
    null, [], read, { unknown: true }, { definitions: {} }, { definitions: [null] },
    { definitions: [{ kind: "queryMethod", name: "bad", compute: "not a function" }] },
    { definitions: [{ ...read, extra: true }] }, { http: { exposed: derived } },
    { http: { "": read } }, { http: Object.create({ inherited: read }) },
    { http: { exposed: Object.create(read) } }, { http: { [Symbol("hidden")]: read } },
  ]) assert.throws(() => define(invalid as any), TypeError);
  let executed = false;
  assert.throws(() => define({ http: { get exposed() { executed = true; return read; } } }), /accessors/);
  assert.equal(executed, false);
  assert.throws(() => define({ definitions: [{
    kind: "queryMethod", name: "getter", get compute() { executed = true; return () => 1; },
  }] }), /accessors/);
  assert.equal(executed, false);
  const mutable = { kind: "queryMethod" as const, name: "mutable", compute: () => 1 };
  const module = define({ http: { read: mutable } });
  mutable.name = "changed";
  mutable.compute = () => 2;
  assert.equal(module.definitions.mutable.name, "mutable");
  assert.equal(module.definitions.mutable.compute({} as any, null), 1);
});

test("canonical JSON preserves JSON values and sorts all object keys", () => {
  const first = JSON.parse('{"b":2,"a":{"10":10,"2":2,"__proto__":"safe"}}');
  const second = JSON.parse('{"a":{"__proto__":"safe","2":2,"10":10},"b":2}');
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(canonicalJson(first), '{"a":{"10":10,"2":2,"__proto__":"safe"},"b":2}');
  assert.equal(canonicalJson([-0, null, false]), "[0,null,false]");
  const cycle: unknown[] = []; cycle.push(cycle);
  for (const invalid of [cycle, undefined, Infinity, new Date(), [undefined], { x: undefined }, [,,]]) {
    assert.throws(() => canonicalJson(invalid), TypeError);
  }
  const shared = { x: 1 };
  assert.equal(canonicalJson([shared, shared]), '[{"x":1},{"x":1}]');
});

test("canonical JSON rejects accessors, hidden fields, named array fields, and excessive nesting", () => {
  let called = false;
  const accessor = { get value() { called = true; return 1; } };
  const hidden = Object.defineProperty({}, "secret", { value: 1 });
  const namedArray = Object.assign([1], { extra: 2 });
  for (const value of [accessor, hidden, namedArray, Promise.resolve(null)]) {
    assert.throws(() => canonicalJson(value), TypeError);
  }
  assert.equal(called, false);
  let nested: unknown = null;
  for (let depth = 0; depth < 129; depth++) nested = [nested];
  assert.throws(() => canonicalJson(nested), /nesting exceeds/);
});

test("orders module builds to a self-contained bundle with a content hash", async () => {
  const bundle = await buildBundle(new URL("../examples/orders.ts", import.meta.url).pathname);
  assert.equal(bundle.hash, createHash("sha256").update(bundle.javascript).digest("hex"));
  const sandbox: Record<string, any> = {};
  runInNewContext(bundle.javascript, sandbox, { timeout: 1_000 });
  const module = sandbox.__flowerBundle.default;
  const definitions = module.definitions;
  assert.deepEqual(Object.keys(definitions).sort(), ["internal.order.create", "internal.order.read", "internal.order.reset", "internal.order.updateLine", "internal.order.updateShipping", "order.subtotal", "order.total"]);
  assert.deepEqual(JSON.parse(JSON.stringify(module.http)), {
    "order.create": { name: "internal.order.create", kind: "mutation" },
    "order.updateLine": { name: "internal.order.updateLine", kind: "mutation" },
    "order.updateShipping": { name: "internal.order.updateShipping", kind: "mutation" },
    "order.get": { name: "internal.order.read", kind: "query" },
  });
  const subtotal = definitions["order.subtotal"].compute({
    query(query: any) {
      assert.equal(query.collection, "orderLines");
      assert.equal(query.value, "order-42");
      return [{ quantity: 2, unitCents: 1250 }, { quantity: 1, unitCents: 700 }];
    },
  }, "order-42");
  assert.equal(subtotal, 3200);
  const total = definitions["order.total"].compute({
    get(ref: any, key: string) {
      assert.equal(key, "order-42");
      return ref.kind === "collection" ? { shippingCents: 500 } : subtotal;
    },
  }, "order-42");
  assert.equal(total, 3700);
});

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  operation: (client: FlowerClient) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await operation(new FlowerClient(`http://127.0.0.1:${address.port}`));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("client invokes named mutations and preserves explicit IDs for retry", async () => {
  const received: any[] = [];
  await withServer((request, response) => {
    assert.equal(request.url, "/v1/mutate");
    assert.equal(request.method, "POST");
    let body = "";
    request.on("data", (data) => { body += data; });
    request.on("end", () => {
      received.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ revision: received.length, duplicate: false, value: { saved: true } }));
    });
  }, async (client) => {
    assert.equal((await client.mutate("save", { text: "hello" })).revision, 1);
    await client.mutate("save", { text: "hello" }, { requestId: "stable-retry", expectedRevision: 1 });
  });
  assert.match(received[0].requestId, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
  assert.equal(received[1].requestId, "stable-retry");
  assert.equal(received[1].name, "save");
  assert.equal(received[1].expectedRevision, 1);
  assert.deepEqual(received[1].args, { text: "hello" });
});

test("generic HTTP calls leave dispatch to the server and preserve retry options", async () => {
  const received: any[] = [];
  await withServer((request, response) => {
    assert.equal(request.url, "/v1/call");
    let body = "";
    request.on("data", (data) => { body += data; });
    request.on("end", () => {
      received.push(JSON.parse(body));
      response.end(JSON.stringify({ revision: 7, value: { answer: 42 }, duplicate: false }));
    });
  }, async (client) => {
    assert.deepEqual(await client.call("public.answer", { id: 1 }), {
      revision: 7, value: { answer: 42 }, duplicate: false,
    });
    await client.call("public.update", { amount: 2 }, { requestId: "stable-call", expectedRevision: 7 });
  });
  assert.match(received[0].requestId, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
  assert.deepEqual(received[1], { name: "public.update", args: { amount: 2 }, requestId: "stable-call", expectedRevision: 7 });
  assert.equal(Object.hasOwn(received[0], "kind"), false);
});

test("client invokes named queries and exposes method errors", async () => {
  const received: any[] = [];
  await withServer((request, response) => {
    assert.equal(request.url, "/v1/query");
    assert.equal(request.method, "POST");
    let body = "";
    request.on("data", (data) => { body += data; });
    request.on("end", () => {
      const call = JSON.parse(body);
      received.push(call);
      if (call.name === "broken") {
        response.writeHead(422);
        response.end(JSON.stringify({ error: { code: "QUERY_FAILED", message: "broken" } }));
      } else response.end(JSON.stringify({ revision: 4, value: 42 }));
    });
  }, async (client) => {
    assert.deepEqual(await client.query("answer", { b: 2, a: 1 }), { revision: 4, value: 42 });
    await assert.rejects(client.query("broken"), (error) => error instanceof FlowerError && error.code === "QUERY_FAILED");
    for (const removed of ["get", "read", "snapshot", "changes", "transaction"]) {
      assert.equal(removed in client, false, `raw client method ${removed} must not exist`);
    }
  });
  assert.deepEqual(received, [{ name: "answer", args: { b: 2, a: 1 } }, { name: "broken", args: null }]);
});

test("watchPoll polls the named query and skips repeated revisions", async () => {
  let calls = 0;
  await withServer((request, response) => {
    assert.equal(request.url, "/v1/query");
    calls++;
    response.end(JSON.stringify({ revision: calls < 3 ? 2 : 4, value: calls < 3 ? "first" : "changed" }));
  }, async (client) => {
    const iterator = client.watchPoll("answer", null, { intervalMs: 1 });
    assert.deepEqual((await iterator.next()).value, { revision: 2, value: "first" });
    assert.deepEqual((await iterator.next()).value, { revision: 4, value: "changed" });
    await iterator.return(undefined);
  });
  assert.equal(calls, 3);
});

test("watchPoll emits clock-driven value changes at an unchanged revision", async () => {
  let calls = 0;
  await withServer((request, response) => {
    assert.equal(request.url, "/v1/query");
    calls++;
    response.end(JSON.stringify({ revision: 7, value: calls < 3 ? { cached: "value" } : null }));
  }, async (client) => {
    const iterator = client.watchPoll("cache.get", "key", { intervalMs: 1 });
    assert.deepEqual((await iterator.next()).value, { revision: 7, value: { cached: "value" } });
    assert.deepEqual((await iterator.next()).value, { revision: 7, value: null });
    await iterator.return(undefined);
  });
  assert.equal(calls, 3);
});

test("admin credentials attach only to deployment and initialization", async () => {
  const requests: { path: string; authorization?: string }[] = [];
  await withServer((request, response) => {
    requests.push({ path: request.url!, authorization: request.headers.authorization });
    response.end(JSON.stringify({ revision: 1, duplicate: false, value: null }));
  }, async (anonymous) => {
    const client = new FlowerClient(anonymous.url, { adminToken: "test-token" });
    await client.initialize({ "1": "127.0.0.1:7101" });
    await client.deploy({ hash: "hash", javascript: "code" });
    await client.query("read");
    await client.mutate("write");
    await client.call("public.alias");
  });
  assert.deepEqual(requests, [
    { path: "/raft/initialize", authorization: "Bearer test-token" },
    { path: "/admin/deploy", authorization: "Bearer test-token" },
    { path: "/v1/query", authorization: undefined },
    { path: "/v1/mutate", authorization: undefined },
    { path: "/v1/call", authorization: undefined },
  ]);
});

test("deployment preparation is explicit and preserves the caller retry ID", async () => {
  const calls: Record<string,unknown>[] = [];
  const client = new FlowerClient("http://localhost:7101", { fetch: async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({revision:2,value:null,duplicate:false}));
  }});
  const bundle = {hash:"hash",javascript:"code"};
  await client.deploy(bundle,{requestId:"once",preparation:"online"});
  await client.deploy(bundle,{requestId:"once",preparation:"blocking"});
  assert.deepEqual(calls,[{requestId:"once",bundle,preparation:"online"},{requestId:"once",bundle,preparation:"blocking"}]);
  await assert.rejects(client.deploy(bundle,{preparation:"invalid" as "online"}),/preparation/);
  assert.equal(calls.length,2);
});
