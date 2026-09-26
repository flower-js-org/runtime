import assert from "node:assert/strict";
import { createHmac, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createGateway } from "../gateway/server.ts";
import { verifyToken } from "../workers/auth.ts";
import { deriveKey, signGrant, unseal } from "../workers/secrets.ts";
import { FileBlobStore } from "../workers/blobs.ts";

const { privateKey } = generateKeyPairSync("ed25519");
const publicKey = createPublicKey(privateKey);
const calls: Array<{ path: string; body: Record<string, any> }> = [];

/** Answers the few methods the gateway calls, as Flower's HTTP API would. */
const flower = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  calls.push({ path: request.url!, body });
  const answers: Record<string, unknown> = {
    "org.mine": [{ id: "acme", name: "Acme", role: "admin" }],
    "computer.list": [{ id: "laptop", owner: "alice", kind: "local" }, { id: "box", owner: "alice", kind: "docker" }],
    "session.blob": body.args?.session === "s",
    "surface.receive": { session: "github-1", status: "working" },
    "slack.install": { team: "T1", name: "Acme", org: "acme" },
    "slack.link": { workspace: "Acme" },
    "session.get": { id: "s" },
  };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ revision: 1, value: answers[body.name] ?? null, duplicate: false }));
});

let gateway: Server;
let base = "";
let blobs: FileBlobStore;

before(async () => {
  await new Promise<void>((done) => flower.listen(0, "127.0.0.1", done));
  blobs = new FileBlobStore(await mkdtemp(join(tmpdir(), "trinity-gateway-")));
  gateway = createGateway({
    flowerUrl: `http://127.0.0.1:${(flower.address() as { port: number }).port}`,
    signingKey: privateKey,
    blobs,
    devLogin: true,
    slack: { clientId: "client", clientSecret: "secret" },
    publicUrl: "https://trinity.example",
    slackFetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).replace("https://slack.com/api/", "");
      const args = new URLSearchParams(String(init?.body ?? ""));
      if (method === "oauth.v2.access") return Response.json({ ok: args.get("code") === "abc", access_token: "xoxb-oauth" });
      return Response.json({ ok: true, team_id: "T1", team: "Acme", url: "https://acme.slack.com/", user_id: "UBOT", bot_id: "B1" });
    }) as typeof fetch,
    github: { secret: "gh-secret", botLogin: "trinity", owners: { "acme-inc": "acme" } },
  });
  await new Promise<void>((done) => gateway.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
});

after(() => {
  gateway.close();
  flower.close();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: response.status, value: await response.json() as any };
}

async function login() {
  return (await post("/auth/dev", { subject: "alice" })).value.token as string;
}

test("development sign-in, organization switching and computer tokens", async () => {
  const token = await login();
  assert.deepEqual({ ...verifyToken(publicKey, token), iat: 0, exp: 0 }, { iss: "trinity", aud: "trinity", iat: 0, exp: 0, sub: "alice", role: "user" });
  const switched = await post("/auth/switch", { org: "acme" }, { authorization: `Bearer ${token}` });
  assert.equal(verifyToken(publicKey, switched.value.token)?.org, "acme");
  assert.equal((await post("/auth/switch", { org: "evil" }, { authorization: `Bearer ${token}` })).status, 403);
  const computer = await post("/auth/computer", { computer: "laptop" }, { authorization: `Bearer ${switched.value.token}` });
  assert.deepEqual({ role: verifyToken(publicKey, computer.value.token)?.role, computer: verifyToken(publicKey, computer.value.token)?.computer }, { role: "computer", computer: "laptop" });
  assert.equal((await post("/auth/computer", { computer: "box" }, { authorization: `Bearer ${switched.value.token}` })).status, 403, "sandboxes get no computer token");
  assert.equal((await post("/auth/switch", { org: "acme" })).status, 401);
});

test("only Flower's /v1 API is reachable through the gateway", async () => {
  const response = await post("/v1/query", { name: "session.get", args: { session: "s" }, credentials: { token: "x" } });
  assert.deepEqual(response, { status: 200, value: { revision: 1, value: { id: "s" }, duplicate: false } });
  assert.deepEqual(calls.at(-1), { path: "/v1/query", body: { name: "session.get", args: { session: "s" }, credentials: { token: "x" } } });
  for (const path of ["/raft/metrics", "/admin/resources", "/v1x/query"]) assert.equal((await fetch(base + path)).status, 404, path);
});

