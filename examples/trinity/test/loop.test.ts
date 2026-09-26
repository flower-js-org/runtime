import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowerError } from "@flower-js/sdk";
import { call, leaseLost, setup, summarize, text, usage } from "./support/harness.ts";

test("a message runs one completion and settles idle", async () => {
  const t = await setup();
  t.say("hello");
  const claim = t.claim();
  assert.deepEqual(t.promptLog(claim), ["user hello"]);
  t.reply(claim, [text("hi")]);
  assert.deepEqual(t.log(), ["status working", "user hello", "assistant hi", "status idle"]);
  assert.ok(t.idle());
  assert.deepEqual(t.session().usage, usage);
});

test("a computer tool runs on the session's scope and its result feeds the next completion", async () => {
  const t = await setup();
  t.say("read a.txt");
  t.reply(t.claim(), [call("c1", "read_file", { path: "a.txt" })], "tool_use");
  assert.ok(t.idle(), "no completion is owed while the call runs");
  const job = t.tool();
  assert.deepEqual(job.payload, { session: "s", call: "c1", name: "read_file", input: { path: "a.txt" }, background: false, mcp: null });
  t.finishTool(job, "contents");
  const next = t.claim();
  assert.deepEqual(t.promptLog(next), ["user read a.txt", "assistant read_file#c1", "result c1: contents"]);
  t.reply(next, [text("done")]);
  assert.deepEqual(t.log(), ["status working", "user read a.txt", "assistant read_file#c1", "result c1: contents", "assistant done", "status idle"]);
});

test("parallel calls: inline tools resolve at once and the next completion waits for every call", async () => {
  const t = await setup();
  t.say("go");
  t.reply(t.claim(), [call("c1", "read_file", { path: "a" }), call("c2", "set_title", { title: "Reading a" }), call("c3", "list_files", {})], "tool_use");
  assert.equal(t.session().title, "Reading a");
  const first = t.tool();
  const second = t.tool();
  t.finishTool(second, "a/ b");
  assert.ok(t.idle());
  t.finishTool(first, "A");
  t.reply(t.claim(), [text("ok")]);
  assert.deepEqual(t.log(), [
    "status working", "user go", "assistant read_file#c1 set_title#c2 list_files#c3",
    "title Reading a", "result c2: Title set.", "result c3: a/ b", "result c1: A", "assistant ok", "status idle",
  ]);
});

test("permission prompts park the turn until approved or denied", async () => {
  const t = await setup();
  t.say("clean up");
  t.reply(t.claim(), [call("c1", "bash", { command: "rm -rf build" }), call("c2", "write_file", { path: "x", content: "y" })], "tool_use");
  assert.equal(t.session().status, "waiting_on_user");
  assert.ok(t.noTool(), "nothing runs before approval");
  t.db.mutate("session.resolve", { session: "s", call: "c2", approve: false });
  t.db.mutate("session.resolve", { session: "s", call: "c1", approve: true });
  assert.equal(t.session().status, "working");
  t.finishTool(t.tool(), "exit 0");
  t.reply(t.claim(), [text("cleaned")]);
  assert.deepEqual(t.log(), [
    "status working", "user clean up", "assistant bash#c1 write_file#c2",
    "awaiting c1 permission", "awaiting c2 permission", "status waiting_on_user",
    "resolved c2 denied", "result c2 error: The user denied this tool call.",
    "resolved c1 approved", "status working", "result c1: exit 0", "assistant cleaned", "status idle",
  ]);
  assert.throws(() => t.db.mutate("session.resolve", { session: "s", call: "c1", approve: true }),
    (error) => error instanceof FlowerError && error.failure?.code === "NOT_AWAITING");
});

