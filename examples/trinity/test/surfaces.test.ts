import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutboundJob } from "../app/store.ts";
import type { OrgSettings } from "../app/model.ts";
import { approve, bob, call, decline, failure, gateway, setup, text, worker } from "./support/harness.ts";

const asWorker = { credentials: worker };
const asGateway = { credentials: gateway };

async function slack(settings: Partial<OrgSettings> = {}) {
  const t = await setup({ settings: { computer: "laptop", ...settings } });
  t.db.mutate("slack.install", {
    org: "acme", team: "T1", name: "Acme", url: "https://acme.slack.com/", botUser: "UBOT", botId: "B1", token: "sealed", installedBy: "alice",
  }, asGateway);
  interface Say { user?: string; name?: string; thread?: string; mentioned?: boolean; dm?: boolean; history?: Array<{ ts: string; name: string; text: string }>; omitted?: number }
  const say = (ts: string, value: string, { user, name, thread, mentioned, dm, ...rest }: Say = {}) =>
    t.db.mutate("slack.receive", {
      team: "T1", channel: dm ? "D1" : "C1", thread: thread ?? ts, ts, user: user ?? "U1", ...(name === undefined ? {} : { name }), text: value,
      dm: dm ?? false, mentioned: mentioned ?? true, ...rest,
    }, asGateway);
  const change = (ts: string, kind: "edited" | "deleted", value: string, options: { thread: string; at: string; user?: string; name?: string }) =>
    t.db.mutate("slack.change", { team: "T1", channel: "C1", ts, kind, text: value, user: "U1", ...options }, asGateway).outcome;
  const link = (user: string, subject: string) => t.db.mutate("slack.link", { team: "T1", user, org: "acme", subject }, asGateway);
  const posts = (): OutboundJob[] => {
    const jobs: OutboundJob[] = [];
    for (let claim; (claim = t.db.mutate("outbound.claim", { scope: "slack", owner: "slack" }, asWorker)) !== null;) {
      jobs.push(claim.payload);
      t.db.mutate("outbound.complete", { scope: "slack", id: claim.id, owner: claim.owner, token: claim.token, result: null }, asWorker);
    }
    return jobs;
  };
  return { ...t, say, change, link, posts };
}

test("GitHub threads start sessions and hear back about the turns they started", async () => {
  const t = await setup({ settings: { computer: "laptop" } });
  const comment = (id: string, value: string) => t.db.mutate("surface.receive", {
    org: "acme", surface: "github", thread: "acme/api#7", message: id, author: "dev", text: value, meta: { repo: "acme/api", number: 7 },
  }, asGateway);
  const first = comment("c1", "clean up");
  t.reply(t.claim(), [call("q", "ask_user", { question: "Which branch?" }), call("b", "bash", { command: "git clean -fd" })], "tool_use");
  const asked = t.db.mutate("outbound.claim", { scope: "github", owner: "poster" }, asWorker)!;
  assert.deepEqual(asked.payload.message, { kind: "ask", calls: [
    { id: "q", approval: "elicitation", prompt: "Which branch?" },
    { id: "b", approval: "permission", prompt: "Run: git clean -fd" },
  ] });
  assert.equal(comment("c2", "main, and go ahead").session, first.session, "later comments reach the same session");
  assert.throws(() => t.db.mutate("surface.receive", { org: "acme", surface: "github", thread: "x", message: "y", author: "u", text: "z", meta: null }), failure("FORBIDDEN"));
});