test("uploads are stored and downloads need a token and a session that refers to the blob", async () => {
  const token = await login();
  const upload = await fetch(`${base}/uploads?name=notes.txt`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" }, body: "hello" });
  const attachment = await upload.json() as { blob: string; name: string; mediaType: string; size: number };
  assert.deepEqual({ ...attachment, blob: attachment.blob.length }, { blob: 71, name: "notes.txt", mediaType: "text/plain", size: 5 });
  assert.equal((await fetch(`${base}/blobs/s/${attachment.blob}`)).status, 401);
  const allowed = await fetch(`${base}/blobs/s/${attachment.blob}?token=${token}`);
  assert.equal(await allowed.text(), "hello");
  assert.equal((await fetch(`${base}/blobs/other/${attachment.blob}?token=${token}`)).status, 404);
});

test("Slack workspaces connect with a bot token or OAuth, and people link their accounts with the worker's grant", async () => {
  const token = (await post("/auth/switch", { org: "acme" }, { authorization: `Bearer ${await login()}` })).value.token as string;
  const auth = { authorization: `Bearer ${token}` };
  assert.equal((await post("/slack/connect", { token: "not-a-bot-token" }, auth)).status, 400);
  assert.equal((await post("/slack/connect", { token: "xoxb-1" }, auth)).status, 200);
  const install = calls.findLast((call) => call.body.name === "slack.install")!.body;
  assert.equal(verifyToken(publicKey, install.credentials.token)?.role, "service");
  const { token: sealed, ...rest } = install.args;
  assert.deepEqual(rest, { org: "acme", team: "T1", name: "Acme", url: "https://acme.slack.com/", botUser: "UBOT", botId: "B1", installedBy: "alice" });
  assert.equal(unseal(deriveKey(privateKey, "slack-tokens"), sealed), "xoxb-1", "Flower only ever sees the sealed token");

  const grant = signGrant(deriveKey(privateKey, "grants"), { team: "T1", user: "U1", org: "acme" }, 60);
  assert.equal((await post("/slack/link", { grant }, auth)).status, 200);
  assert.deepEqual(calls.findLast((call) => call.body.name === "slack.link")!.body.args, { team: "T1", user: "U1", org: "acme", subject: "alice" });
  assert.equal((await post("/slack/link", { grant: `${grant}x` }, auth)).status, 400);
  const elsewhere = signGrant(deriveKey(privateKey, "grants"), { team: "T1", user: "U1", org: "other" }, 60);
  assert.equal((await post("/slack/link", { grant: elsewhere }, auth)).status, 409);

  const { value: started } = await post("/slack/install", {}, auth);
  const authorize = new URL(started.url);
  assert.equal(authorize.searchParams.get("redirect_uri"), "https://trinity.example/slack/oauth");
  const callback = await fetch(`${base}/slack/oauth?code=abc&state=${encodeURIComponent(authorize.searchParams.get("state")!)}`, { redirect: "manual" });
  assert.equal(callback.headers.get("location"), "https://trinity.example/#/settings");
  assert.equal(unseal(deriveKey(privateKey, "slack-tokens"), calls.findLast((call) => call.body.name === "slack.install")!.body.args.token), "xoxb-oauth");
});

test("signed GitHub mentions become surface messages for the repository's organization", async () => {
  const raw = JSON.stringify({
    action: "created",
    repository: { full_name: "acme-inc/api" },
    issue: { number: 7, html_url: "https://github.com/acme-inc/api/issues/7" },
    comment: { id: 99, body: "@trinity please triage", user: { login: "dev" }, html_url: "https://github.com/acme-inc/api/issues/7#issuecomment-99" },
  });
  const signature = `sha256=${createHmac("sha256", "gh-secret").update(raw).digest("hex")}`;
  assert.equal((await post("/webhooks/github", raw, { "x-hub-signature-256": signature, "x-github-event": "issue_comment" })).status, 200);
  const receive = calls.findLast((call) => call.body.name === "surface.receive")!;
  assert.equal(receive.body.args.org, "acme");
  assert.equal(receive.body.args.thread, "acme-inc/api#7");
  assert.equal(receive.body.args.text, "please triage");
  assert.equal((await post("/webhooks/github", raw, { "x-hub-signature-256": "sha256=00", "x-github-event": "issue_comment" })).status, 401);
});
