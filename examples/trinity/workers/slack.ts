import type { KeyObject } from "node:crypto";
import { backoff, type FlowerClient, type Json } from "@flower-js/sdk";
import { runQueueWorker, type QueueWorkerEvent } from "@flower-js/sdk/worker";
import type app from "../app/index.ts";
import type { Attachment, Resolution } from "../app/model.ts";
import type { Marks, Outbound, OutboundJob, SlackInstall } from "../app/store.ts";
import type { BlobStore } from "./blobs.ts";
import { splitText } from "./delivery.ts";
import { deriveKey, signGrant, unseal } from "./secrets.ts";

// Slack over Socket Mode: one process holds the app's WebSocket connection, takes events and
// button presses from it, and posts what the outbound queue's "slack" scope asks for. Like
// Indent, it marks a message it is working on with 👀 and the answered one with ✅, answers only
// when mentioned (or in a direct message), turns prompts into buttons, and halts on 🛑.

type Client = FlowerClient<typeof app>;

export const WORKING = "eyes";
export const DONE = "white_check_mark";
export const STOP = "octagonal_sign";

// The Web API

/** Slack reports these with ok: false; the same request can succeed later. */
const RETRYABLE = new Set(["ratelimited", "rate_limited", "internal_error", "fatal_error", "service_unavailable", "request_timeout", "team_added_to_org"]);
/** Marks that are already where we want them. */
const SETTLED = new Set(["already_reacted", "no_reaction", "message_not_found"]);

export class SlackError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(method: string, code: string, retryable: boolean) {
    super(`Slack ${method} failed: ${code}`);
    this.name = "SlackError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface SlackCallOptions { signal?: AbortSignal; fetch?: typeof fetch; attempts?: number }

/** Call a Web API method with form-encoded arguments (objects as JSON), retrying rate limits and outages a few times. An empty token sends none (oauth.v2.access). */
export async function slackCall<T = Record<string, any>>(token: string, method: string, args: Record<string, unknown> = {}, options: SlackCallOptions = {}): Promise<T> {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(args)) {
    if (value !== undefined) body.set(name, typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  const attempts = options.attempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: { ...(token === "" ? {} : { authorization: `Bearer ${token}` }), "content-type": "application/x-www-form-urlencoded" },
        body,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted || attempt >= attempts) throw options.signal?.aborted ? error : new SlackError(method, "network_error", true);
      await sleep(backoff(attempt - 1), options.signal);
      continue;
    }
    const result = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    const code = response.status === 429 ? "ratelimited" : result?.ok === true ? null : result?.error ?? `http_${response.status}`;
    if (code === null) return result as T;
    const retryable = RETRYABLE.has(code) || response.status >= 500;
    if (!retryable || attempt >= attempts) throw new SlackError(method, code, retryable);
    const after = Number(response.headers.get("retry-after"));
    await sleep(Number.isFinite(after) && after > 0 ? Math.min(30_000, after * 1_000) : backoff(attempt - 1), options.signal);
  }
}

// Messages

export interface SlackMessage {
  channel: string;
  ts: string;
  thread: string;
  user: string;
  text: string;
  dm: boolean;
  mentioned: boolean;
  /** An edit that newly mentions the bot, which counts as a new message. */
  edited: boolean;
  files: Array<{ name?: string; mimetype?: string; size?: number; url_private_download?: string }>;
}

const mentionOf = (bot: string) => new RegExp(`<@${bot}(?:\\|[^>]*)?>`);

/**
 * A person's message in a channel, group or direct message, or null for everything the bot
 * ignores: its own posts, other bots, joins and other subtypes, and edits that do not newly
 * mention it. Slack escapes &, < and >; the text returned is unescaped, without the mention.
 */
