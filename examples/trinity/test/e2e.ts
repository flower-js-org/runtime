// The whole stack on a real Flower server: the bundle under QuickJS verifying JWTs, the
// gateway, a computer running local tools on its own token, the service worker sealing
// to blob storage and reviewing permission requests, the Slack worker against a stand-in
// for Slack, and scripted stand-ins for the model and for Jev.
// Run with `npm run e2e`; FLOWER_BIN selects the server (default the repository's target/release/flower).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FlowerAdmin, FlowerClient } from "@flower-js/sdk";
import { runQueueWorker } from "@flower-js/sdk/worker";
import type app from "../app/index.ts";
import type { Block, CompletionJob, CompletionOutcome, Event } from "../app/model.ts";
import { createGateway } from "../gateway/server.ts";
import { publicKeyPem, signToken } from "../workers/auth.ts";
import { FileBlobStore } from "../workers/blobs.ts";
import { deployApp } from "../workers/deploy.ts";
import { runLocalWorker } from "../workers/local.ts";
import { runService } from "../workers/service.ts";
import { runSlack, type SocketLike } from "../workers/slack.ts";

const binary = process.env.FLOWER_BIN ?? new URL("../../../target/release/flower", import.meta.url).pathname;

async function freePort(): Promise<number> {
  const server: Server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return port;
}

async function until<T>(label: string, attempt: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`${label} did not succeed`, { cause: error });
      await delay(100);
    }
  }
}

const scratch = await mkdtemp(join(tmpdir(), "trinity-e2e-"));
const workspace = join(scratch, "workspace");
await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
await writeFile(join(workspace, "notes.txt"), "remember the milk");
const port = await freePort();
const adminToken = randomUUID();
const server = spawn(binary, ["--id", "1", "--listen", `127.0.0.1:${port}`, "--data", join(scratch, "data")], {
  env: { ...process.env, FLOWER_ADMIN_TOKEN: adminToken, RUST_LOG: "warn" },
  stdio: ["ignore", "ignore", "inherit"],
});
const stop = new AbortController();
const { privateKey } = generateKeyPairSync("ed25519");
const blobs = new FileBlobStore(join(scratch, "blobs"));
const flowerUrl = `http://127.0.0.1:${port}`;
const slack = fakeSlack();
const gateway = createGateway({ flowerUrl, signingKey: privateKey, blobs, devLogin: true, slackFetch: slack.fetch });
await new Promise<void>((done) => gateway.listen(0, "127.0.0.1", done));
const gatewayUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;

async function post(path: string, body: unknown, token?: string) {
  const response = await fetch(gatewayUrl + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, `${path} answered ${response.status}`);
  return response.json() as Promise<{ token: string }>;
}

/** Slack's Web API and one Socket Mode connection, recording what the bot does and letting the test speak for Slack. */
function fakeSlack() {
  const calls: Array<{ method: string; args: Record<string, any> }> = [];
  let posts = 0;
  let listeners: Record<string, Array<(event: { data: unknown }) => void>> = {};
  let opened: () => void = () => {};
  const connected = new Promise<void>((done) => { opened = done; });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).replace("https://slack.com/api/", "");
    const args = Object.fromEntries([...new URLSearchParams(String(init?.body ?? ""))].map(([key, value]) => [key, /^[[{]/.test(value) ? JSON.parse(value) : value]));
    calls.push({ method, args });
    const answers: Record<string, unknown> = {
      "auth.test": { ok: true, team_id: "T1", team: "Acme", url: "https://acme.slack.com/", user_id: "UBOT", bot_id: "B1" },
      "apps.connections.open": { ok: true, url: "wss://slack.example/socket" },
      "chat.postMessage": { ok: true, ts: `900.${++posts}` },
      "conversations.info": { ok: true, channel: { name: "eng" } },
    };
    return Response.json(answers[method] ?? { ok: true });
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    calls,
    connected,
    connect: (): SocketLike => {
      listeners = {};
      queueMicrotask(opened);
      return { send() {}, close() { for (const listener of listeners.close ?? []) listener({ data: null }); }, addEventListener: (type: string, listener: any) => { (listeners[type] ??= []).push(listener); } } as SocketLike;
    },
    emit(envelope: unknown) { for (const listener of listeners.message ?? []) listener({ data: JSON.stringify(envelope) }); },
    mention(ts: string, text: string, thread?: string) {
      this.emit({ type: "events_api", envelope_id: `e-${ts}`, payload: { team_id: "T1", event: { type: "message", channel: "C1", channel_type: "channel", user: "U1", ts, text: `<@UBOT> ${text}`, ...(thread ? { thread_ts: thread } : {}) } } });
    },
    async next(method: string, match: (args: Record<string, any>) => boolean = () => true): Promise<Record<string, any>> {
      return until(`Slack ${method}`, async () => {
        const found = calls.find((call) => call.method === method && match(call.args));
        if (found === undefined) throw new Error(`not yet: ${calls.map((call) => call.method).join(", ")}`);
        return found.args;
      });
    },
  };
}

