import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson } from "@flower-js/sdk";
import { checksum, type Event } from "../app/model.ts";
import { bob, call, failure, laptop, lease, mallory, setup, text, worker } from "./support/harness.ts";

const asWorker = { credentials: worker };

test("sessions are visible to their organization, private ones to their creator, and worker methods to workers", async () => {
  const t = await setup();
  const forbidden = failure("FORBIDDEN");
  assert.equal(t.db.query("session.get", { session: "s" }, { credentials: bob })!.id, "s");
  assert.throws(() => t.db.query("session.get", { session: "s" }, { credentials: mallory }), forbidden);
  assert.throws(() => t.db.mutate("session.send", { session: "s", message: "x", text: "hi" }, { credentials: mallory }), forbidden);
  t.db.mutate("session.configure", { session: "s", private: true });
  assert.throws(() => t.db.query("session.get", { session: "s" }, { credentials: bob }), forbidden);
  assert.deepEqual(t.db.query("session.list", {}, { credentials: bob }), []);
  assert.throws(() => t.db.mutate("completions.claim", { owner: "me" }), forbidden, "users cannot act as workers");
  assert.throws(() => t.db.mutate("org.update", { settings: { budgetNanos: 1 } }, { credentials: bob }), forbidden, "members cannot change settings");
});

test("a computer claims only its own tool scope", async () => {
  const t = await setup();
  t.say("list");
  t.reply(t.claim(), [call("c1", "list_files", {})], "tool_use");
  assert.throws(() => t.db.mutate("tools.claim", { scope: "computer:other", owner: "laptop" }, { credentials: laptop }), failure("FORBIDDEN"));
  const job = t.db.mutate("tools.claim", { scope: "computer:laptop", owner: "laptop" }, { credentials: laptop })!;
  t.db.mutate("tools.complete", { scope: "computer:laptop", ...lease(job), result: { content: "a.txt", isError: false } }, { credentials: laptop });
  t.db.mutate("computer.heartbeat", { id: "laptop" }, { credentials: laptop });
  assert.equal(t.db.query("computer.list")[0]!.online, true);
  t.db.advance(61_000);
  assert.equal(t.db.query("computer.list")[0]!.online, false);
});

test("an oversized context is compacted before the next response, and the log before the summary is sealed", async () => {
  const t = await setup({ session: { contextTokens: 10_000 } });
  t.say("start");
  t.reply(t.claim(), [call("c1", "list_files", {})], "tool_use", { input: 12_000, output: 100, cacheRead: 0, cacheWrite: 0 });
  t.finishTool(t.tool(), "a/ b/");
  const compaction = t.claim();
  assert.equal(compaction.payload.kind, "compact");
  t.reply(compaction, [text("The user asked to start; the workspace has a/ and b/.")]);
  const next = t.claim();
  assert.equal(next.payload.kind, "respond");
  assert.deepEqual(t.promptLog(next), ["compact The user asked to start; the workspace has a/ and b/."]);

  const seal = t.db.mutate("sealing.claim", { owner: "sealer" }, asWorker)!;
  assert.deepEqual({ from: seal.payload.from, to: seal.payload.to }, { from: 1, to: t.session().compactSeq - 1 });
  const events = t.db.query("session.events", { session: "s", from: seal.payload.from, to: seal.payload.to }, asWorker) as Event[];
  assert.throws(() => t.db.mutate("sealing.complete", { ...lease(seal), result: { key: `sha256/${"0".repeat(64)}`, count: events.length, checksum: "bad" } }, asWorker), failure("SEAL_MISMATCH"));
  const again = t.db.mutate("sealing.claim", { owner: "sealer" }, asWorker);
  assert.equal(again, null, "a failed report keeps the lease");
  t.db.mutate("sealing.complete", { ...lease(seal), result: { key: `sha256/${"a".repeat(64)}`, count: events.length, checksum: checksum(canonicalJson(events)) } }, asWorker);
  const view = t.db.query("session.tail", { session: "s" })!;
  assert.equal(view.events[0]!.seq, seal.payload.to + 1);
  assert.deepEqual(view.segments.map((segment) => [segment.from, segment.to]), [[1, seal.payload.to]]);
  assert.equal(t.db.query("session.blob", { session: "s", key: `sha256/${"a".repeat(64)}` }), true);
  assert.deepEqual(t.promptLog(next), ["compact The user asked to start; the workspace has a/ and b/."], "the request never needs sealed events");
});