export function parseMessage(event: Record<string, any>, botUser: string): SlackMessage | null {
  if (event.type !== "message") return null;
  let message = event;
  let edited = false;
  if (event.subtype === "message_changed") {
    message = event.message ?? {};
    const before = String(event.previous_message?.text ?? "");
    if (!mentionOf(botUser).test(String(message.text ?? "")) || mentionOf(botUser).test(before)) return null;
    edited = true;
  } else if (event.subtype !== undefined && event.subtype !== "file_share" && event.subtype !== "thread_broadcast") {
    return null;
  }
  const { user, ts } = message;
  if (message.bot_id || typeof user !== "string" || user === botUser || typeof ts !== "string" || typeof event.channel !== "string") return null;
  const raw = String(message.text ?? "");
  const text = raw
    .replace(new RegExp(`${mentionOf(botUser).source}[ \\t]*`, "g"), "")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")
    .trim();
  return {
    channel: event.channel,
    ts,
    thread: typeof message.thread_ts === "string" ? message.thread_ts : ts,
    user,
    text,
    dm: event.channel_type === "im",
    mentioned: mentionOf(botUser).test(raw),
    edited,
    files: Array.isArray(message.files) ? message.files : [],
  };
}

// What the bot posts

type Blocks = Json[];
interface Post { text: string; blocks: Blocks }

/** A markdown block holds up to 12,000 characters, so long answers span several messages. */
const MARKDOWN_LIMIT = 11_000;

const linkBlock = (link: string): Json => ({ type: "context", elements: [{ type: "mrkdwn", text: `<${link}|Open in Trinity>` }] });
const openButton = (link: string): Json => ({ type: "button", action_id: "trinity.open", text: { type: "plain_text", text: "Open in Trinity" }, url: link });
const plain = (text: string, limit = 3_000) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/** The turn's answer, rendered from its markdown, with a way to continue on the web under the last piece. */
export function replyPosts(text: string, error: boolean, link: string | null): Post[] {
  const body = error ? `⚠️ ${text}` : text;
  const pieces = splitText(body.trim() === "" ? "(no text)" : body, MARKDOWN_LIMIT);
  return pieces.map((piece, index) => ({
    text: plain(piece),
    blocks: [{ type: "markdown", text: piece }, ...(link !== null && index === pieces.length - 1 ? [linkBlock(link)] : [])],
  }));
}

/** A prompt as a card: buttons for an approval, a form for a question. */
export function promptCard(call: { id: string; approval: "permission" | "elicitation"; prompt: string }, session: string, link: string | null): Post {
  const value = (extra: Record<string, string> = {}) => JSON.stringify({ session, call: call.id, ...extra });
  const buttons: Json[] = call.approval === "permission"
    ? [
      { type: "button", action_id: "trinity.approve", style: "primary", text: { type: "plain_text", text: "Approve" }, value: value() },
      { type: "button", action_id: "trinity.deny", style: "danger", text: { type: "plain_text", text: "Deny" }, value: value() },
    ]
    : [{ type: "button", action_id: "trinity.answer", style: "primary", text: { type: "plain_text", text: "Answer" }, value: value({ question: plain(call.prompt, 1_500) }) }];
  const heading = call.approval === "permission" ? "**Approval needed**" : "**Question**";
  return {
    text: `${call.approval === "permission" ? "Approval needed" : "Question"}: ${plain(call.prompt, 2_000)}`,
    blocks: [
      { type: "markdown", text: `${heading}\n${plain(call.prompt, MARKDOWN_LIMIT)}` },
      { type: "actions", block_id: `trinity:${call.id}`, elements: [...buttons, ...(link === null ? [] : [openButton(link)])] },
    ],
  };
}

const OUTCOMES: Record<Resolution, string> = {
  approved: "✅ Approved", denied: "🚫 Denied", answered: "💬 Answered",
  preempted: "↪️ Superseded by a new message", cancelled: "⏹️ Cancelled", timed_out: "⌛ Timed out",
};

/** A card once its prompt is settled: what was asked, what happened, and who decided. */
export function resolvedCard(prompt: string, resolution: Resolution, by: string | null): Post {
  const outcome = `${OUTCOMES[resolution]}${by === null ? "" : ` by ${by}`}`;
  return {
    text: `${outcome}: ${plain(prompt, 2_000)}`,
    blocks: [{ type: "markdown", text: plain(prompt, MARKDOWN_LIMIT) }, { type: "context", elements: [{ type: "mrkdwn", text: outcome }] }],
  };
}

function connectPost(url: string | null): Post {
  const text = url === null
    ? "To work with me here, connect your Slack account to Trinity. (This deployment has no TRINITY_PUBLIC_URL to link to; ask an admin.)"
    : "To work with me here, connect your Slack account to Trinity, then mention me again.";
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      ...(url === null ? [] : [{ type: "actions", elements: [{ type: "button", action_id: "trinity.connect", style: "primary", text: { type: "plain_text", text: "Connect your account" }, url }] }]),
    ],
  };
}