test("Slack people act as the members they linked; others are asked to connect first", async () => {
  const t = await slack();
  assert.throws(() => t.db.mutate("slack.install", {
    org: "acme", team: "T2", name: "Other", url: "https://other.slack.com/", botUser: "U", botId: "B", token: "x", installedBy: "bob",
  }, asGateway), failure("FORBIDDEN"), "only admins connect workspaces");
  assert.deepEqual(t.say("100.1", "hello"), { outcome: "link" });
  assert.equal(t.say("100.1", "hello", { user: "U9" }).outcome, "link");
  t.link("U1", "alice");
  const received = t.say("100.2", "What does this repo do?");
  assert.equal(received.outcome, "received");
  const session = t.session(received.session);
  assert.equal(session.createdBy, "alice");
  assert.equal(session.private, false);
  assert.deepEqual(session.source, { surface: "slack", thread: "T1/C1/100.2", url: "https://acme.slack.com/archives/C1/p1002" });
  assert.equal(t.db.mutate("slack.receive", {
    team: "T9", channel: "C1", thread: "1.1", ts: "1.1", user: "U1", text: "hi", dm: false, mentioned: true,
  }, asGateway).outcome, "unknown");
  assert.deepEqual(t.db.query("slack.status"), { workspaces: [{ team: "T1", name: "Acme", url: "https://acme.slack.com/", installedBy: "alice", installedAt: 1_000_000 }], linked: [{ team: "T1", user: "U1" }] });
});

test("a Slack thread's messages are marked until the turn answers them", async () => {
  const t = await slack();
  t.link("U1", "alice");
  const { session } = t.say("200.1", "hi");
  assert.deepEqual(t.say("300.1", "a new thread without a mention", { mentioned: false }), { outcome: "ignored" });

  t.reply(t.claim(), [text("Hello!")]);
  const [reply] = t.posts();
  assert.deepEqual(reply!.message, { kind: "reply", text: "Hello!", error: false });
  assert.deepEqual(reply!.marks, { pending: ["200.1"], done: "200.1", previous: null });
  assert.deepEqual(reply!.meta, { team: "T1", channel: "C1", thread: "200.1" });

  t.say("200.7", "and now?", { thread: "200.1" });
  t.reply(t.claim(), [text("Now this.")]);
  assert.deepEqual(t.posts()[0]!.marks, { pending: ["200.7"], done: "200.7", previous: "200.1" });

  // Continued on the web: the answer stays on the web.
  t.db.mutate("session.send", { session: session!, message: "web1", text: "from the browser" });
  t.reply(t.claim(), [text("Answered in the browser")]);
  assert.deepEqual(t.posts(), []);
});

test("what a Slack thread says without a mention reaches its session with the next mention", async () => {
  const t = await slack();
  t.link("U1", "alice");
  const { session } = t.say("200.1", "hi", { name: "Alice" });
  t.reply(t.claim(), [text("Hello!")]);
  t.posts();
  t.log(session);
  const bob = { thread: "200.1", mentioned: false, user: "U2", name: "Bob" };
  assert.deepEqual(t.say("200.2", "lunch?", bob), { outcome: "nudge" });
  assert.deepEqual(t.say("200.3", "the deploy is at 3", bob), { outcome: "held" }, "people are nudged once");
  assert.equal(t.change("200.3", "edited", "the deploy is at 4", { thread: "200.1", at: "200.31", user: "U2", name: "Bob" }), "held");
  assert.equal(t.change("200.2", "deleted", "lunch?", { thread: "200.1", at: "200.32", user: "U2", name: "Bob" }), "held");
  assert.equal(t.change("200.1", "edited", "hi there", { thread: "200.1", at: "200.33", name: "Alice" }), "held");
  assert.equal(t.idle(), true, "only a mention starts a turn");
  assert.deepEqual(t.say("200.4", "what about staging?", bob), { outcome: "held" });

  // Bob edits his last reply to mention the bot.
  t.link("U2", "bob");
  t.say("200.4", "what about staging?", { ...bob, mentioned: true });
  const [opened] = t.log(session).filter((line) => line.startsWith("user"));
  assert.equal(opened, "user New in this thread:\n\n> **Bob:** the deploy is at 4\n>\n> **Alice** edited a message: hi there\n\nwhat about staging?",
    "an edit changes a held message and a deletion removes it; changes to delivered messages are told; an addressed message arrives once");
  t.reply(t.claim(), [text("At 4.")]);
  t.posts();

  // A long wait keeps the latest messages, and says how many it left out.
  for (let n = 0; n <= 50; n++) t.say(`201.${String(n).padStart(2, "0")}`, `m${n}`, bob);
  t.say("202.1", "", { thread: "200.1" });
  const summary = t.log(session).find((line) => line.startsWith("user"))!;
  assert.ok(summary.startsWith("user New in this thread:\n\n> (1 message not shown)\n>\n> **Bob:** m1\n>\n"), summary);
  assert.ok(summary.endsWith("> **Bob:** m50"), "a bare mention adds nothing after the thread");
});