test("a subagent runs as a child session and its answer resolves the parent's call", async () => {
  const t = await setup();
  t.say("research");
  t.reply(t.claim(), [call("c1", "subagent", { description: "dig", prompt: "Find the answer" })], "tool_use");
  const child = "s.c1";
  const childTurn = t.claim();
  assert.equal(childTurn.payload.session, child);
  assert.deepEqual(t.promptLog(childTurn), ["user Find the answer"]);
  assert.ok(!t.prompt(childTurn)!.tools.some((tool) => tool.name === "subagent" || tool.name === "ask_user"), "subagents cannot delegate or ask");
  t.reply(childTurn, [text("42")]);
  const parentTurn = t.claim();
  assert.equal(parentTurn.payload.session, "s");
  assert.equal(t.promptLog(parentTurn).at(-1), "result c1: 42");
  assert.throws(() => t.db.mutate("session.send", { session: child, message: "x", text: "hi" }), failure("SUBAGENT"));
});

test("halting a parent halts its subagents", async () => {
  const t = await setup();
  t.say("research");
  t.reply(t.claim(), [call("c1", "subagent", { description: "dig", prompt: "Find it" })], "tool_use");
  t.claim();
  t.db.mutate("session.halt", { session: "s" });
  assert.equal(t.session("s.c1").status, "halted");
  assert.equal(t.session().status, "halted");
  assert.ok(t.log().includes("result c1 error: Tool execution cancelled by user halt."));
});

test("a halt waits for running tools within the grace window, then cancels the rest", async () => {
  const t = await setup({ session: { graceMs: 5_000 } });
  t.say("go");
  t.reply(t.claim(), [call("c1", "list_files", {}), call("c2", "read_file", { path: "a" })], "tool_use");
  const first = t.tool();
  t.tool();
  t.db.mutate("session.halt", { session: "s" });
  assert.equal(t.session().status, "working");
  t.finishTool(first, "a");
  assert.equal(t.session().status, "working", "c2 still has time");
  t.db.advance(5_000);
  assert.equal(t.session().status, "halted");
  assert.deepEqual(t.log().slice(-5), ["result c1: a", "resolved c2 cancelled", "result c2 error: Tool execution cancelled by user halt.", "status halted", "interrupted"]);
});

test("a tool that outlives its timeout is cancelled and answered", async () => {
  const t = await setup();
  t.say("read");
  t.reply(t.claim(), [call("c1", "read_file", { path: "a" })], "tool_use");
  const job = t.tool();
  t.db.advance(600_000);
  assert.throws(() => t.finishTool(job, "late"), failure("LEASE_LOST"));
  assert.ok(t.log().includes("result c1 error: The tool did not finish in time and was cancelled."));
  t.claim();
});

test("a background command returns at once and its result later joins the session", async () => {
  const t = await setup({ session: { allow: ["bash"] } });
  t.say("build");
  t.reply(t.claim(), [call("c1", "bash", { command: "make", background: true })], "tool_use");
  const next = t.claim();
  assert.match(t.promptLog(next).at(-1)!, /^result c1: Started in the background/);
  t.reply(next, [text("Building.")]);
  assert.equal(t.session().status, "idle");
  t.finishTool(t.tool(), "exit 0\nok");
  const woken = t.claim();
  assert.equal(t.promptLog(woken).at(-1), "background c1: exit 0\nok");
});

test("usage is priced per served model and a spent budget stops new completions", async () => {
  const t = await setup({ settings: { budgetNanos: 60_000 } });
  t.say("x");
  t.reply(t.claim(), [text("ok")], "end_turn", { input: 10_000, output: 1_000, cacheRead: 0, cacheWrite: 0 }, "claude-sonnet-5");
  const spent = t.db.query("org.usage", {});
  assert.equal(spent.costNanos, 10_000 * 2_000 + 1_000 * 10_000);
  t.say("y");
  assert.equal(t.session().status, "error");
  assert.ok(t.log().includes("error BUDGET_EXCEEDED"));
  assert.ok(t.idle());
});

test("organizations with a Stripe customer queue a meter event per completion", async () => {
  const t = await setup({ settings: { stripeCustomer: "cus_123" } });
  t.say("x");
  t.reply(t.claim(), [text("ok")]);
  const job = t.db.mutate("billing.claim", { owner: "biller" }, asWorker)!;
  assert.equal(job.payload.customer, "cus_123");
  assert.equal(job.payload.identifier, "s:1");
});

test("automations start sessions on schedule and reschedule themselves", async () => {
  const t = await setup({ settings: { computer: "laptop" } });
  const automation = t.db.mutate("automation.set", { id: "daily", name: "Daily report", schedule: "0 * * * *", prompt: "Write the report" });
  assert.ok(automation.nextAt! > t.db.now);
  t.db.advance(automation.nextAt! - t.db.now);
  const claim = t.claim();
  assert.equal(claim.payload.session, `daily-${automation.nextAt}`);
  assert.deepEqual(t.promptLog(claim), ["user Write the report"]);
  assert.equal(t.db.query("automation.list")[0]!.nextAt, automation.nextAt! + 3_600_000);
  assert.throws(() => t.db.mutate("automation.set", { id: "bad", name: "x", schedule: "61 * * * *", prompt: "x" }), failure("INVALID_CRON"));
  const manual = t.db.mutate("automation.run", { id: "daily" });
  assert.equal(t.db.query("automation.list")[0]!.lastSession, manual.session);
});