function answerModal(question: string, metadata: Record<string, string>): Json {
  return {
    type: "modal",
    callback_id: "trinity.answer",
    private_metadata: JSON.stringify(metadata),
    title: { type: "plain_text", text: "Answer Trinity" },
    submit: { type: "plain_text", text: "Send" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: plain(question) } },
      { type: "input", block_id: "answer", label: { type: "plain_text", text: "Your answer" }, element: { type: "plain_text_input", action_id: "text", multiline: true } },
    ],
  };
}

function homeView(member: string | null, org: string | null, connect: string | null, web: string | null): Json {
  const account = member === null
    ? [connectPost(connect).blocks].flat()
    : [{ type: "context", elements: [{ type: "mrkdwn", text: `You work as *${member}* in *${org}*.` }] }];
  return {
    type: "home",
    blocks: [
      { type: "header", text: { type: "plain_text", text: "Trinity" } },
      { type: "section", text: { type: "mrkdwn", text: "Mention me in a channel or send me a direct message. Each thread is a session: continue it here or on the web. React with :octagonal_sign: to stop me." } },
      ...account,
      ...(web === null ? [] : [{ type: "actions", elements: [{ type: "button", action_id: "trinity.open", text: { type: "plain_text", text: "Open Trinity" }, url: web }] }]),
    ],
  };
}

// Socket Mode

/** The part of the WebSocket interface Socket Mode needs; tests pass a stand-in. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
}

export interface Envelope { envelope_id?: string; type: string; payload?: any; reason?: string }

export interface SocketModeOptions {
  readonly appToken: string;
  readonly signal: AbortSignal;
  /** Called after each envelope is acknowledged; errors are the handler's to catch. */
  readonly onEnvelope: (envelope: Envelope) => void;
  readonly connect?: (url: string) => SocketLike;
  readonly call?: typeof slackCall;
  readonly log?: (event: Record<string, Json>) => void;
}

/**
 * Hold a Socket Mode connection until the signal fires: open a URL with the app-level token,
 * acknowledge each envelope at once (Slack redelivers what is not acknowledged within three
 * seconds), and reconnect whenever Slack asks or the socket drops.
 */
export async function runSocketMode(options: SocketModeOptions): Promise<void> {
  const call = options.call ?? slackCall;
  const connect = options.connect ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const log = options.log ?? (() => {});
  for (let failures = 0; !options.signal.aborted;) {
    try {
      const { url } = await call<{ url: string }>(options.appToken, "apps.connections.open", {}, { signal: options.signal });
      if (await connection(connect(url))) failures = 0;
    } catch (error) {
      if (options.signal.aborted) return;
      log({ slack: "connect failed", error: error instanceof Error ? error.message : String(error) });
    }
    await sleep(backoff(failures++), options.signal).catch(() => {});
  }

  /** Resolves when the socket closes, with whether Slack said hello. */
  function connection(socket: SocketLike): Promise<boolean> {
    return new Promise((done) => {
      let greeted = false;
      const stop = () => socket.close();
      options.signal.addEventListener("abort", stop, { once: true });
      const finish = () => {
        options.signal.removeEventListener("abort", stop);
        done(greeted);
      };
      socket.addEventListener("close", finish);
      socket.addEventListener("error", () => socket.close());
      socket.addEventListener("message", ({ data }) => {
        let envelope: Envelope;
        try {
          envelope = JSON.parse(String(data)) as Envelope;
        } catch {
          return;
        }
        if (envelope.type === "hello") {
          greeted = true;
          log({ slack: "connected" });
        } else if (envelope.type === "disconnect") {
          log({ slack: "reconnecting", reason: envelope.reason ?? null });
          socket.close();
        } else if (envelope.envelope_id !== undefined) {
          socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
          options.onEnvelope(envelope);
        }
      });
    });
  }
}

// The worker

