import { createPublicKey, type KeyObject } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { FlowerClient, FlowerError } from "@flower-js/sdk";
import type app from "../app/index.ts";
import { bearer, signToken, verifyToken, type TokenClaims } from "../workers/auth.ts";
import { isBlobKey, type BlobStore } from "../workers/blobs.ts";
import { parseGithubEvent, verifyGithubSignature } from "../workers/github.ts";
import { deriveKey, seal, signGrant, verifyGrant } from "../workers/secrets.ts";
import { slackCall } from "../workers/slack.ts";
import { BOT_SCOPES } from "../workers/slack-setup.ts";

export interface GatewayOptions {
  readonly flowerUrl: string;
  readonly signingKey: KeyObject;
  readonly blobs?: BlobStore;
  /** Static files of the web client. */
  readonly webRoot?: string;
  /** Flower's compiled SDK, served to browsers at /sdk/. */
  readonly sdkRoot?: string;
  /** Anyone can sign in as anyone: for local development only. */
  readonly devLogin?: boolean;
  /** The Slack app's OAuth credentials, for installing it from the web; needs an https publicUrl. */
  readonly slack?: { clientId: string; clientSecret: string };
  /** Where browsers reach this gateway, for OAuth redirects. */
  readonly publicUrl?: string;
  /** Stands in for Slack's Web API in tests. */
  readonly slackFetch?: typeof fetch;
  /** GitHub "owner/repo" or "owner" to organization. */
  readonly github?: { secret: string; botLogin: string; owners: Record<string, string> };
  /** Organizations that live in named Flower partitions. Their tokens carry the partition as their tenant. */
  readonly cells?: Record<string, string>;
  readonly userTokenSeconds?: number;
}

type Client = FlowerClient<typeof app>;
type Claims = TokenClaims & { exp: number };
type Handler = (request: IncomingMessage, response: ServerResponse, url: URL, match: RegExpExecArray) => Promise<void>;

const MAX_BODY = 32 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readBody(request: IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = (await readBody(request, 16_384)).toString();
  return text === "" ? {} : JSON.parse(text);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

/** A path under root, or null when it would escape it. */
function inside(root: string, path: string): string | null {
  const base = resolve(root);
  const target = resolve(base, `.${normalize(`/${decodeURIComponent(path)}`)}`);
  return target === base || target.startsWith(`${base}/`) ? target : null;
}

async function serveFile(response: ServerResponse, root: string | undefined, path: string): Promise<void> {
  let file = root === undefined ? null : inside(root, path);
  if (file === null) throw new HttpError(404, "Not found");
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const data = await readFile(file);
    response.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    response.end(data);
  } catch {
    throw new HttpError(404, "Not found");
  }
}

