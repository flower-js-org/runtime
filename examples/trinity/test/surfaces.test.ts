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
  const say = (ts: string, value: string, options: { user?: string; thread?: string; mentioned?: boolean; dm?: boolean } = {}) =>
    t.db.mutate("slack.receive", {
      team: "T1", channel: options.dm ? "D1" : "C1", thread: options.thread ?? ts, ts, user: options.user ?? "U1", text: value,
      dm: options.dm ?? false, mentioned: options.mentioned ?? true,
    }, asGateway);
  const link = (user: string, subject: string) => t.db.mutate("slack.link", { team: "T1", user, org: "acme", subject }, asGateway);
  const posts = (): OutboundJob[] => {
    const jobs: OutboundJob[] = [];
    for (let claim; (claim = t.db.mutate("outbound.claim", { scope: "slack", owner: "slack" }, asWorker)) !== null;) {
      jobs.push(claim.payload);
      t.db.mutate("outbound.complete", { scope: "slack", id: claim.id, owner: claim.owner, token: claim.token, result: null }, asWorker);
    }
    return jobs;
  };
  return { ...t, say, link, posts };
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

test("a Slack thread's messages are marked until the turn answers them; replies without a mention get one nudge", async () => {
  const t = await slack();
  t.link("U1", "alice");
  const { session } = t.say("200.1", "hi");
  assert.deepEqual(t.say("200.5", "chatting among ourselves", { thread: "200.1", mentioned: false }), { outcome: "nudge" });
  assert.deepEqual(t.say("200.6", "still chatting", { thread: "200.1", mentioned: false }), { outcome: "ignored" });
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

test("Slack prompts become cards that follow their calls, wherever they are answered", async () => {
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

  // Approved on the web: the card says so.
  t.db.mutate("session.resolve", { session: session!, call: "b1", approve: true });
  assert.deepEqual(t.posts().map((job) => job.message), [{ kind: "resolved", call: "b1", card: "400.2", prompt: "Run: rm -rf build", resolution: "approved", by: "alice" }]);

  // Denied from Slack by someone who has not connected yet, then after connecting.
  const deny = { team: "T1", user: "U2", session: session!, call: "b2", approve: false };
  assert.deepEqual(t.db.mutate("slack.resolve", deny, asGateway), { outcome: "link" });
  t.link("U2", "bob");
  assert.deepEqual(t.db.mutate("slack.resolve", deny, asGateway), { outcome: "resolved" });
  assert.deepEqual(t.db.mutate("slack.resolve", deny, asGateway), { outcome: "stale" });
  assert.deepEqual(t.posts().map((job) => job.message), [{ kind: "resolved", call: "b2", card: "400.3", prompt: "Run: rm -rf dist", resolution: "denied", by: "bob" }]);
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