export interface SlackWorkerOptions {
  readonly signal: AbortSignal;
  /** The app-level token (xapp-…) with connections:write. */
  readonly appToken: string;
  /** The deployment's signing key: it unseals bot tokens and signs links to the web. */
  readonly signingKey: KeyObject;
  /** The web client's address, for links to sessions and account connection. */
  readonly publicUrl?: string;
  /** Where files people attach are stored. Without it, attachments are mentioned but not passed on. */
  readonly blobs?: BlobStore;
  readonly log?: (event: Record<string, Json>) => void;
  readonly connect?: (url: string) => SocketLike;
  readonly fetch?: typeof fetch;
}

interface Workspace { install: SlackInstall; token: string }

/** The worker's two halves: what arrives over the socket, and what the outbound queue asks to post. */
export interface SlackHandlers {
  handle(envelope: Envelope): Promise<void>;
  deliver(job: OutboundJob): Promise<Json>;
}

/**
 * Serve every connected workspace: `service` (a service-role client) receives messages and
 * decisions, `worker` (a worker-role client) reads installations and runs the outbound queue.
 */
export async function runSlack(clients: { service: Client; worker: Client }, options: SlackWorkerOptions): Promise<void> {
  const log = options.log ?? (() => {});
  const { handle, deliver } = slackHandlers(clients, options);
  await Promise.all([
    runSocketMode({
      appToken: options.appToken,
      signal: options.signal,
      log,
      ...(options.connect ? { connect: options.connect } : {}),
      ...(options.fetch ? { call: (token, method, args, callOptions) => slackCall(token, method, args, { ...callOptions, fetch: options.fetch! }) } : {}),
      onEnvelope: (envelope) => void handle(envelope).catch((error) => log({ slack: "event failed", type: envelope.type, error: String(error) })),
    }),
    runQueueWorker<OutboundJob, Json>(clients.worker, {
      queue: "outbound", scope: "slack", signal: options.signal, lanes: 8, leaseMs: 60_000,
      onEvent: (event: QueueWorkerEvent) => { if (event.type !== "claimed") log({ slack: "outbound", event: event.type }); },
      work: (job) => deliver(job.payload),
    }),
  ]);
}

