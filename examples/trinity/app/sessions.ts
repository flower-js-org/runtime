import { fail, mutation, query, v, type QueryContext } from "@flower-js/sdk";
import { caller, canSee, sessionAccess, userAccess, workerAccess } from "./access.ts";
import { advance, halt as haltTurn, markResolved, receive, resolveCall, run } from "./loop.ts";
import { attachmentSchema, id, type Delta, type Event, type Prompt, type Segment, type Session } from "./model.ts";
import { partialDeltas } from "./partials.ts";
import { requestSeal } from "./sealing.ts";
import { blobRefs, computers, events, orgs, segments, sessions, titles } from "./store.ts";
import { toolDefinitions } from "./tools.ts";
import { newSession, Tx } from "./tx.ts";

const SYSTEM = `You are Trinity, an agent that works for the user through the tools you are given.
Inspect before you change anything, keep the user informed of what you did, and ask only when you cannot proceed without them.
Memory persists across sessions: consult it when relevant, and save what future sessions should know.`;

/** Log entries a request includes; the rest (statuses, prompts, titles) are for people. */
const RENDERED = new Set(["user", "assistant", "tool_result", "background_result", "interrupted", "compact"]);

const settings = {
  model: v.optional(v.string({ min: 1, max: 128 })),
  system: v.optional(v.nullable(v.string({ max: 100_000 }))),
  computer: v.optional(v.nullable(id)),
  private: v.optional(v.boolean()),
  allow: v.optional(v.array(v.string({ min: 1, max: 128 }), { max: 100 })),
  webTools: v.optional(v.boolean()),
  graceMs: v.optional(v.int({ min: 0, max: 600_000 })),
  contextTokens: v.optional(v.int({ min: 10_000, max: 900_000 })),
};

function chooseComputer(ctx: QueryContext, org: string, computer: string | null | undefined): string | null {
  const chosen = computer === undefined ? ctx.get(orgs, org)?.settings.computer ?? null : computer;
  if (chosen !== null && ctx.get(computers, chosen)?.org !== org) fail("COMPUTER_NOT_FOUND", `No computer ${chosen}`);
  return chosen;
}

/** A session as clients see it: its own title, else the generated one. */
function present(ctx: QueryContext, session: Session) {
  const generated = ctx.get(titles, session.id);
  return { ...session, title: session.title ?? (generated?.status === "ready" ? generated.value : null) };
}

/** Only the settings a caller actually passed. */
function given<T extends object>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function segmentsOf(ctx: QueryContext, session: string): Segment[] {
  return ctx.range(segments.by("bySession").range({ prefix: [session], limit: 1_000 })).rows.map((row) => row.value);
}

export const create = mutation("session.create", { args: v.object({ id, ...settings }), access: userAccess }, (ctx, args) => {
  const who = caller(ctx);
  if (ctx.get(sessions, args.id) !== null) fail("SESSION_EXISTS", `Session ${args.id} already exists`);
  const { id: sessionId, computer, system, ...rest } = args;
  const tx = new Tx(ctx);
  const session = newSession(tx, {
    ...given(rest),
    id: sessionId,
    org: who.org!,
    createdBy: who.subject,
    computer: chooseComputer(ctx, who.org!, computer),
    system: system ?? null,
  });
  tx.commit();
  return present(ctx, session);
});

export const send = mutation("session.send", {
  args: v.object({
    session: id,
    message: id,
    text: v.string({ min: 1, max: 1_000_000 }),
    steer: v.optional(v.boolean()),
    attachments: v.optional(v.array(attachmentSchema, { max: 20 })),
  }),
  access: sessionAccess,
}, (ctx, args) => {
  const tx = new Tx(ctx);
  const session = tx.load(args.session);
  if (session.parent !== null) fail("SUBAGENT", "Subagent sessions take work from their parent only");
  receive(tx, session, {
    id: args.message,
    text: args.text,
    steer: args.steer ?? false,
    at: ctx.now(),
    attachments: args.attachments ?? [],
    author: caller(ctx).subject,
    result: null,
  });
  tx.commit();
  return { status: session.status, seq: session.seq };
});

const decision = {
  call: v.string({ min: 1 }),
  approve: v.optional(v.boolean()),
  answer: v.optional(v.string({ max: 100_000 })),
  /** Also allow this tool for the rest of the session. */
  always: v.optional(v.boolean()),
};

export interface Decision { call: string; approve?: boolean | undefined; answer?: string | undefined; always?: boolean | undefined }

/** Answer a call that waits on someone: approve or deny it, or answer its question. `by` is who decided. */
export function decide(tx: Tx, session: Session, choice: Decision, by: string): void {
  const call = session.turn?.calls[choice.call];
  if (call === undefined || call.state !== "awaiting") fail("NOT_AWAITING", `Call ${choice.call} is not waiting for the user`);

  if (call.approval === "elicitation") {
    if (choice.answer === undefined) fail("ANSWER_REQUIRED", "This call asks a question; send an answer");
    markResolved(tx, session, call, "answered", by);
    resolveCall(tx, session, call, choice.answer, false);
  } else if (choice.approve === true) {
    markResolved(tx, session, call, "approved", by);
    if (choice.always && !session.allow.includes(call.name)) session.allow.push(call.name);
    run(tx, session, call);
  } else if (choice.approve === false) {
    markResolved(tx, session, call, "denied", by);
    resolveCall(tx, session, call, "The user denied this tool call.", true);
  } else {
    fail("APPROVAL_REQUIRED", "This call needs approve: true or false");
  }
  advance(tx, session);
}

