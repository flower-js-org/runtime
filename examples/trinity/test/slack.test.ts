import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import type { OutboundJob } from "../app/store.ts";
import { deriveKey, seal, verifyGrant } from "../workers/secrets.ts";
import { slackManifest, upsertEnv } from "../workers/slack-setup.ts";
import {
  parseMessage, promptCard, replyPosts, resolvedCard, runSocketMode, slackCall, SlackError, slackHandlers, type SocketLike,
} from "../workers/slack.ts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Slack's Web API, answering by method, recording each call's form arguments (objects decoded). */
function fakeSlack(answers: Record<string, (args: Record<string, any>) => Response | Record<string, unknown>> = {}) {
  const calls: Array<{ method: string; args: Record<string, any>; auth: string | null }> = [];
  let posted = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).replace("https://slack.com/api/", "");
    const args = Object.fromEntries([...new URLSearchParams(String(init?.body ?? ""))].map(([key, value]) => {
      try { return [key, /^[[{]/.test(value) ? JSON.parse(value) : value]; } catch { return [key, value]; }
    }));
    calls.push({ method, args, auth: new Headers(init?.headers).get("authorization") });
    const answer = answers[method]?.(args) ?? (method === "chat.postMessage" ? { ok: true, ts: `900.${++posted}` }
      : method === "conversations.info" ? { ok: true, channel: { name: "eng" } } : { ok: true });
    return answer instanceof Response ? answer : json(answer);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, methods: () => calls.map((call) => call.method) };
}

test("Web API calls are form-encoded, and rate limits and outages are retried", async () => {
  let attempt = 0;
  const slack = fakeSlack({
    "chat.postMessage": () => (++attempt === 1 ? json({ ok: false, error: "ratelimited" }, 429, { "retry-after": "0" }) : { ok: true, ts: "1.2" }),
    "chat.update": () => ({ ok: false, error: "channel_not_found" }),
  });
  const posted = await slackCall("xoxb-1", "chat.postMessage", { channel: "C1", blocks: [{ type: "markdown", text: "hi" }], unfurl_links: false }, { fetch: slack.fetch });
  assert.equal(posted.ts, "1.2");
  assert.deepEqual(slack.calls[1], { method: "chat.postMessage", args: { channel: "C1", blocks: [{ type: "markdown", text: "hi" }], unfurl_links: "false" }, auth: "Bearer xoxb-1" });
  await assert.rejects(slackCall("xoxb-1", "chat.update", {}, { fetch: slack.fetch }), (error) => error instanceof SlackError && error.code === "channel_not_found" && !error.retryable);
  await slackCall("", "oauth.v2.access", { code: "c" }, { fetch: slack.fetch });
  assert.equal(slack.calls.at(-1)!.auth, null, "OAuth exchanges carry client credentials, not a token");
});

test("messages the bot answers, and everything it leaves alone", () => {
  const message = (fields: Record<string, unknown>) => parseMessage({ type: "message", channel: "C1", channel_type: "channel", user: "U1", ts: "1.1", ...fields }, "UBOT");
  assert.deepEqual(message({ text: "<@UBOT> fix &lt;this&gt; &amp; that" }), {
    channel: "C1", ts: "1.1", thread: "1.1", user: "U1", text: "fix <this> & that", dm: false, mentioned: true, edited: false, files: [],
  });
  assert.equal(message({ text: "in a thread", thread_ts: "1.0" })!.thread, "1.0");
  assert.equal(message({ text: "hello", channel_type: "im" })!.dm, true);
  assert.equal(message({ text: "no mention" })!.mentioned, false);
  assert.equal(message({ text: "<@UBOT> hi", subtype: "file_share", files: [{ name: "a.png" }] })!.files.length, 1);
  assert.equal(message({ text: "<@UBOT> mine", user: "UBOT" }), null);
  assert.equal(message({ text: "<@UBOT> beep", bot_id: "B9" }), null);
  assert.equal(message({ text: "joined", subtype: "channel_join" }), null);
  const edit = (before: string, after: string) => parseMessage({
    type: "message", subtype: "message_changed", channel: "C1", channel_type: "channel",
    message: { user: "U1", ts: "1.1", text: after }, previous_message: { text: before },
  }, "UBOT");
  assert.equal(edit("please look", "<@UBOT> please look")!.edited, true, "an edit that adds the mention counts");
  assert.equal(edit("<@UBOT> please", "<@UBOT> please look"), null, "fixing a typo does not ask again");
});