test("a question is answered by the user and the answer is the result", async () => {
  const t = await setup();
  t.say("deploy");
  t.reply(t.claim(), [call("q", "ask_user", { question: "Which region?" })], "tool_use");
  assert.throws(() => t.db.mutate("session.resolve", { session: "s", call: "q", approve: true }),
    (error) => error instanceof FlowerError && error.failure?.code === "ANSWER_REQUIRED");
  t.db.mutate("session.resolve", { session: "s", call: "q", answer: "eu-west-1" });
  const next = t.claim();
  assert.equal(summarize(t.prompt(next)!.events.at(-1)!.body), "result q: eu-west-1");
});

test("unknown tools and invalid inputs get error results without running", async () => {
  const t = await setup();
  t.say("x");
  t.reply(t.claim(), [call("c1", "teleport", {}), call("c2", "read_file", { path: 7 }), call("c3", "read_file", { path: "a", extra: true })], "tool_use");
  t.claim();
  const results = t.log().filter((line) => line.startsWith("result"));
  assert.equal(results.length, 3);
  assert.match(results[0]!, /^result c1 error: Unknown tool "teleport"/);
  assert.match(results[1]!, /^result c2 error: Invalid input: path/);
  assert.match(results[2]!, /^result c3 error: Invalid input/);
  assert.ok(t.noTool());
});

test("a call truncated by the output limit is answered, not run", async () => {
  const t = await setup();
  t.say("write");
  t.reply(t.claim(), [call("c1", "list_files", { path: "partial" })], "max_tokens");
  assert.ok(t.noTool());
  assert.match(t.log().find((line) => line.startsWith("result"))!, /output limit/);
  t.claim();
});

test("halting a completion keeps the streamed text and fences the worker", async () => {
  const t = await setup();
  t.say("write a poem");
  const claim = t.claim();
  assert.deepEqual(t.progress(claim, [{ index: 0, type: "thinking", text: "hmm" }, { index: 1, type: "text", text: "Roses " }]), { stop: false });
  t.progress(claim, [{ index: 1, type: "text", text: "are red" }]);
  assert.equal(t.db.query("session.tail", { session: "s" })!.partial!.deltas.length, 3);
  assert.equal(t.db.mutate("session.halt", { session: "s" }).halted, true);
  assert.deepEqual(t.log(), ["status working", "user write a poem", "assistant Roses are red (interrupted)", "status halted", "interrupted"]);
  assert.equal(t.db.query("session.tail", { session: "s" })!.partial, null);
  assert.equal(t.prompt(claim), null);
  assert.throws(() => t.progress(claim, [{ index: 1, type: "text", text: "!" }]), leaseLost);
  assert.throws(() => t.reply(claim, [text("Roses are red, violets are blue")]), leaseLost);
  assert.equal(t.db.mutate("session.halt", { session: "s" }).halted, false);

  t.say("again, shorter");
  const next = t.claim();
  assert.deepEqual(t.promptLog(next), [
    "user write a poem", "assistant Roses are red (interrupted)", "interrupted", "user again, shorter",
  ]);
});

test("halting while a tool runs cancels it and rejects its late report", async () => {
  const t = await setup();
  t.say("list");
  t.reply(t.claim(), [call("c1", "list_files", {})], "tool_use");
  const job = t.tool();
  t.db.mutate("session.halt", { session: "s" });
  assert.throws(() => t.finishTool(job, "late"), leaseLost);
  assert.deepEqual(t.log().slice(-5), ["assistant list_files#c1", "resolved c1 cancelled", "result c1 error: Tool execution cancelled by user halt.", "status halted", "interrupted"]);
  assert.ok(t.idle());
});

test("a steer waits for the completion boundary, then joins the turn", async () => {
  const t = await setup();
  t.say("first");
  const claim = t.claim();
  t.say("also this", true);
  assert.equal(t.session().queued.length, 1);
  t.reply(claim, [text("ok")]);
  const next = t.claim();
  assert.deepEqual(t.promptLog(next), ["user first", "assistant ok", "user also this"]);
  assert.equal(t.session().queued.length, 0);
});