test("while a turn answers in a Slack thread, the thread's messages join it at its next step as one message", async () => {
  const t = await slack();
  t.link("U1", "alice");
  t.link("U2", "bob");
  const { session } = t.say("210.1", "clean the build", { name: "Alice" });
  const first = t.claim();
  t.log(session);
  assert.deepEqual(t.say("210.2", "careful with dist/", { thread: "210.1", mentioned: false, name: "Alice" }), { outcome: "joined" });
  assert.equal(t.say("210.3", "and check the logs", { thread: "210.1", user: "U2", name: "Bob" }).outcome, "received");
  assert.equal(t.change("210.2", "edited", "careful with dist/ and out/", { thread: "210.1", at: "210.4", name: "Alice" }), "joined");
  assert.equal(t.session(session).queued.length, 1);
  assert.deepEqual(t.log(session), [], "nothing reaches the log before the step ends");

  t.reply(first, [text("Cleaning.")]);
  const next = t.claim();
  assert.deepEqual(t.promptLog(next).slice(-2), [
    "assistant Cleaning.",
    "user New in this thread:\n\n> **Alice:** careful with dist/\n\nand check the logs\n\n> **Alice** edited a message: careful with dist/ and out/",
  ]);
  t.reply(next, [text("Done.")]);
  assert.deepEqual(t.posts().map((job) => job.marks), [{ pending: ["210.1", "210.2", "210.3"], done: "210.3", previous: null }]);
});

test("a Slack reply without a mention leaves open prompts alone; a mention preempts them", async () => {
  const t = await slack();
  t.link("U1", "alice");
  const { session } = t.say("220.1", "clean the build");
  t.reply(t.claim(), [call("b1", "bash", { command: "rm -rf build" })], "tool_use");
  t.posts();
  t.log(session);
  assert.deepEqual(t.say("220.2", "hmm", { thread: "220.1", mentioned: false }), { outcome: "joined" });
  assert.equal(t.session(session).turn!.calls.b1!.state, "awaiting");
  t.say("220.3", "no, only build/tmp", { thread: "220.1" });
  assert.ok(t.log(session).includes("resolved b1 preempted"));
  assert.deepEqual(t.promptLog(t.claim()).slice(-2), [
    "result b1 error: The user sent a new message instead of responding to this.",
    "user New in this thread:\n\n> **U1:** hmm\n\nno, only build/tmp",
  ]);
});

test("a mention that starts a session in a Slack reply brings the thread's earlier messages", async () => {
  const t = await slack();
  t.link("U1", "alice");
  assert.deepEqual(t.say("230.9", "what broke?", { thread: "230.1" }), { outcome: "history" });
  const history = [{ ts: "230.1", name: "CI", text: "Build failed" }, { ts: "230.8", name: "Bob", text: "since this morning\non main" }];
  const { session } = t.say("230.9", "what broke?", { thread: "230.1", history, omitted: 6 });
  assert.deepEqual(t.promptLog(t.claim()), [
    "user Earlier in this thread:\n\n> **CI:** Build failed\n>\n> (6 messages not shown)\n>\n> **Bob:** since this morning\n> on main\n\nwhat broke?",
  ]);
  assert.equal(t.say("230.10", "and why?", { thread: "230.1" }).session, session, "only the first mention asks for history");
});