export function createGateway(options: GatewayOptions): Server {
  const publicKey = createPublicKey(options.signingKey);
  const userTokenSeconds = options.userTokenSeconds ?? 12 * 3_600;

  // Tokens and clients

  const cellOf = (org: string | undefined) => (org === undefined ? undefined : options.cells?.[org]);
  const mint = (claims: TokenClaims, seconds: number) => signToken(options.signingKey, claims, seconds);
  const issue = (claims: TokenClaims, seconds = userTokenSeconds) => ({ token: mint(claims, seconds), expiresAt: Date.now() + seconds * 1_000, claims });

  const clientFor = (credentials: () => { token: string }, org: string | undefined): Client => {
    const client = new FlowerClient<typeof app>(options.flowerUrl, { credentials });
    const cell = cellOf(org);
    return cell === undefined ? client : client.partition(cell);
  };
  const asUser = (token: string, org?: string) => clientFor(() => ({ token }), org);
  const asService = (org: string) => {
    const tenant = cellOf(org);
    return clientFor(() => ({ token: mint({ sub: "gateway", role: "service", ...(tenant ? { tenant } : {}) }, 600) }), org);
  };

  const tokenOf = (request: IncomingMessage, url: URL) => bearer(request.headers.authorization) ?? url.searchParams.get("token");
  const signedIn = (request: IncomingMessage, url: URL): { token: string; claims: Claims } => {
    const token = tokenOf(request, url);
    const claims = token === null ? null : verifyToken(publicKey, token);
    if (token === null || claims === null) throw new HttpError(401, "A valid token is required");
    return { token, claims };
  };

  // Handlers

  /** Flower's public API, passed through with its streaming responses. */
  const proxy: Handler = async (request, response, url) => {
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "accept", "last-event-id"]) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const upstream = await fetch(new URL(url.pathname + url.search, options.flowerUrl), {
      method: request.method!,
      headers,
      ...(hasBody ? { body: new Uint8Array(await readBody(request)) } : {}),
    });
    const passed: Record<string, string> = {};
    for (const name of ["content-type", "cache-control"]) {
      const value = upstream.headers.get(name);
      if (value !== null) passed[name] = value;
    }
    response.writeHead(upstream.status, passed);
    if (upstream.body === null) return void response.end();
    const stream = Readable.fromWeb(upstream.body as ReadableStream);
    request.on("close", () => stream.destroy());
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  };

  const devSignIn: Handler = async (request, response) => {
    if (!options.devLogin) throw new HttpError(404, "Not found");
    const { subject, org, name } = await readJson(request);
    if (typeof subject !== "string" || !/^[\w.@+-]{1,128}$/.test(subject)) throw new HttpError(400, "subject is required");
    sendJson(response, 200, issue({
      sub: subject,
      role: "user",
      ...(typeof org === "string" ? { org } : {}),
      ...(typeof name === "string" ? { name } : {}),
    }));
  };

  const switchOrg: Handler = async (request, response, url) => {
    const { token, claims } = signedIn(request, url);
    if (claims.role !== "user") throw new HttpError(403, "Only users switch organizations");
    const { org } = await readJson(request);
    if (typeof org !== "string") throw new HttpError(400, "org is required");
    const tenant = cellOf(org);
    // A partition admits only its own tenant, so membership there is checked with a token for it.
    const probe = tenant === undefined ? token : mint({ sub: claims.sub, role: "user", tenant }, 60);
    const { value: mine } = await asUser(probe, org).query("org.mine");
    if (!mine.some((each) => each.id === org)) throw new HttpError(403, "Not a member of that organization");
    sendJson(response, 200, issue({ sub: claims.sub, role: "user", org, ...(tenant ? { tenant } : {}), ...(claims.name ? { name: claims.name } : {}) }));
  };

  const computerToken: Handler = async (request, response, url) => {
    const { token, claims } = signedIn(request, url);
    if (claims.role !== "user" || claims.org === undefined) throw new HttpError(403, "Sign in to an organization first");
    const { computer } = await readJson(request);
    const { value: computers } = await asUser(token, claims.org).query("computer.list");
    const found = computers.find((each) => each.id === computer);
    if (found === undefined || found.owner !== claims.sub || found.kind !== "local") throw new HttpError(403, "Register this computer first");
    const tenant = cellOf(claims.org);
    sendJson(response, 200, issue({ sub: `computer:${found.id}`, role: "computer", computer: found.id, org: claims.org, ...(tenant ? { tenant } : {}) }, 30 * 86_400));
  };

  const upload: Handler = async (request, response, url) => {
    const { claims } = signedIn(request, url);
    if (claims.role !== "user") throw new HttpError(403, "Only users upload");
    if (options.blobs === undefined) throw new HttpError(503, "Uploads need blob storage (TRINITY_BLOBS)");
    const data = await readBody(request, 20 * 1024 * 1024);
    const mediaType = (request.headers["content-type"] ?? "application/octet-stream").split(";")[0]!.trim();
    const blob = await options.blobs.put(data, mediaType);
    sendJson(response, 200, { blob, name: (url.searchParams.get("name") ?? "attachment").slice(0, 512), mediaType, size: data.length });
  };

  /** A blob, for callers allowed to read the session that refers to it. */
  const download: Handler = async (request, response, url, match) => {
    const { token, claims } = signedIn(request, url);
    const session = decodeURIComponent(match[1]!);
    const key = match[2]!;
    if (options.blobs === undefined || !isBlobKey(key)) throw new HttpError(404, "Not found");
    const { value: allowed } = await asUser(token, claims.org).query("session.blob", { session, key });
    if (!allowed) throw new HttpError(404, "Not found");
    const signed = await options.blobs.url(key, 300);
    if (signed !== null) {
      response.writeHead(302, { location: signed });
      return void response.end();
    }
    const found = await options.blobs.get(key);
    if (found === null) throw new HttpError(404, "Not found");
    response.writeHead(200, { "content-type": found.contentType, "cache-control": "private, max-age=31536000, immutable" });
    response.end(found.body);
  };

  /** Hand a verified surface message to its organization's session. */
  async function deliverSurface(response: ServerResponse, org: string | undefined, message: { surface: string; thread: string; message: string; author: string; text: string; meta: Record<string, unknown> }) {
    if (org === undefined) return sendJson(response, 202, { ignored: "no organization for this workspace" });
    await asService(org).mutate("surface.receive", { org, ...message, meta: message.meta as never }, {
      requestId: `${message.surface}:${message.message}`,
      retry: { attempts: 3, timeoutMs: 2_000 },
    });
    sendJson(response, 200, { ok: true });
  }

  // Slack: connecting workspaces and people. The Slack worker holds the connection itself.

  const tokenKey = deriveKey(options.signingKey, "slack-tokens");
  const grantKey = deriveKey(options.signingKey, "grants");
  const slackApi = (token: string, method: string, args: Record<string, unknown> = {}) =>
    slackCall(token, method, args, options.slackFetch ? { fetch: options.slackFetch } : {});
  const inOrg = (claims: Claims) => {
    if (claims.role !== "user" || claims.org === undefined) throw new HttpError(403, "Sign in to an organization first");
    return claims.org;
  };
  const slackOAuth = () => {
    const base = options.publicUrl?.replace(/\/$/, "");
    if (options.slack === undefined || !base?.startsWith("https://")) {
      throw new HttpError(404, "Installing from the web needs SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and an https TRINITY_PUBLIC_URL; use `trinity slack setup` instead");
    }
    return { ...options.slack, base, redirect: `${base}/slack/oauth` };
  };

  /** Keep a workspace's bot token for an organization, sealed so that only workers can use it. */
  async function connectWorkspace(botToken: string, org: string, installedBy: string) {
    const bot = await slackApi(botToken, "auth.test");
    if (typeof bot.bot_id !== "string") throw new HttpError(400, "That is not a bot token (xoxb-…)");
    const { value } = await asService(org).mutate("slack.install", {
      org, team: bot.team_id, name: bot.team, url: bot.url, botUser: bot.user_id, botId: bot.bot_id, token: seal(tokenKey, botToken), installedBy,
    });
    return value;
  }

  /** `trinity slack setup` hands over the bot token of a workspace installed from Slack's app settings. */
  const slackConnect: Handler = async (request, response, url) => {
    const { claims } = signedIn(request, url);
    const org = inOrg(claims);
    const { token } = await readJson(request);
    if (typeof token !== "string" || !token.startsWith("xoxb-")) throw new HttpError(400, "token must be a bot token (xoxb-…)");
    sendJson(response, 200, await connectWorkspace(token, org, claims.sub));
  };

  /** A person followed the Slack worker's "Connect your account" link while signed in here. */
  const slackLink: Handler = async (request, response, url) => {
    const { claims } = signedIn(request, url);
    const org = inOrg(claims);
    const { grant } = await readJson(request);
    const linking = typeof grant === "string" ? verifyGrant(grantKey, grant) : null;
    if (linking?.team === undefined || linking.user === undefined) throw new HttpError(400, "This link expired: mention Trinity in Slack again for a new one");
    if (linking.org !== org) throw new HttpError(409, `This Slack workspace belongs to organization ${linking.org}; switch to it first`);
    const { value } = await asService(org).mutate("slack.link", { team: linking.team, user: linking.user, org, subject: claims.sub });
    sendJson(response, 200, value);
  };

  /** Where an admin installs the app with Slack's OAuth; Slack sends them back to /slack/oauth. */
  const slackInstall: Handler = async (request, response, url) => {
    const oauth = slackOAuth();
    const { claims } = signedIn(request, url);
    const state = signGrant(grantKey, { purpose: "slack-install", org: inOrg(claims), sub: claims.sub }, 600);
    const authorize = new URL("https://slack.com/oauth/v2/authorize");
    authorize.search = new URLSearchParams({ client_id: oauth.clientId, scope: BOT_SCOPES.join(","), redirect_uri: oauth.redirect, state }).toString();
    sendJson(response, 200, { url: authorize.toString() });
  };

  const slackCallback: Handler = async (_request, response, url) => {
    const oauth = slackOAuth();
    const state = verifyGrant(grantKey, url.searchParams.get("state") ?? "");
    const code = url.searchParams.get("code");
    if (state?.purpose !== "slack-install" || state.org === undefined || state.sub === undefined) throw new HttpError(400, "This install link expired; start again");
    if (code === null) throw new HttpError(400, `Slack did not install the app: ${url.searchParams.get("error") ?? "no code"}`);
    const access = await slackApi("", "oauth.v2.access", { client_id: oauth.clientId, client_secret: oauth.clientSecret, code, redirect_uri: oauth.redirect });
    await connectWorkspace(access.access_token, state.org, state.sub);
    response.writeHead(302, { location: `${oauth.base}/#/settings` });
    response.end();
  };

  const githubEvent: Handler = async (request, response) => {
    const github = options.github;
    if (github === undefined) throw new HttpError(404, "Not found");
    const raw = (await readBody(request, 5 * 1024 * 1024)).toString();
    const signature = request.headers["x-hub-signature-256"];
    if (!verifyGithubSignature(github.secret, raw, typeof signature === "string" ? signature : undefined)) throw new HttpError(401, "Bad signature");
    const inbound = parseGithubEvent(String(request.headers["x-github-event"] ?? ""), JSON.parse(raw), github.botLogin);
    if (inbound === null) return sendJson(response, 200, { ok: true });
    const owner = inbound.repo.split("/")[0]!;
    await deliverSurface(response, github.owners[inbound.repo] ?? github.owners[owner], {
      surface: "github", thread: inbound.thread, message: inbound.messageId, author: inbound.user, text: inbound.text,
      meta: { repo: inbound.repo, number: inbound.number, url: inbound.url },
    });
  };

  const health: Handler = async (_request, response) => sendJson(response, 200, { ok: true });
  const sdk: Handler = (_request, response, url) => serveFile(response, options.sdkRoot, url.pathname.slice("/sdk/".length));
  const web: Handler = (_request, response, url) => serveFile(response, options.webRoot, url.pathname === "/" ? "index.html" : url.pathname);

  // Operator routes (/raft, /admin) are deliberately absent: only /v1 reaches Flower.
  const routes: Array<[method: string, path: RegExp, handler: Handler]> = [
    ["*", /^\/(?:partitions\/[^/]+\/)?v1\//, proxy],
    ["GET", /^\/healthz$/, health],
    ["POST", /^\/auth\/dev$/, devSignIn],
    ["POST", /^\/auth\/switch$/, switchOrg],
    ["POST", /^\/auth\/computer$/, computerToken],
    ["POST", /^\/uploads$/, upload],
    ["GET", /^\/blobs\/([^/]+)\/(sha256\/[0-9a-f]{64})$/, download],
    ["POST", /^\/slack\/connect$/, slackConnect],
    ["POST", /^\/slack\/link$/, slackLink],
    ["POST", /^\/slack\/install$/, slackInstall],
    ["GET", /^\/slack\/oauth$/, slackCallback],
    ["POST", /^\/webhooks\/github$/, githubEvent],
    ["GET", /^\/sdk\//, sdk],
    ["GET", /^\//, web],
  ];

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://gateway");
    for (const [method, path, handler] of routes) {
      if (method !== "*" && method !== request.method) continue;
      const match = path.exec(url.pathname);
      if (match !== null) return handler(request, response, url, match);
    }
    throw new HttpError(404, "Not found");
  }

  return createServer((request, response) => {
    route(request, response).catch((error) => {
      if (response.headersSent) return void response.destroy();
      if (error instanceof HttpError) return sendJson(response, error.status, { error: error.message });
      if (error instanceof FlowerError) return sendJson(response, error.status === 403 ? 403 : 502, { error: error.message, code: error.failure?.code ?? error.code });
      if (error instanceof SyntaxError) return sendJson(response, 400, { error: "Invalid JSON" });
      sendJson(response, 500, { error: "Internal error" });
    });
  });
}
