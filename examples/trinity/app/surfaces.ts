import { mutation, v } from "@flower-js/sdk";
import { serviceAccess } from "./access.ts";
import { receive, type TurnOutcome } from "./loop.ts";
import { attachmentSchema, checksum, id, type Attachment, type Call, type Session, type Source } from "./model.ts";
import { bindings, orgs, outbound, type Binding, type Marks, type Outbound, type ThreadEntry } from "./store.ts";
import { newSession, Tx } from "./tx.ts";

// Surfaces are conversations that live elsewhere: a Slack thread, a GitHub issue. Each
// thread is bound to one session, which people can also continue on the web. A thread
// hears back about the turns its own messages started or joined: its messages are pending
// until the turn ends, then the answer (or the error) goes to the surface's delivery queue
// with the marks to move. Turns started on the web answer on the web.
//
// The session sees the whole thread. What people say there without addressing the agent
// (and their edits and deletions) is held until someone addresses it, and arrives with that
// message; while a turn answers in the thread, it joins that turn at its next step instead.
// Whatever the thread says before the session takes it in joins one queued message, so a
// burst of messages adds one message to the log.

export interface ThreadMessage {
  org: string;
  surface: string;
  thread: string;
  /** How the delivery worker reaches the thread. */
  meta: unknown;
  /** The surface's ID for the message, which its marks refer to. */
  message: string;
  /** Who sent it: a member's subject, or a surface account nobody linked. */
  author: string;
  /** Who sent it, as people in the thread know them; the author when absent. */
  name?: string;
  text: string;
  attachments: Attachment[];
  /** Whom a new session belongs to. */
  createdBy: string;
  private?: boolean;
  url?: string;
  label?: string;
  /** What the thread said before this message, for a session that has not heard from it yet. */
  history?: ThreadEntry[];
}

type Said = Extract<ThreadEntry, { kind: "message" | "edited" | "deleted" }>;

/** How many entries a thread holds; older ones give way to a count. */
const HELD_LIMIT = 50;
/** How much of something said without addressing the agent the session reads. */
const SAID_LIMIT = 4_000;
const EMPTY = "(empty message)";

/** Deliver a thread's message to its session, starting one on the thread's first message. Later messages steer. */
export function receiveOnThread(tx: Tx, message: ThreadMessage): Session {
  const { ctx } = tx;
  const binding = ctx.get(bindings, [message.surface, message.thread]);
  let session = binding === null ? null : tx.find(binding.session);
  if (session === null) {
    const sessionId = `${message.surface}-${checksum(`${message.org}\u0000${message.thread}`)}`;
    const source: Source = { surface: message.surface, thread: message.thread };
    if (message.url !== undefined) source.url = message.url;
    if (message.label !== undefined) source.label = message.label;
    session = tx.find(sessionId) ?? newSession(tx, {
      id: sessionId,
      org: message.org,
      createdBy: message.createdBy,
      source,
      private: message.private ?? false,
      computer: ctx.get(orgs, message.org)?.settings.computer ?? null,
    });
  }
  const said: Said = { kind: "message", message: message.message, name: message.name ?? message.author, text: message.text, author: message.author };
  // A held message that an edit now addresses to the agent arrives once.
  const earlier = binding === null ? message.history ?? [] : (binding.held ?? []).filter((entry) => entry.kind === "omitted" || entry.message !== message.message);
  deliver(tx, session, {
    ...binding,
    surface: message.surface,
    thread: message.thread,
    org: message.org,
    session: session.id,
    meta: message.meta as never,
    pending: [...binding?.pending ?? [], message.message],
    held: [],
  }, {
    id: `${message.surface}:${message.message}`,
    entries: [...earlier, said],
    attachments: message.attachments,
    heading: binding === null ? "Earlier in this thread:" : "New in this thread:",
    aside: false,
  });
  return session;
}

/**
 * Something said in a bound thread without addressing the agent: a message, an edit or a
 * deletion, under a key unique to it. A turn that answers in the thread takes it in at its
 * next step, without preempting prompts; otherwise the thread holds it for the next message
 * that addresses the agent.
 */