export function slackHandlers(clients: { service: Client; worker: Client }, options: Omit<SlackWorkerOptions, "appToken" | "connect">): SlackHandlers {
  const { service, worker } = clients;
  const log = options.log ?? (() => {});
  const tokenKey = deriveKey(options.signingKey, "slack-tokens");
  const grantKey = deriveKey(options.signingKey, "grants");
  const web = options.publicUrl?.replace(/\/$/, "") ?? null;
  const api = <T = Record<string, any>>(token: string, method: string, args: Record<string, unknown>) =>
    slackCall<T>(token, method, args, { signal: options.signal, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const sessionLink = (session: string) => (web === null ? null : `${web}/#/sessions/${encodeURIComponent(session)}`);

  // Installations change rarely; refresh them now and then, and at once for a workspace not seen yet.
  let workspaces = new Map<string, Workspace>();
  let loadedAt = 0;
  async function workspace(team: string): Promise<Workspace | null> {
    if (!workspaces.has(team) && Date.now() - loadedAt > 5_000 || Date.now() - loadedAt > 60_000) {
      const { value } = await worker.query("slack.installations", null, { retry: true });
      workspaces = new Map(value.map((install) => [install.team, { install, token: unseal(tokenKey, install.token) }]));
      loadedAt = Date.now();
    }
    return workspaces.get(team) ?? null;
  }

  const labels = new Map<string, string>();
  async function label({ token }: Workspace, message: SlackMessage): Promise<string> {
    if (message.dm) return "a direct message";
    const known = labels.get(message.channel);
    if (known !== undefined) return known;
    const found = await api<{ channel: { name?: string; is_mpim?: boolean } }>(token, "conversations.info", { channel: message.channel })
      .then(({ channel }) => channel.is_mpim ? "a group message" : `#${channel.name}`, () => "a Slack channel");
    labels.set(message.channel, found);
    return found;
  }

  const react = (token: string, add: boolean, name: string, channel: string, timestamp: string) =>
    api(token, add ? "reactions.add" : "reactions.remove", { name, channel, timestamp }).catch((error) => {
      if (!(error instanceof SlackError && SETTLED.has(error.code))) log({ slack: "reaction failed", error: String(error) });
    });

  function connectLink(install: SlackInstall, user: string): string | null {
    return web === null ? null : `${web}/#/connect/slack?grant=${encodeURIComponent(signGrant(grantKey, { team: install.team, user, org: install.org }, 3_600))}`;
  }

  /** Tell one person something only they need to see: ephemeral in channels, a plain reply in their direct messages. */
  async function whisper({ token }: Workspace, target: { channel: string; user: string; thread: string; dm: boolean }, post: Post): Promise<void> {
    const common = { channel: target.channel, thread_ts: target.thread, text: post.text, blocks: post.blocks };
    await (target.dm ? api(token, "chat.postMessage", common) : api(token, "chat.postEphemeral", { ...common, user: target.user }));
  }

  async function attachments(space: Workspace, message: SlackMessage): Promise<{ attachments: Attachment[]; notes: string[] }> {
    const stored: Attachment[] = [];
    const notes: string[] = [];
    for (const file of message.files.slice(0, 20)) {
      const name = file.name ?? "attachment";
      if (options.blobs === undefined || file.url_private_download === undefined || (file.size ?? 0) > 20 * 1024 * 1024) {
        notes.push(`(Attached ${name}, which could not be passed on.)`);
        continue;
      }
      const response = await (options.fetch ?? fetch)(file.url_private_download, { headers: { authorization: `Bearer ${space.token}` }, signal: options.signal });
      if (!response.ok) {
        notes.push(`(Attached ${name}, which could not be downloaded.)`);
        continue;
      }
      const body = new Uint8Array(await response.arrayBuffer());
      const mediaType = file.mimetype ?? "application/octet-stream";
      stored.push({ blob: await options.blobs.put(body, mediaType), name: name.slice(0, 512), mediaType, size: body.length });
    }
    return { attachments: stored, notes };
  }

  async function onMessage(team: string, event: Record<string, any>): Promise<void> {
    const space = await workspace(team);
    if (space === null) return;
    const message = parseMessage(event, space.install.botUser);
    // Only threads can be bound, so top-level chatter never needs the database.
    if (message === null || (!message.dm && !message.mentioned && message.thread === message.ts)) return;
    const addressed = message.dm || message.mentioned;
    if (addressed) await react(space.token, true, WORKING, message.channel, message.ts);
    const files = addressed ? await attachments(space, message) : { attachments: [], notes: [] };
    const text = [message.text, ...files.notes].filter((part) => part !== "").join("\n\n") || "(empty message)";
    const { value } = await service.mutate("slack.receive", {
      team, channel: message.channel, thread: message.thread, ts: message.ts, user: message.user, text,
      dm: message.dm, mentioned: message.mentioned, label: await label(space, message), attachments: files.attachments,
    }, { requestId: `slack:${team}:${message.channel}:${message.ts}${message.edited ? ":edit" : ""}`, retry: true });
    if (value.outcome === "received") return;
    if (addressed) await react(space.token, false, WORKING, message.channel, message.ts);
    const target = { channel: message.channel, user: message.user, thread: message.thread, dm: message.dm };
    if (value.outcome === "link") await whisper(space, target, connectPost(connectLink(space.install, message.user)));
    if (value.outcome === "nudge") {
      const text = `If that was for me, mention <@${space.install.botUser}> and I'll pick it up.`;
      await whisper(space, target, { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
    }
    if (value.outcome === "private") {
      const text = "This thread's session is private to the person who started it.";
      await whisper(space, target, { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
    }
  }

  async function decide(team: string, user: string, where: { channel: string; thread: string }, choice: { session: string; call: string; approve?: boolean; answer?: string }) {
    const space = await workspace(team);
    if (space === null) return;
    const { value } = await service.mutate("slack.resolve", { team, user, ...choice }, { retry: true });
    const target = { ...where, user, dm: where.channel.startsWith("D") };
    const say = (text: string) => whisper(space, target, { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
    if (value.outcome === "link") await whisper(space, target, connectPost(connectLink(space.install, user)));
    if (value.outcome === "stale") await say("That was already settled.");
    if (value.outcome === "forbidden") await say("You cannot answer prompts in this session.");
  }

  async function onAction(payload: Record<string, any>): Promise<void> {
    const team = payload.team?.id ?? payload.user?.team_id;
    const user = payload.user?.id;
    const action = payload.actions?.[0];
    if (typeof team !== "string" || typeof user !== "string" || action === undefined) return;
    const where = { channel: String(payload.channel?.id ?? payload.container?.channel_id), thread: String(payload.message?.thread_ts ?? payload.message?.ts) };
    if (action.action_id === "trinity.approve" || action.action_id === "trinity.deny") {
      const { session, call } = JSON.parse(action.value);
      return decide(team, user, where, { session, call, approve: action.action_id === "trinity.approve" });
    }
    if (action.action_id === "trinity.answer") {
      const { session, call, question } = JSON.parse(action.value);
      const space = await workspace(team);
      if (space !== null) await api(space.token, "views.open", { trigger_id: payload.trigger_id, view: answerModal(question, { session, call, ...where }) });
    }
  }

  async function onSubmission(payload: Record<string, any>): Promise<void> {
    if (payload.view?.callback_id !== "trinity.answer") return;
    const { session, call, channel, thread } = JSON.parse(payload.view.private_metadata);
    const answer = String(payload.view.state?.values?.answer?.text?.value ?? "").trim();
    if (answer !== "") await decide(payload.team?.id ?? payload.user?.team_id, payload.user.id, { channel, thread }, { session, call, answer });
  }

  async function onHome(team: string, user: string): Promise<void> {
    const space = await workspace(team);
    if (space === null) return;
    const { value } = await service.query("slack.whois", { team, user }, { retry: true });
    await api(space.token, "views.publish", { user_id: user, view: homeView(value?.member ?? null, value?.org ?? null, connectLink(space.install, user), web) });
  }

  async function handle(envelope: Envelope): Promise<void> {
    const payload = envelope.payload ?? {};
    if (envelope.type === "events_api") {
      const event = payload.event ?? {};
      const team = payload.team_id ?? event.team;
      if (event.type === "message") return onMessage(team, event);
      if (event.type === "reaction_added" && event.reaction === STOP && event.item?.type === "message") {
        await service.mutate("slack.halt", { team, channel: event.item.channel, ts: event.item.ts, user: event.user }, { retry: true });
        return;
      }
      if (event.type === "app_home_opened" && event.tab === "home") return onHome(team, event.user);
    }
    if (envelope.type === "interactive") {
      if (payload.type === "block_actions") return onAction(payload);
      if (payload.type === "view_submission") return onSubmission(payload);
    }
  }

  /** Post what a thread should show, then move the marks on the messages it answers. */
  async function deliver(job: OutboundJob): Promise<Json> {
    const meta = job.meta as { team: string; channel: string; thread: string };
    const space = await workspace(meta.team);
    if (space === null) return { skipped: "workspace disconnected" };
    const link = sessionLink(job.session);
    const posted = async (post: Post, call?: string) => {
      const { ts } = await api<{ ts: string }>(space.token, "chat.postMessage", {
        channel: meta.channel, thread_ts: meta.thread, text: post.text, blocks: post.blocks, unfurl_links: false, unfurl_media: false,
      });
      await worker.mutate("slack.posted", { ...meta, ts, session: job.session, ...(call === undefined ? {} : { call }) }, { retry: true });
    };
    try {
      await render(job.message, posted, space.token, meta.channel, link, job.session);
      if (job.marks !== null) await mark(space.token, meta.channel, job.marks);
      return null;
    } catch (error) {
      // Channels the bot left, deleted messages: retrying cannot help.
      if (error instanceof SlackError && !error.retryable) return { failed: error.code };
      throw error;
    }
  }

  async function render(message: Outbound, posted: (post: Post, call?: string) => Promise<void>, token: string, channel: string, link: string | null, session: string) {
    switch (message.kind) {
      case "reply":
        for (const post of replyPosts(message.text, message.error, link)) await posted(post);
        return;
      case "ask":
        for (const call of message.calls) await posted(promptCard(call, session, link), call.id);
        return;
      case "resolved": {
        const card = resolvedCard(message.prompt, message.resolution, message.by);
        await api(token, "chat.update", { channel, ts: message.card, text: card.text, blocks: card.blocks });
        return;
      }
      case "ended":
        return;
    }
  }

  async function mark(token: string, channel: string, marks: Marks) {
    for (const ts of marks.pending) await react(token, false, WORKING, channel, ts);
    if (marks.previous !== null && marks.previous !== marks.done) await react(token, false, DONE, channel, marks.previous);
    if (marks.done !== null) await react(token, true, DONE, channel, marks.done);
  }

  return { handle, deliver };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); done(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