test("memory written by the agent appears in the system prompt of later turns", async () => {
  const t = await setup();
  t.say("remember my editor");
  t.reply(t.claim(), [call("c1", "memory_write", { path: "index.md", content: "Alice uses vim." })], "tool_use");
  const same = t.claim();
  assert.ok(!t.prompt(same)!.system.includes("Alice uses vim."), "a turn's system prompt stays fixed");
  t.reply(same, [text("Noted.")]);
  t.say("hello again");
  assert.ok(t.prompt(t.claim())!.system.includes("Alice uses vim."));
  assert.equal(t.db.query("memory.read", { path: "index.md" })!.content, "Alice uses vim.");
});

test("MCP tools come from the published catalog and run on the service scope after approval", async () => {
  const t = await setup();
  t.db.mutate("mcp.set", { name: "linear", url: "https://mcp.linear.app/mcp", headers: { authorization: "Bearer ${secret:LINEAR}" } });
  const work = t.db.query("mcp.catalog.pending", ["acme", "linear"], asWorker)!;
  t.db.mutate("mcp.catalog.publish", { args: ["acme", "linear"], key: work.key, value: [{ name: "create_issue", description: "Create an issue", inputSchema: { type: "object", properties: { title: { type: "string" } } } }] }, asWorker);
  t.say("file a bug");
  const claim = t.claim();
  assert.ok(t.prompt(claim)!.tools.some((tool) => tool.name === "mcp__linear__create_issue"));
  t.reply(claim, [call("c1", "mcp__linear__create_issue", { title: "Bug" })], "tool_use");
  assert.equal(t.session().status, "waiting_on_user");
  t.db.mutate("session.resolve", { session: "s", call: "c1", approve: true });
  const job = t.tool("service");
  assert.deepEqual(job.payload.mcp, { server: "linear", tool: "create_issue", url: "https://mcp.linear.app/mcp", headers: { authorization: "Bearer ${secret:LINEAR}" } });
});

test("web tools are offered as provider tools and their blocks are kept for replay", async () => {
  const t = await setup();
  t.say("search");
  const claim = t.claim();
  assert.ok(t.prompt(claim)!.tools.some((tool) => "type" in tool && tool.type === "web_search_20260209"));
  t.reply(claim, [
    { type: "provider", provider: "anthropic", block: { type: "server_tool_use", id: "srv1", name: "web_search", input: { query: "x" } } },
    { type: "provider", provider: "anthropic", block: { type: "web_search_tool_result", tool_use_id: "srv1", content: [] } },
    text("Nothing found."),
  ]);
  assert.equal(t.session().status, "idle");
  t.db.mutate("session.configure", { session: "s", webTools: false });
  t.say("again");
  assert.ok(!t.prompt(t.claim())!.tools.some((tool) => "type" in tool));
});

test("sandboxes start on demand, serve tools while running, and stop when idle", async () => {
  const t = await setup();
  t.db.mutate("computer.createSandbox", { id: "box", name: "Box", image: "debian:bookworm-slim" });
  t.db.mutate("session.configure", { session: "s", computer: "box" });
  t.say("list");
  t.reply(t.claim(), [call("c1", "list_files", {})], "tool_use");
  const start = t.db.mutate("provision.claim", { owner: "docker" }, asWorker)!;
  assert.deepEqual(start.payload, { computer: "box", action: "start", kind: "docker", image: "debian:bookworm-slim" });
  t.db.mutate("provision.complete", { ...lease(start), result: { container: "trinity-box" } }, asWorker);
  assert.deepEqual(t.db.query("computer.running", null, asWorker), [{ id: "box", image: "debian:bookworm-slim", scope: "computer:box" }]);
  t.finishTool(t.tool("computer:box"), "(empty directory)", false, "computer:box");
  t.db.advance(30 * 60_000);
  const stop = t.db.mutate("provision.claim", { owner: "docker" }, asWorker)!;
  assert.equal(stop.payload.action, "stop");
});

test("titles are generated from the first message unless the agent or user sets one", async () => {
  const t = await setup();
  t.say("Please fix the flaky login test");
  const work = t.db.query("titles.pending", "s", asWorker)!;
  assert.equal((work.input as { text: string }).text, "Please fix the flaky login test");
  t.db.mutate("titles.publish", { args: "s", key: work.key, value: "Fix flaky login test" }, asWorker);
  assert.equal(t.session().title, "Fix flaky login test");
  t.db.mutate("session.configure", { session: "s", title: "Login test" });
  assert.equal(t.session().title, "Login test");
});