/** Confident only about what "Show my notes" asked for, so the other permission requests still ask. */
const jev = (async (_url: string | URL | Request, init?: RequestInit) => {
  const { state, questions } = JSON.parse(String(init!.body));
  const asked = state.conversation.some((entry: { role: string; text?: string }) => entry.role === "user" && entry.text === "Show my notes");
  const answers = Object.fromEntries(Object.keys(questions).map((key) => [key, { type: "noul", noul: asked ? 0.98 : 0.3 }]));
  return Response.json({ answers, model: "jev-e2e", usage: { input_tokens: 1, output_tokens: 1 } });
}) as typeof fetch;

/** Answers like a model would, from what the request holds. */
function script(kind: CompletionJob["kind"], events: readonly Event[]): { blocks: Block[]; stopReason: string; input: number } {
  const last = events.at(-1)!.body;
  if (kind === "compact") return { blocks: [{ type: "text", text: "Alice asked about her workspace: notes.txt says to remember the milk." }], stopReason: "end_turn", input: 500 };
  if (last.type === "user" && last.text === "Show my notes") return { blocks: [{ type: "tool_call", id: "call-cat", name: "bash", input: { command: "cat notes.txt" } }], stopReason: "tool_use", input: 1_000 };
  if (last.type === "user" && last.text === "What is in my workspace?") return { blocks: [{ type: "text", text: "Let me look." }, { type: "tool_call", id: "call-list", name: "list_files", input: {} }], stopReason: "tool_use", input: 1_000 };
  if (last.type === "tool_result" && last.call === "call-list") return { blocks: [{ type: "tool_call", id: "call-cat", name: "bash", input: { command: "cat notes.txt" } }], stopReason: "tool_use", input: 1_200 };
  if (last.type === "tool_result" && last.call === "call-cat") return { blocks: [{ type: "text", text: `Your notes say: ${last.content.split("\n").at(-1)}` }], stopReason: "end_turn", input: 20_000 };
  return { blocks: [{ type: "text", text: "Still remembering the milk." }], stopReason: "end_turn", input: 800 };
}