test("answers, prompts and settled prompts as Slack messages", () => {
  const long = replyPosts(`${"a".repeat(10_990)}\n${"b".repeat(100)}`, false, "https://t.example/#/sessions/s");
  assert.equal(long.length, 2);
  assert.deepEqual(long[0]!.blocks, [{ type: "markdown", text: "a".repeat(10_990) }]);
  assert.deepEqual(long[1]!.blocks.at(-1), { type: "context", elements: [{ type: "mrkdwn", text: "<https://t.example/#/sessions/s|Open in Trinity>" }] });
  assert.equal(replyPosts("It broke", true, null)[0]!.text, "⚠️ It broke");

  const approval = promptCard({ id: "c1", approval: "permission", prompt: "Run: rm -rf build" }, "s1", null);
  const buttons = (approval.blocks[1] as { elements: Array<{ action_id: string; value: string }> }).elements;
  assert.deepEqual(buttons.map((button) => button.action_id), ["trinity.approve", "trinity.deny"]);
  assert.deepEqual(JSON.parse(buttons[0]!.value), { session: "s1", call: "c1" });
  const question = promptCard({ id: "q", approval: "elicitation", prompt: "Which branch?" }, "s1", "https://t.example/x");
  const [answer, open] = (question.blocks[1] as { elements: Array<{ action_id: string; value?: string; url?: string }> }).elements;
  assert.deepEqual(JSON.parse(answer!.value!), { session: "s1", call: "q", question: "Which branch?" });
  assert.equal(open!.url, "https://t.example/x");

  assert.equal(resolvedCard("Run: rm -rf build", "approved", "alice").text, "✅ Approved by alice: Run: rm -rf build");
});

test("Socket Mode acknowledges every envelope at once and reconnects when Slack asks", async () => {
  const stop = new AbortController();
  const sockets: Array<{ sent: string[]; emit(data: unknown): void; closed: boolean }> = [];
  const connect = (): SocketLike => {
    const listeners: Record<string, Array<(event: { data: unknown }) => void>> = {};
    const socket = {
      sent: [] as string[],
      closed: false,
      emit(data: unknown) { for (const listener of listeners.message ?? []) listener({ data: JSON.stringify(data) }); },
      send(data: string) { socket.sent.push(data); },
      close() {
        if (socket.closed) return;
        socket.closed = true;
        for (const listener of listeners.close ?? []) listener({ data: null });
      },
      addEventListener(type: string, listener: (event: { data: unknown }) => void) { (listeners[type] ??= []).push(listener); },
    };
    sockets.push(socket);
    return socket;
  };
  const opened: string[] = [];
  const envelopes: string[] = [];
  const running = runSocketMode({
    appToken: "xapp-1", signal: stop.signal, connect,
    call: (async (token: string, method: string) => { opened.push(`${method}:${token}`); return { url: "wss://slack.example" }; }) as typeof slackCall,
    onEnvelope: (envelope) => envelopes.push(envelope.envelope_id!),
  });
  while (sockets.length < 1) await new Promise((done) => setTimeout(done, 1));
  sockets[0]!.emit({ type: "hello" });
  sockets[0]!.emit({ type: "events_api", envelope_id: "e1", payload: {} });
  assert.deepEqual(sockets[0]!.sent, [JSON.stringify({ envelope_id: "e1" })]);
  assert.deepEqual(envelopes, ["e1"]);
  sockets[0]!.emit({ type: "disconnect", reason: "refresh_requested" });
  while (sockets.length < 2) await new Promise((done) => setTimeout(done, 5));
  assert.deepEqual(opened, ["apps.connections.open:xapp-1", "apps.connections.open:xapp-1"]);
  stop.abort();
  await running;
  assert.ok(sockets[1]!.closed);
});

const { privateKey } = generateKeyPairSync("ed25519");
const install = {
  team: "T1", org: "acme", name: "Acme", url: "https://acme.slack.com/", botUser: "UBOT", botId: "B1",
  token: seal(deriveKey(privateKey, "slack-tokens"), "xoxb-1"), installedBy: "alice", installedAt: 0,
};