test("Slack prompts become cards that go once their calls are answered, wherever that is", async () => {
  const t = await slack();
  t.link("U1", "alice");
  const { session } = t.say("400.1", "clean the build");
  t.reply(t.claim(), [call("b1", "bash", { command: "rm -rf build" }), call("b2", "bash", { command: "rm -rf dist" })], "tool_use");
  const [asked] = t.posts();
  assert.deepEqual(asked!.message, { kind: "ask", calls: [
    { id: "b1", approval: "permission", prompt: "Run: rm -rf build" },
    { id: "b2", approval: "permission", prompt: "Run: rm -rf dist" },
  ] });
  for (const [ts, id] of [["400.2", "b1"], ["400.3", "b2"]]) {
    t.db.mutate("slack.posted", { team: "T1", channel: "C1", thread: "400.1", ts: ts!, session: session!, call: id! }, asWorker);
  }

  // Approved on the web: the card goes.
  t.db.mutate("session.resolve", { session: session!, call: "b1", approve: true });
  assert.deepEqual(t.posts().map((job) => job.message), [{ kind: "resolved", call: "b1", card: "400.2" }]);

  // Denied from Slack by someone who has not connected yet, then after connecting.
  const deny = { team: "T1", user: "U2", session: session!, call: "b2", approve: false };
  assert.deepEqual(t.db.mutate("slack.resolve", deny, asGateway), { outcome: "link" });
  t.link("U2", "bob");
  assert.deepEqual(t.db.mutate("slack.resolve", deny, asGateway), { outcome: "resolved" });
  assert.deepEqual(t.db.mutate("slack.resolve", deny, asGateway), { outcome: "stale" });
  assert.deepEqual(t.posts().map((job) => job.message), [{ kind: "resolved", call: "b2", card: "400.3" }]);
  assert.equal(t.session(session).turn!.calls.b2!.state, "done");
  assert.ok(t.db.query("session.get", { session: session! }, { credentials: bob }));
});

test("Slack threads are asked only about the calls the reviewer leaves to them", async () => {
  const t = await slack({ autoApprove: true });
  t.link("U1", "alice");
  t.say("700.1", "rebuild");
  t.reply(t.claim(), [call("b1", "bash", { command: "make" }), call("b2", "bash", { command: "rm -rf ~" })], "tool_use");
  assert.deepEqual(t.posts(), [], "nothing is asked while the reviewer decides");
  t.verdicts(t.review(), { b1: approve(), b2: decline() });
  assert.deepEqual(t.posts().map((job) => job.message), [{ kind: "ask", calls: [{ id: "b2", approval: "permission", prompt: "Run: rm -rf ~" }] }]);
});

test("a stop sign on any message of a Slack thread halts its session", async () => {
  const t = await slack();
  t.link("U1", "alice");
  const { session } = t.say("500.1", "long task");
  t.claim();
  t.db.mutate("slack.posted", { team: "T1", channel: "C1", thread: "500.1", ts: "500.2", session: session! }, asWorker);
  assert.deepEqual(t.db.mutate("slack.halt", { team: "T1", channel: "C1", ts: "500.2", user: "U7" }, asGateway), { halted: true, session });
  assert.equal(t.session(session).status, "halted");
  const [ended] = t.posts();
  assert.deepEqual(ended!.message, { kind: "ended" });
  assert.deepEqual(ended!.marks, { pending: ["500.1"], done: null, previous: null });
  assert.deepEqual(t.db.mutate("slack.halt", { team: "T1", channel: "C1", ts: "999.9", user: "U7" }, asGateway), { halted: false });
});

test("direct messages start private sessions", async () => {
  const t = await slack();
  t.link("U1", "alice");
  const { session } = t.say("600.1", "just between us", { dm: true, mentioned: false });
  assert.equal(t.session(session).private, true);
  assert.throws(() => t.db.query("session.get", { session: session! }, { credentials: bob }), failure("FORBIDDEN"));
});
