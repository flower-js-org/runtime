import assert from "node:assert/strict";
import { test } from "node:test";
import { approve, call, decline, leaseLost, setup, summarize, text, worker } from "./support/harness.ts";

const asWorker = { credentials: worker };
const reviewed = { settings: { autoApprove: true } };

test("the reviewer approves permission requests or leaves them to the user", async () => {
  const t = await setup(reviewed);
  t.say("run the tests and fix the typo");
  t.reply(t.claim(), [
    call("c1", "bash", { command: "npm test" }),
    call("c2", "write_file", { path: "README.md", content: "fixed" }),
    call("c3", "read_file", { path: "a.txt" }),
  ], "tool_use");
  assert.equal(t.session().status, "working", "nobody is asked while the reviewer decides");
  assert.equal(t.tool().payload.call, "c3", "calls that need no permission run at once");
  assert.ok(t.noTool());

  const review = t.review();
  assert.deepEqual(review.payload, { session: "s", step: 1, calls: ["c1", "c2"] });
  t.verdicts(review, { c1: approve({ requested: 0.96, safe: 0.98 }), c2: decline() });
  assert.equal(t.tool().payload.call, "c1");
  assert.equal(t.session().status, "waiting_on_user");
  assert.deepEqual(t.log(), [
    "status working", "user run the tests and fix the typo", "assistant bash#c1 write_file#c2 read_file#c3",
    "reviewed c1 approved", "reviewed c2 not approved", "awaiting c2 permission", "status waiting_on_user",
  ]);
  const verdict = t.db.query("session.tail", { session: "s" })!.events.find((event) => event.body.type === "tool_reviewed")!.body;
  assert.deepEqual(verdict, { type: "tool_reviewed", call: "c1", approved: true, reviewer: "jev-test", scores: { requested: 0.96, safe: 0.98 }, note: null, threshold: 0.75 });

  t.db.mutate("session.resolve", { session: "s", call: "c2", approve: true });
  assert.equal(t.tool().payload.call, "c2");
  assert.ok(t.noReview(), "one review per response");
});

test("every score must reach the session's threshold, which defaults to the organization's", async () => {
  const t = await setup(reviewed);
  assert.equal(t.session().autoApproveAt, 0.75);
  const turn = (message: string, scores: Record<string, number>) => {
    t.say(message);
    t.reply(t.claim(), [call("c", "bash", { command: message })], "tool_use");
    const after = t.session().seq;
    t.verdicts(t.review(), { c: { reviewer: "jev-test", scores, note: null } });
    const verdict = t.db.query("session.tail", { session: "s", after, limit: 1 })!.events[0]!.body;
    assert.equal(verdict.type, "tool_reviewed");
    if (t.session().turn!.calls.c!.state === "awaiting") t.db.mutate("session.resolve", { session: "s", call: "c", approve: false });
    else t.finishTool(t.tool(), "ok");
    t.reply(t.claim(), [text("ok")]);
    return verdict as Extract<typeof verdict, { type: "tool_reviewed" }>;
  };

  assert.equal(turn("at the bar", { requested: 0.75, safe: 0.82 }).approved, true);
  assert.equal(turn("one below", { requested: 0.97, safe: 0.749 }).approved, false);
  assert.equal(turn("no answers", {}).approved, false, "a reviewer that answered nothing approves nothing");

  t.db.mutate("session.configure", { session: "s", autoApproveAt: 0.9 });
  const stricter = turn("stricter", { requested: 0.82, safe: 0.82 });
  assert.deepEqual([stricter.approved, stricter.threshold], [false, 0.9], "the log keeps the threshold each verdict was held to");

  t.db.mutate("org.update", { settings: { autoApproveAt: 0.5 } });
  assert.equal(t.db.mutate("session.create", { id: "later" }).autoApproveAt, 0.5, "new sessions take the organization's threshold");
  assert.equal(t.session().autoApproveAt, 0.9, "existing sessions keep theirs");
  assert.throws(() => t.db.mutate("session.configure", { session: "s", autoApproveAt: 1.5 }));
});

test("the reviewer sees the latest request and the recent events that led to the calls", async () => {
  const t = await setup(reviewed);
  t.say("earlier turn");
  t.reply(t.claim(), [text("done")]);
  const request = `Tidy up the repository. ${"Details. ".repeat(400)}`;
  t.say(request);
  for (let step = 1; step <= 6; step++) {
    t.reply(t.claim(), [call(`l${step}`, "list_files", { path: `dir${step}` })], "tool_use");
    t.finishTool(t.tool(), `files of dir${step}`);
  }
  t.reply(t.claim(), [text("Removing build output."), call("rm", "bash", { command: "rm -rf build" }), call("title", "set_title", { title: "Tidying" })], "tool_use");

  const seen = t.reviewRequest(t.review())!;
  assert.deepEqual(seen.calls, [{
    id: "rm", name: "bash", description: seen.calls[0]!.description, input: { command: "rm -rf build" }, prompt: "Run: rm -rf build", runsOn: "computer", server: null,
  }]);
  assert.match(seen.calls[0]!.description, /^Run a bash command/);
  assert.equal(seen.computer, "local");
  assert.equal(seen.surface, null);
  assert.equal(seen.omitted, 1, "the oldest step of the turn is left out");
  const lines = seen.events.map((event) => summarize(event.body));
  assert.equal(lines.length, 13);
  assert.match(lines[0]!, /^user Tidy up the repository\. Details\./);
  assert.match(lines[0]!, /… \(\d+ more characters\)$/, "long texts are clipped");
  assert.deepEqual(lines.slice(1, 3), ["result l1: files of dir1", "assistant list_files#l2"]);
  assert.equal(lines.at(-1), "assistant Removing build output. bash#rm set_title#title", "the response ends the context; its calls' results do not follow");
});