export function noteOnThread(tx: Tx, binding: Binding, key: string, said: Said): "joined" | "held" {
  const session = tx.find(binding.session);
  const pending = binding.pending ?? [];
  if (session !== null && session.turn !== null && session.turn.halting === null && pending.length > 0) {
    deliver(tx, session, { ...binding, pending: said.kind === "message" ? [...pending, said.message] : pending, held: [] }, {
      id: `${binding.surface}:${key}`,
      entries: [...binding.held ?? [], said],
      attachments: [],
      heading: "New in this thread:",
      aside: true,
    });
    return "joined";
  }
  save(tx, { ...binding, held: hold(binding.held ?? [], said) });
  return "held";
}

interface Delivery {
  id: string;
  entries: ThreadEntry[];
  attachments: Attachment[];
  /** What introduces entries nobody addressed to the agent at the start of a message. */
  heading: string;
  aside: boolean;
}

/** Give the session what the thread said, joining the thread's queued message if the session has not taken it in yet. */
function deliver(tx: Tx, session: Session, binding: Binding, delivery: Delivery): void {
  const last = session.queued.at(-1);
  const joined = last !== undefined && last.id === binding.batch ? last : null;
  // The message belongs to whoever first addressed the agent in it; the others are named.
  const lead = joined?.author ?? delivery.entries.flatMap((entry) => (entry.kind !== "omitted" && entry.author !== undefined ? [entry.author] : []))[0] ?? null;
  const text = transcript(delivery.entries, lead, joined === null ? delivery.heading : null);
  const before = joined === null || joined.text === EMPTY ? [] : [joined.text];
  const id = joined?.id ?? delivery.id;
  save(tx, { ...binding, batch: id });
  receive(tx, session, {
    id,
    text: [...before, text].filter((part) => part !== "").join("\n\n") || EMPTY,
    steer: true,
    ...((joined?.aside ?? true) && delivery.aside ? { aside: true } : {}),
    at: joined?.at ?? tx.ctx.now(),
    attachments: [...joined?.attachments ?? [], ...delivery.attachments],
    author: lead,
    result: null,
  });
}

/** The thread's entries as the session reads them: the lead author's messages as written, everything else quoted under its author's name. */
function transcript(entries: ThreadEntry[], lead: string | null, heading: string | null): string {
  const parts: string[] = [];
  let quoted: string[] = [];
  const close = () => {
    if (quoted.length === 0) return;
    if (parts.length === 0 && heading !== null) parts.push(heading);
    parts.push(quoted.map((line) => line.split("\n").map((row) => (row === "" ? ">" : `> ${row}`)).join("\n")).join("\n>\n"));
    quoted = [];
  };
  for (const entry of entries) {
    if (entry.kind === "omitted") {
      quoted.push(`(${entry.count} ${entry.count === 1 ? "message" : "messages"} not shown)`);
    } else if (entry.author === undefined) {
      quoted.push(entry.kind === "message" ? `**${entry.name}:** ${clip(entry.text, SAID_LIMIT)}`
        : entry.kind === "edited" ? `**${entry.name}** edited a message: ${clip(entry.text, SAID_LIMIT)}`
        : `A message from **${entry.name}** was deleted: ${clip(entry.text, 300)}`);
    } else {
      close();
      if (entry.author !== lead) parts.push(`**${entry.name}:** ${entry.text || EMPTY}`);
      else if (entry.text !== "") parts.push(entry.text);
    }
  }
  close();
  return parts.join("\n\n");
}

/** Add to what a thread holds. An edit or deletion of a held message changes it in place; the oldest entries give way to a count. */
function hold(held: ThreadEntry[], said: Said): ThreadEntry[] {
  const same = (entry: ThreadEntry) => entry.kind !== "omitted" && entry.message === said.message;
  const entry = { ...said, text: clip(said.text, SAID_LIMIT) };
  const next = said.kind === "deleted" ? [...held.filter((each) => !same(each)), ...(held.some((each) => same(each) && each.kind === "message") ? [] : [entry])]
    : said.kind === "edited" && held.some(same) ? held.map((each) => (same(each) ? { ...each, text: entry.text } : each))
    : [...held, entry];
  const omitted = next[0]?.kind === "omitted" ? next[0].count : 0;
  const kept = next.filter((each) => each.kind !== "omitted");
  const dropped = Math.max(0, kept.length - HELD_LIMIT);
  return [...(omitted + dropped > 0 ? [{ kind: "omitted" as const, count: omitted + dropped }] : []), ...kept.slice(dropped)];
}

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/**
 * A message from a GitHub issue or pull request, from the gateway's verified webhook with the
 * delivery ID as the request ID. Slack has its own entry point (`slack.receive`), which knows
 * who its people are.
 */