try {
  const admin = new FlowerAdmin(flowerUrl, { adminToken });
  await until("initialization", () => admin.initialize({ 1: `127.0.0.1:${port}` }));
  await until("deployment", () => deployApp({ flowerUrl, adminToken, publicKeyPem: publicKeyPem(privateKey), directory: join(scratch, "build") }));

  // Sign in through the gateway, create an organization and register this machine.
  const signedIn = await post("/auth/dev", { subject: "alice" });
  await new FlowerClient<typeof app>(gatewayUrl, { credentials: { token: signedIn.token } }).mutate("org.create", { id: "acme", name: "Acme" });
  const { token } = await post("/auth/switch", { org: "acme" }, signedIn.token);
  const alice = new FlowerClient<typeof app>(gatewayUrl, { credentials: { token } });
  await alice.mutate("computer.register", { id: "laptop", name: "Laptop" });
  const computer = await post("/auth/computer", { computer: "laptop" }, token);

  const workerToken = signToken(privateKey, { sub: "worker", role: "worker" }, 3_600);
  const worker = new FlowerClient<typeof app>(flowerUrl, { credentials: { token: workerToken } });
  const prompts: Array<{ kind: string; first: string }> = [];
  const workers = Promise.all([
    runLocalWorker(new FlowerClient<typeof app>(gatewayUrl, { credentials: { token: computer.token } }), { computer: "laptop", workspace, blobs, signal: stop.signal }),
    runService(worker, { signal: stop.signal, secrets: () => undefined, blobs, loops: ["tools", "reviews", "sealing"], jev: { apiKey: "e2e", fetch: jev } }),
    runQueueWorker<CompletionJob, CompletionOutcome>(worker, {
      queue: "completions", signal: stop.signal, leaseMs: 10_000,
      async work(job) {
        const { value: prompt } = await worker.query("session.prompt", { session: job.payload.session, step: job.payload.step });
        assert.ok(prompt);
        prompts.push({ kind: prompt.kind, first: prompt.events[0]!.body.type });
        const reply = script(prompt.kind, prompt.events);
        await worker.mutate("completions.progress", { id: job.id, owner: job.owner, token: job.token, deltas: [{ index: 0, type: "text", text: "…" }] });
        return { ok: true, message: { blocks: reply.blocks, model: "claude-opus-5", stopReason: reply.stopReason, usage: { input: reply.input, output: 50, cacheRead: 0, cacheWrite: 0 } } };
      },
    }),
  ]);

  await alice.mutate("session.create", { id: "e2e", computer: "laptop", contextTokens: 10_000 });
  await alice.mutate("session.send", { session: "e2e", message: "m1", text: "What is in my workspace?" });
  const asked = await alice.waitUntil("session.get", { session: "e2e" }, (session) => session?.status === "waiting_on_user", { signal: AbortSignal.timeout(20_000) });
  assert.equal(asked.value!.turn!.calls["call-cat"]!.state, "awaiting");
  const { value: reviewed } = await alice.query("session.tail", { session: "e2e" });
  assert.ok(reviewed!.events.some(({ body }) => body.type === "tool_reviewed" && !body.approved && body.reviewer === "jev-e2e"), "Jev reviewed the call first");
  await alice.mutate("session.resolve", { session: "e2e", call: "call-cat", approve: true });
  await alice.waitUntil("session.get", { session: "e2e" }, (session) => session?.status === "idle", { signal: AbortSignal.timeout(20_000) });

  // The last response used 20,000 input tokens: the next turn compacts first, and the log before the summary is sealed.
  await alice.mutate("session.send", { session: "e2e", message: "m2", text: "And now?" });
  const sealed = await alice.waitUntil("session.get", { session: "e2e" }, (session) => session?.status === "idle" && session.sealedThrough > 0, { signal: AbortSignal.timeout(20_000) });
  assert.deepEqual(prompts.map((prompt) => prompt.kind), ["respond", "respond", "respond", "compact", "respond"]);
  assert.equal(prompts.at(-1)!.first, "compact");

  const { value: view } = await alice.query("session.tail", { session: "e2e" });
  assert.equal(view!.events[0]!.seq, sealed.value!.sealedThrough + 1);
  const segment = view!.segments[0]!;
  const download = await fetch(`${gatewayUrl}/blobs/e2e/${segment.key}?token=${token}`);
  const history = (await download.text()).split("\n").map((line) => JSON.parse(line) as Event);
  assert.equal(history.length, segment.count);
  assert.ok(history.some((event) => event.body.type === "tool_result" && event.body.content.includes("remember the milk")));
  assert.equal(view!.session.lastText, "Still remembering the milk.");

  const { value: spent } = await alice.query("org.usage", {});
  assert.equal(spent.completions, 5);

  // Slack: the workspace connects through the gateway, a stranger is asked to connect their
  // account, then a mention runs a turn whose approval is a button in the thread.
  await alice.mutate("org.update", { settings: { computer: "laptop" } });
  const connected = await fetch(`${gatewayUrl}/slack/connect`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ token: "xoxb-e2e" }) });
  assert.equal(connected.status, 200);
  const service = new FlowerClient<typeof app>(flowerUrl, { credentials: { token: signToken(privateKey, { sub: "slack", role: "service" }, 3_600) } });
  const slackWorker = runSlack({ service, worker }, { signal: stop.signal, appToken: "xapp-e2e", signingKey: privateKey, publicUrl: gatewayUrl, fetch: slack.fetch, connect: slack.connect });
  await slack.connected;
  slack.emit({ type: "hello" });
  slack.mention("100.1", "hello?");
  const invite = await slack.next("chat.postEphemeral");
  const grant = new URLSearchParams(invite.blocks[1].elements[0].url.split("?")[1]).get("grant")!;
  const linked = await fetch(`${gatewayUrl}/slack/link`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ grant }) });
  assert.deepEqual(await linked.json(), { workspace: "Acme" });

  slack.mention("100.2", "What is in my workspace?");
  const card = await slack.next("chat.postMessage", (args) => args.blocks?.[1]?.type === "actions");
  assert.equal(card.thread_ts, "100.2");
  const approve = card.blocks[1].elements.find((button: { action_id: string }) => button.action_id === "trinity.approve");
  slack.emit({ type: "interactive", envelope_id: "e-click", payload: {
    type: "block_actions", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" }, message: { ts: "900.1", thread_ts: "100.2" }, actions: [approve],
  } });
  await slack.next("chat.update", (args) => /Approved by alice/.test(args.text));
  const answer = await slack.next("chat.postMessage", (args) => args.blocks?.[0]?.text?.includes("remember the milk"));
  assert.match(answer.blocks.at(-1).elements[0].text, /Open in Trinity/);
  await slack.next("reactions.add", (args) => args.name === "white_check_mark" && args.timestamp === "100.2");
  assert.ok(slack.calls.some((call) => call.method === "reactions.remove" && call.args.name === "eyes" && call.args.timestamp === "100.2"));

  // Jev approves a call the user plainly asked for: it runs without asking.
  await alice.mutate("session.create", { id: "e2e-auto", computer: "laptop" });
  await alice.mutate("session.send", { session: "e2e-auto", message: "m1", text: "Show my notes" });
  const auto = await alice.waitUntil("session.get", { session: "e2e-auto" }, (session) => session?.status === "idle" || session?.status === "waiting_on_user", { signal: AbortSignal.timeout(20_000) });
  assert.equal(auto.value!.status, "idle");
  assert.equal(auto.value!.lastText, "Your notes say: remember the milk");
  const { value: autoLog } = await alice.query("session.tail", { session: "e2e-auto" });
  assert.deepEqual(autoLog!.events.flatMap(({ body }) => body.type === "tool_reviewed" ? [[body.call, body.approved]] : body.type === "tool_awaiting" ? [["asked", body.call]] : []), [["call-cat", true]]);
  stop.abort();
  await Promise.all([workers, slackWorker]);
  console.log("e2e: permission prompts, autoapproval, local tools, compaction, sealing and a Slack thread ran across the real stack");
} finally {
  stop.abort();
  gateway.close();
  server.kill("SIGTERM");
  await new Promise((done) => server.once("close", done));
  await rm(scratch, { recursive: true, force: true });
}