/** Answer a prompt: approve or deny a tool call, or answer a question. */
export const resolve = mutation("session.resolve", { args: v.object({ session: id, ...decision }), access: sessionAccess }, (ctx, args) => {
  const tx = new Tx(ctx);
  const session = tx.load(args.session);
  const { session: _, ...choice } = args;
  decide(tx, session, choice, caller(ctx).subject);
  tx.commit();
  return { status: session.status, seq: session.seq };
});

export const halt = mutation("session.halt", { args: v.object({ session: id, background: v.optional(v.boolean()) }), access: sessionAccess }, (ctx, args) => {
  const tx = new Tx(ctx);
  const session = tx.load(args.session);
  const halted = haltTurn(tx, session, { background: args.background ?? false });
  advance(tx, session);
  tx.commit();
  return { halted, status: session.status, seq: session.seq };
});

export const configure = mutation("session.configure", {
  args: v.object({ session: id, title: v.optional(v.nullable(v.string({ min: 1, max: 200 }))), ...settings }),
  access: sessionAccess,
}, (ctx, args) => {
  const tx = new Tx(ctx);
  const session = tx.load(args.session);
  if (args.private !== undefined && caller(ctx).subject !== session.createdBy) fail("FORBIDDEN", "Only the creator can change who sees a session");
  const { session: _, computer, ...rest } = args;
  Object.assign(session, given(rest));
  if (computer !== undefined) session.computer = chooseComputer(ctx, session.org, computer);
  tx.commit();
  return present(ctx, session);
});

/** Move an idle session's whole log to blob storage. A new message resumes it. */
export const archive = mutation("session.archive", { args: v.object({ session: id }), access: sessionAccess }, (ctx, args) => {
  const tx = new Tx(ctx);
  const session = tx.load(args.session);
  if (session.turn !== null) fail("SESSION_BUSY", "Halt the running turn before archiving");
  session.archived = true;
  requestSeal(ctx, session, session.seq);
  tx.commit();
  return present(ctx, session);
});

export const get = query("session.get", { args: v.object({ session: id }), access: sessionAccess }, (ctx, args) => {
  const session = ctx.get(sessions, args.session);
  return session === null ? null : present(ctx, session);
});

export const list = query("session.list", {
  args: v.object({ limit: v.optional(v.int({ min: 1, max: 200 })), archived: v.optional(v.boolean()), before: v.optional(v.int()) }),
  access: userAccess,
}, (ctx, args) => {
  const who = caller(ctx);
  const recent = ctx.range(sessions.by("byOrg").range({
    prefix: [who.org!], limit: 500, reverse: true, ...(args.before === undefined ? {} : { lt: args.before }),
  }));
  return recent.rows
    .map((row) => row.value)
    .filter((session) => session.parent === null && session.archived === (args.archived ?? false) && canSee(ctx, who, session))
    .slice(0, args.limit ?? 50)
    .map((session) => ({
      id: session.id,
      title: present(ctx, session).title,
      status: session.status,
      createdBy: session.createdBy,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      source: session.source,
      private: session.private,
    }));
});

/**
 * A client's live view: events after its cursor and the streaming partial. Clients
 * resubscribe from their newest event when a page fills, which keeps each watched value
 * small. History older than the log's first event is listed as segments to fetch.
 */
export const tail = query("session.tail", {
  args: v.object({ session: id, after: v.optional(v.int({ min: 0 })), limit: v.optional(v.int({ min: 1, max: 1_000 })) }),
  access: sessionAccess,
}, (ctx, args): { session: ReturnType<typeof present>; events: Event[]; partial: { step: number; deltas: Delta[] } | null; segments: Segment[] } | null => {
  const session = ctx.get(sessions, args.session);
  if (session === null) return null;
  const after = args.after ?? 0;
  const page = ctx.range(events.by("bySession").range({ prefix: [session.id], gt: after, limit: args.limit ?? 200 }));
  const step = session.turn?.completion?.step;
  const deltas = step === undefined ? null : partialDeltas(ctx, session.id, step);
  return {
    session: present(ctx, session),
    events: page.rows.map((row) => row.value),
    partial: step === undefined || deltas === null ? null : { step, deltas },
    segments: after < session.sealedThrough ? segmentsOf(ctx, session.id).filter((segment) => segment.to > after) : [],
  };
});

/** Whether the caller may fetch a blob through this session. */
export const blobAccess = query("session.blob", {
  args: v.object({ session: id, key: v.string({ min: 1, max: 256 }) }),
  access: sessionAccess,
}, (ctx, args) => ctx.get(blobRefs, [args.session, args.key]) !== null);

/** The request of one completion step, frozen at the log position the step started from. Null once the step is no longer current. */
export const prompt = query("session.prompt", { args: v.object({ session: id, step: v.int({ min: 1 }) }), access: workerAccess }, (ctx, args): Prompt | null => {
  const session = ctx.get(sessions, args.session);
  const completion = session?.turn?.completion;
  if (!session || !completion || completion.step !== args.step) return null;

  const start = Math.max(1, session.compactSeq);
  const log: Event[] = [];
  let after: string | undefined;
  do {
    const page = ctx.range(events.by("bySession").range({
      prefix: [session.id], gte: start, lte: completion.uptoSeq, limit: 512, ...(after === undefined ? {} : { after }),
    }));
    for (const row of page.rows) if (RENDERED.has(row.value.body.type)) log.push(row.value);
    after = page.cursor ?? undefined;
  } while (after !== undefined);

  const memory = session.memory === null ? null : `<memory>\n${session.memory}\n</memory>`;
  return {
    kind: completion.kind,
    start,
    model: session.model,
    system: [SYSTEM, session.system, memory].filter((part) => part !== null).join("\n\n"),
    tools: toolDefinitions(ctx, session),
    segments: session.sealedThrough >= start ? segmentsOf(ctx, session.id).filter((segment) => segment.to >= start) : [],
    events: log,
  };
});