test("a steer preempts an open prompt", async () => {
  const t = await setup();
  t.say("go");
  t.reply(t.claim(), [call("c1", "bash", { command: "make" })], "tool_use");
  t.say("stop, use npm instead", true);
  const next = t.claim();
  assert.deepEqual(t.prompt(next)!.events.slice(-2).map((event) => summarize(event.body)), [
    "result c1 error: The user sent a new message instead of responding to this.", "user stop, use npm instead",
  ]);
});

test("a follow-up waits for the turn to end and opens the next turn", async () => {
  const t = await setup();
  t.say("first");
  t.reply(t.claim(), [call("c1", "list_files", {})], "tool_use");
  t.say("then this");
  t.finishTool(t.tool(), "a");
  const next = t.claim();
  assert.equal(summarize(t.prompt(next)!.events.at(-1)!.body), "result c1: a", "follow-ups are not part of the running turn");
  t.reply(next, [text("listed")]);
  const after = t.claim();
  assert.equal(summarize(t.prompt(after)!.events.at(-1)!.body), "user then this");
  assert.equal(t.session().turn!.message, "m2");
});

test("retryable failures back off; others end the turn and later messages still run", async () => {
  const t = await setup();
  t.say("x");
  const first = t.claim();
  t.fail(first, { code: "OVERLOADED", message: "busy", retryable: true, retryAfterMs: 2_000 });
  assert.ok(t.idle(), "the retry waits for its delay");
  t.db.advance(2_000);
  const second = t.claim();
  assert.equal(second.attempt, 2);
  t.fail(second, { code: "INVALID_REQUEST", message: "bad", retryable: false });
  assert.equal(t.session().status, "error");
  assert.deepEqual(t.log(), ["status working", "user x", "error OVERLOADED retry in 2000", "error INVALID_REQUEST", "status error"]);
  t.say("y");
  assert.equal(t.session().status, "working");
  t.claim();
});

test("an expired lease restarts the stream for the next attempt and fences the old worker", async () => {
  const t = await setup();
  t.say("x");
  const first = t.claim();
  t.progress(first, [{ index: 0, type: "text", text: "stale" }]);
  t.db.advance(30_000);
  const second = t.claim();
  assert.equal(second.attempt, 2);
  t.progress(second, [{ index: 0, type: "text", text: "fresh" }]);
  assert.deepEqual(t.db.query("session.tail", { session: "s" })!.partial!.deltas.map((delta) => delta.text), ["fresh"]);
  assert.throws(() => t.progress(first, [{ index: 0, type: "text", text: "late" }]), leaseLost);
});

test("a completion that keeps losing its worker ends the turn", async () => {
  const t = await setup();
  t.say("x");
  for (let attempt = 1; attempt <= 5; attempt++) {
    assert.equal(t.claim().attempt, attempt);
    t.db.advance(30_000);
  }
  assert.ok(t.idle());
  assert.equal(t.session().status, "error");
  assert.ok(t.log().includes("error COMPLETION_ATTEMPTS"));
});

test("a lost worker's side-effecting call reports an unknown outcome instead of running twice", async () => {
  const t = await setup();
  t.say("go");
  t.reply(t.claim(), [call("c1", "bash", { command: "git push" }), call("c2", "read_file", { path: "a" })], "tool_use");
  t.db.mutate("session.resolve", { session: "s", call: "c1", approve: true });
  t.tool();
  t.tool();
  t.db.advance(30_000);
  const retried = t.tool();
  assert.equal(retried.payload.call, "c2", "idempotent calls run again");
  assert.equal(retried.attempt, 2);
  t.finishTool(retried, "A");
  assert.match(t.log().find((line) => line.startsWith("result c1"))!, /outcome is unknown/);
  t.claim();
});

test("a refusal discards the partial response and its calls", async () => {
  const t = await setup();
  t.say("x");
  t.reply(t.claim(), [text("Sure, here"), call("c1", "bash", { command: "curl evil" })], "refusal");
  assert.deepEqual(t.log(), ["status working", "user x", "assistant", "error REFUSED", "status error"]);
  assert.ok(t.noTool());
  assert.deepEqual(t.session().usage, usage, "the refused attempt is still billed");
});
