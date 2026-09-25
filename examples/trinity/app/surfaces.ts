import { mutation, v } from "@flower-js/sdk";
import { serviceAccess } from "./access.ts";
import { receive, type TurnOutcome } from "./loop.ts";
import { attachmentSchema, checksum, id, type Attachment, type Call, type Resolution, type Session, type Source } from "./model.ts";
import { bindings, orgs, outbound, type Binding, type Marks, type Outbound } from "./store.ts";
import { newSession, Tx } from "./tx.ts";

// Surfaces are conversations that live elsewhere: a Slack thread, a GitHub issue. Each
// thread is bound to one session, which people can also continue on the web. A thread
// hears back about the turns its own messages started or joined: its messages are pending
// until the turn ends, then the answer (or the error) goes to the surface's delivery queue
// with the marks to move. Turns started on the web answer on the web.

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
  text: string;
  attachments: Attachment[];
  /** Whom a new session belongs to. */
  createdBy: string;
  private?: boolean;
  url?: string;
  label?: string;
}

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
  ctx.set(bindings, [message.surface, message.thread], {
    ...binding,
    surface: message.surface,
    thread: message.thread,
    org: message.org,
    session: session.id,
    meta: message.meta as never,
    pending: [...binding?.pending ?? [], message.message],
  });
  receive(tx, session, {
    id: `${message.surface}:${message.message}`,
    text: message.text,
    steer: true,
    at: ctx.now(),
    attachments: message.attachments,
    author: message.author,
    result: null,
  });
  return session;
}

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

/** A prompt was answered (on the web, on the surface, by a halt or a timeout): update its card. */
export function resolvedOnSurface(tx: Tx, session: Session, call: string, resolution: Resolution, by: string | null): void {
  const binding = bindingOf(tx, session);
  const card = binding?.cards?.[call];
  if (binding === null || card === undefined) return;
  const { [call]: _, ...cards } = binding.cards!;
  const prompt = session.turn?.calls[call]?.prompt ?? session.turn?.calls[call]?.name ?? call;
  post(tx, session, binding, { kind: "resolved", call, card, prompt, resolution, by }, null);
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