test("a review that fails, stalls or loses its worker leaves the calls to the user", async () => {
  const t = await setup(reviewed);
  const turn = (message: string) => {
    t.say(message);
    t.reply(t.claim(), [call("c", "bash", { command: message })], "tool_use");
    t.log();
  };
  const settle = () => {
    assert.equal(t.session().turn!.calls.c!.state, "awaiting");
    t.db.mutate("session.resolve", { session: "s", call: "c", approve: false });
    t.reply(t.claim(), [text("ok")]);
  };

  turn("nobody reviews this");
  t.db.advance(20_000);
  assert.deepEqual(t.log().slice(0, 2), ["reviewed c not approved: The review took too long.", "awaiting c permission"]);
  assert.ok(t.noReview(), "the stalled job is withdrawn");
  settle();

  turn("the reviewer crashes");
  const crashed = t.review();
  t.db.mutate("reviews.fail", { id: crashed.id, owner: crashed.owner, token: crashed.token, error: { message: "boom" } }, asWorker);
  assert.deepEqual(t.log(), [], "a crash is retried first");
  t.db.advance(500);
  const again = t.review();
  assert.equal(again.attempt, 2);
  t.db.mutate("reviews.fail", { id: again.id, owner: again.owner, token: again.token, error: { message: "boom" } }, asWorker);
  assert.deepEqual(t.log().slice(0, 2), ["reviewed c not approved: The review failed: boom", "awaiting c permission"]);
  settle();

  turn("the reviewer vanishes");
  for (let attempt = 1; attempt <= 2; attempt++) {
    assert.equal(t.db.mutate("reviews.claim", { owner: "jev", leaseMs: 1_000 }, asWorker)!.attempt, attempt);
    t.db.advance(1_000);
  }
  assert.ok(t.noReview());
  assert.deepEqual(t.log().slice(0, 2), ["reviewed c not approved: The reviewer did not answer.", "awaiting c permission"]);
  settle();
});

test("a halt cancels calls under review and fences the reviewer", async () => {
  const t = await setup(reviewed);
  t.say("deploy");
  t.reply(t.claim(), [call("c1", "bash", { command: "make deploy" })], "tool_use");
  const review = t.review();
  t.log();
  t.db.mutate("session.halt", { session: "s" });
  assert.deepEqual(t.log(), ["resolved c1 cancelled", "result c1 error: Cancelled by user halt.", "status halted", "interrupted"]);
  assert.throws(() => t.verdicts(review, { c1: approve() }), leaseLost);
  t.db.advance(20_000);
  assert.deepEqual(t.log(), [], "the review's timer went with it");
  assert.ok(t.noTool());
});

test("a steer during a review preempts the prompts it would have opened", async () => {
  const t = await setup(reviewed);
  t.say("clean up");
  t.reply(t.claim(), [call("c1", "bash", { command: "make clean" }), call("c2", "bash", { command: "git clean -fdx" })], "tool_use");
  const review = t.review();
  t.say("keep untracked files", true);
  assert.equal(t.session().status, "working", "the steer waits for the reviewing calls");
  t.verdicts(review, { c1: approve(), c2: decline() });
  t.finishTool(t.tool(), "exit 0");
  const next = t.claim();
  assert.deepEqual(t.promptLog(next).slice(-3), [
    "result c2 error: The user sent a new message instead of responding to this.", "result c1: exit 0", "user keep untracked files",
  ]);
});

test("organizations and sessions opt out; allowed tools and questions skip the review", async () => {
  const t = await setup();
  const created = t.db.mutate("org.create", { id: "beta", name: "Beta" });
  assert.equal(created.settings.autoApprove, true, "autoapproval is on by default");
  const inBeta = { credentials: { subject: "alice", claims: { role: "user", org: "beta" } } };
  assert.equal(t.db.mutate("session.create", { id: "b" }, inBeta).autoApprove, true);

  // The harness turned acme's default off.
  assert.equal(t.session().autoApprove, false);
  t.say("clean");
  t.reply(t.claim(), [call("c1", "bash", { command: "make clean" })], "tool_use");
  assert.equal(t.session().turn!.calls.c1!.state, "awaiting");
  assert.ok(t.noReview());
  t.db.mutate("session.resolve", { session: "s", call: "c1", approve: false });
  t.reply(t.claim(), [text("ok")]);

  t.db.mutate("session.configure", { session: "s", autoApprove: true, allow: ["write_file"] });
  t.say("again");
  t.reply(t.claim(), [
    call("w", "write_file", { path: "x", content: "y" }),
    call("q", "ask_user", { question: "Which target?" }),
    call("b", "bash", { command: "make" }),
    call("s", "subagent", { description: "check", prompt: "check the build" }),
  ], "tool_use");
  const calls = t.session().turn!.calls;
  assert.deepEqual([calls.w!.state, calls.q!.state, calls.b!.state], ["running", "awaiting", "reviewing"]);
  assert.deepEqual(t.review().payload.calls, ["b"]);
  assert.equal(t.session("s.s").autoApprove, true, "subagents review like their parent");
  assert.equal(t.session("s.s").autoApproveAt, t.session().autoApproveAt);
});