/** The worker's handlers against a fake Slack and fake Flower clients that answer by method. */
function worker(answers: Record<string, (args: any) => unknown> = {}) {
  const slack = fakeSlack();
  const flower: Array<{ method: string; args: any; requestId?: string }> = [];
  const client = {
    async mutate(method: string, args: any, options?: { requestId?: string }) {
      flower.push({ method, args, ...(options?.requestId ? { requestId: options.requestId } : {}) });
      return { value: answers[method]?.(args) ?? null };
    },
    async query(method: string, args: any) {
      if (method === "slack.installations") return { value: [install] };
      flower.push({ method, args });
      return { value: answers[method]?.(args) ?? null };
    },
  } as any;
  const handlers = slackHandlers({ service: client, worker: client }, {
    signal: new AbortController().signal, signingKey: privateKey, publicUrl: "https://trinity.example", fetch: slack.fetch,
  });
  const event = (fields: Record<string, unknown>) => handlers.handle({ type: "events_api", envelope_id: "e", payload: { team_id: "T1", event: { type: "message", channel: "C1", channel_type: "channel", user: "U1", ts: "5.1", ...fields } } });
  return { ...handlers, slack, flower, event };
}

test("a mention is marked as seen and delivered; a stranger is asked to connect their account", async () => {
  const known = worker({ "slack.receive": () => ({ outcome: "received", session: "slack-1", status: "working" }) });
  await known.event({ text: "<@UBOT> what changed?" });
  assert.deepEqual(known.slack.methods(), ["reactions.add", "conversations.info"]);
  assert.deepEqual(known.slack.calls[0]!.args, { name: "eyes", channel: "C1", timestamp: "5.1" });
  assert.deepEqual(known.flower, [{
    method: "slack.receive", requestId: "slack:T1:C1:5.1",
    args: { team: "T1", channel: "C1", thread: "5.1", ts: "5.1", user: "U1", text: "what changed?", dm: false, mentioned: true, label: "#eng", attachments: [] },
  }]);

  const stranger = worker({ "slack.receive": () => ({ outcome: "link" }) });
  await stranger.event({ text: "<@UBOT> hello" });
  assert.deepEqual(stranger.slack.methods(), ["reactions.add", "conversations.info", "reactions.remove", "chat.postEphemeral"]);
  const connect = stranger.slack.calls.at(-1)!.args;
  assert.equal(connect.user, "U1");
  const url = new URL(connect.blocks[1].elements[0].url.replace("/#/", "/"));
  assert.deepEqual(verifyGrant(deriveKey(privateKey, "grants"), url.searchParams.get("grant")!), { team: "T1", user: "U1", org: "acme" });

  const chatter = worker({ "slack.receive": () => ({ outcome: "nudge" }) });
  await chatter.event({ text: "unrelated", thread_ts: "5.0" });
  assert.deepEqual(chatter.slack.methods(), ["conversations.info", "chat.postEphemeral"]);
  assert.match(chatter.slack.calls[1]!.args.text, /mention <@UBOT>/);
  await chatter.event({ text: "top-level chatter" });
  assert.equal(chatter.flower.length, 1, "top-level messages without a mention never reach the database");
});