export const receiveSurface = mutation("surface.receive", {
  args: v.object({
    org: id,
    surface: v.string({ min: 1, max: 40, pattern: /^[a-z0-9-]+$/ }),
    thread: v.string({ min: 1, max: 512 }),
    message: v.string({ min: 1, max: 256 }),
    author: v.string({ min: 1, max: 256 }),
    text: v.string({ min: 1, max: 1_000_000 }),
    meta: v.json(),
    url: v.optional(v.string({ max: 2_048 })),
    attachments: v.optional(v.array(attachmentSchema, { max: 20 })),
  }),
  access: serviceAccess,
}, (ctx, args) => {
  const tx = new Tx(ctx);
  const session = receiveOnThread(tx, {
    ...args,
    author: `${args.surface}:${args.author}`,
    createdBy: `surface:${args.surface}`,
    attachments: args.attachments ?? [],
  });
  tx.commit();
  return { session: session.id, status: session.status };
});

/** Answer the thread's pending messages with the turn's outcome, and move their marks. */
export function replyOnSurface(tx: Tx, session: Session, outcome: TurnOutcome): void {
  const binding = bindingOf(tx, session);
  const pending = binding?.pending ?? [];
  if (binding === null || pending.length === 0) return;
  const done = outcome.kind === "done" ? pending.at(-1)! : null;
  const marks: Marks = { pending, done, previous: binding.acked ?? null };
  const message: Outbound = outcome.kind === "error" ? { kind: "reply", text: `Sorry, I ran into an error: ${outcome.message}`, error: true }
    : outcome.kind === "done" && session.lastText !== null ? { kind: "reply", text: session.lastText, error: false }
    : { kind: "ended" };
  post(tx, session, binding, message, marks);
  save(tx, { ...binding, pending: [], acked: done ?? binding.acked ?? null });
}

/** People on a surface cannot see the web's prompts, so the thread gets its own. */
export function askOnSurface(tx: Tx, session: Session, waiting: Call[]): void {
  const binding = bindingOf(tx, session);
  if (binding === null || (binding.pending ?? []).length === 0) return;
  const calls = waiting.map((call) => ({ id: call.id, approval: call.approval!, prompt: call.prompt ?? call.name }));
  post(tx, session, binding, { kind: "ask", calls }, null);
}

/** The surface posted a prompt for this call; its card follows the call from now on. */
export function bindCard(tx: Tx, session: Session, call: string, card: string): void {
  const binding = bindingOf(tx, session);
  if (binding === null || session.turn?.calls[call]?.state !== "awaiting") return;
  save(tx, { ...binding, cards: { ...binding.cards, [call]: card } });
}

/** A prompt was answered (on the web, on the surface, by a halt or a timeout): its card goes, since the session's log keeps the outcome. */
export function resolvedOnSurface(tx: Tx, session: Session, call: string): void {
  const binding = bindingOf(tx, session);
  const card = binding?.cards?.[call];
  if (binding === null || card === undefined) return;
  const { [call]: _, ...cards } = binding.cards!;
  post(tx, session, binding, { kind: "resolved", call, card }, null);
  save(tx, { ...binding, cards });
}

function bindingOf(tx: Tx, session: Session): Binding | null {
  return session.source === null ? null : tx.ctx.get(bindings, [session.source.surface, session.source.thread]);
}

function save(tx: Tx, binding: Binding): void {
  tx.ctx.set(bindings, [binding.surface, binding.thread], binding);
}

function post(tx: Tx, session: Session, binding: Binding, message: Outbound, marks: Marks | null): void {
  const suffix = message.kind === "resolved" ? `resolved:${message.call}` : message.kind;
  outbound.scope(binding.surface).enqueue(tx.ctx, `${session.id}:${session.seq}:${suffix}`, {
    org: session.org,
    surface: binding.surface,
    thread: binding.thread,
    meta: binding.meta,
    session: session.id,
    seq: session.seq,
    message,
    marks,
  });
}