test("buttons, answers and stop signs act as the linked member", async () => {
  const w = worker({ "slack.resolve": (args) => ({ outcome: args.approve === false ? "stale" : "resolved" }), "slack.halt": () => ({ halted: true }) });
  const action = (action_id: string, value: object) => w.handle({ type: "interactive", envelope_id: "e", payload: {
    type: "block_actions", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" }, message: { ts: "6.2", thread_ts: "6.1" }, trigger_id: "trig",
    actions: [{ action_id, value: JSON.stringify(value) }],
  } });
  await action("trinity.approve", { session: "s", call: "c1" });
  assert.deepEqual(w.flower.at(-1), { method: "slack.resolve", args: { team: "T1", user: "U1", session: "s", call: "c1", approve: true } });
  await action("trinity.deny", { session: "s", call: "c1" });
  assert.equal(w.slack.calls.at(-1)!.args.text, "That was already settled.");
  await action("trinity.answer", { session: "s", call: "q", question: "Which branch?" });
  const modal = w.slack.calls.at(-1)!;
  assert.equal(modal.method, "views.open");
  assert.equal(modal.args.trigger_id, "trig");
  await w.handle({ type: "interactive", envelope_id: "e", payload: {
    type: "view_submission", team: { id: "T1" }, user: { id: "U1" },
    view: { callback_id: "trinity.answer", private_metadata: modal.args.view.private_metadata, state: { values: { answer: { text: { value: " main " } } } } },
  } });
  assert.deepEqual(w.flower.at(-1), { method: "slack.resolve", args: { team: "T1", user: "U1", session: "s", call: "q", answer: "main" } });
  await w.handle({ type: "events_api", envelope_id: "e", payload: { team_id: "T1", event: { type: "reaction_added", reaction: "octagonal_sign", user: "U2", item: { type: "message", channel: "C1", ts: "6.2" } } } });
  assert.deepEqual(w.flower.at(-1), { method: "slack.halt", args: { team: "T1", channel: "C1", ts: "6.2", user: "U2" } });
});

test("deliveries post in the thread, then move the marks", async () => {
  const w = worker();
  const job = (message: OutboundJob["message"], marks: OutboundJob["marks"] = null): OutboundJob => ({
    org: "acme", surface: "slack", thread: "T1/C1/7.1", meta: { team: "T1", channel: "C1", thread: "7.1" }, session: "slack-1", seq: 9, message, marks,
  });
  await w.deliver(job({ kind: "reply", text: "Done.", error: false }, { pending: ["7.1", "7.3"], done: "7.3", previous: "7.0" }));
  assert.deepEqual(w.slack.calls.map(({ method, args }) => [method, args.name ?? args.thread_ts, args.timestamp ?? args.channel]), [
    ["chat.postMessage", "7.1", "C1"],
    ["reactions.remove", "eyes", "7.1"],
    ["reactions.remove", "eyes", "7.3"],
    ["reactions.remove", "white_check_mark", "7.0"],
    ["reactions.add", "white_check_mark", "7.3"],
  ]);
  assert.deepEqual(w.flower, [{ method: "slack.posted", args: { team: "T1", channel: "C1", thread: "7.1", ts: "900.1", session: "slack-1" } }]);

  await w.deliver(job({ kind: "ask", calls: [{ id: "c1", approval: "permission", prompt: "Run: ls" }] }));
  assert.deepEqual(w.flower.at(-1)!.args, { team: "T1", channel: "C1", thread: "7.1", ts: "900.2", session: "slack-1", call: "c1" });
  await w.deliver(job({ kind: "resolved", call: "c1", card: "900.2", prompt: "Run: ls", resolution: "denied", by: "bob" }));
  assert.deepEqual([w.slack.calls.at(-1)!.method, w.slack.calls.at(-1)!.args.ts, w.slack.calls.at(-1)!.args.text], ["chat.update", "900.2", "🚫 Denied by bob: Run: ls"]);
});

test("the manifest asks for Socket Mode, and setup keeps the rest of .env.local", async () => {
  const manifest = slackManifest({ name: "Trinity Dev", publicUrl: "http://127.0.0.1:8301" });
  assert.equal(manifest.settings.socket_mode_enabled, true);
  assert.equal(manifest.features.bot_user.display_name, "trinity-dev");
  assert.equal("redirect_urls" in manifest.oauth_config, false, "Slack takes only https redirects");
  assert.deepEqual(slackManifest({ name: "T", publicUrl: "https://t.example/" }).oauth_config.redirect_urls, ["https://t.example/slack/oauth"]);

  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const file = join(await mkdtemp(join(tmpdir(), "trinity-env-")), ".env.local");
  await writeFile(file, "ANTHROPIC_API_KEY=sk-1\nSLACK_APP_TOKEN=old\n");
  await upsertEnv(file, { SLACK_APP_TOKEN: "xapp-2", SLACK_APP_ID: "A1" });
  assert.equal(await readFile(file, "utf8"), "ANTHROPIC_API_KEY=sk-1\nSLACK_APP_TOKEN=xapp-2\nSLACK_APP_ID=A1\n");
});
