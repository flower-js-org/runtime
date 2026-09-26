import { mutation, query, v, type QueryContext } from "@flower-js/sdk";
import type { Claim } from "@flower-js/sdk/temporal";
import { workerAccess } from "./access.ts";
import { claimOptions, leaseLost, leaseOf } from "./leases.ts";
import { append } from "./log.ts";
import { advance, awaitUser, markResolved, resolveCall, run } from "./loop.ts";
import {
  id, lease, reviewOutcomeSchema, workerError,
  type Body, type Call, type Event, type ReviewCall, type ReviewJob, type ReviewRequest, type Session, type Verdict,
} from "./model.ts";
import { computers, events, MAX_REVIEW_ATTEMPTS, reviews, sessions } from "./store.ts";
import { askOnSurface } from "./surfaces.ts";
import { timers } from "./timers.ts";
import { resolveTool } from "./tools.ts";
import { autoApproveAt, Tx } from "./tx.ts";

// Autoapproval. A call that would ask for permission goes to a reviewer first (Jev, through
// the service worker), which sees the call and the conversation that led to it and scores it.
// The calls whose every score reaches the session's threshold run without asking; the others
// ask as they would have. A review that fails or takes too long asks too, so the reviewer can
// only ever spare the user a prompt.

const REVIEW_TIMEOUT_MS = 20_000;
/** Events the reviewer sees besides the latest user message. */
const RECENT_EVENTS = 12;
/** How far back the latest user message is looked for. */
const MAX_SCANNED = 2_000;
const TEXT_LIMIT = 2_000;
const CONTEXT = new Set<Body["type"]>(["user", "assistant", "tool_result", "background_result", "compact"]);

const reviewJobId = (session: string, step: number) => `${session}:${step}:review`;
const reviewing = (session: Session) => Object.values(session.turn?.calls ?? {}).filter((call) => call.state === "reviewing");
const unreviewed = (note: string): Verdict => ({ reviewer: null, scores: {}, note });

/** Send one response's permission requests to the reviewer. */
export function startReview(tx: Tx, session: Session, calls: Call[]): void {
  const jobId = reviewJobId(session.id, session.steps);
  reviews.enqueue(tx.ctx, jobId, { session: session.id, step: session.steps, calls: calls.map((call) => call.id) });
  timers.after(tx.ctx, `review:${jobId}`, REVIEW_TIMEOUT_MS, "reviewTimeout", { session: session.id, step: session.steps });
}

/** Stop waiting on the reviewer, before the reviewing calls are answered some other way. */
export function endReview(tx: Tx, session: Session): void {
  if (reviewing(session).length === 0) return;
  const jobId = reviewJobId(session.id, session.steps);
  reviews.cancel(tx.ctx, jobId);
  timers.cancel(tx.ctx, `review:${jobId}`);
}

/** The session still waiting on this review, or null once it moved on. */
export function waitingOn(tx: Tx, job: { session: string; step: number }): Session | null {
  const session = tx.find(job.session);
  return session !== null && session.steps === job.step && reviewing(session).length > 0 ? session : null;
}

export function reviewTimedOut(tx: Tx, session: Session): void {
  settleReview(tx, session, () => unreviewed("The review took too long."));
}

/**
 * Approved calls run and the others ask. A steer that arrived during the review preempts the
 * prompts it would open, as it preempts open ones.
 */
function settleReview(tx: Tx, session: Session, verdictOf: (call: Call) => Verdict): void {
  const calls = reviewing(session);
  endReview(tx, session);
  const steered = session.queued.some((message) => message.steer && !message.aside && message.result === null);
  const threshold = autoApproveAt(session);
  const asking: Call[] = [];
  for (const call of calls) {
    const { reviewer, scores, note } = verdictOf(call);
    const answers = Object.values(scores);
    const approved = reviewer !== null && answers.length > 0 && answers.every((score) => score >= threshold);
    append(tx.ctx, session, { type: "tool_reviewed", call: call.id, approved, reviewer, scores, note, threshold });
    if (approved) {
      run(tx, session, call);
    } else if (steered) {
      markResolved(tx, session, call, "preempted");
      resolveCall(tx, session, call, "The user sent a new message instead of responding to this.", true);
    } else {
      awaitUser(tx, session, call);
      asking.push(call);
    }
  }
  if (asking.length > 0 && session.source !== null) askOnSurface(tx, session, asking);
  advance(tx, session);
}

// What the reviewer sees

/** The calls a review job decides and their context. Null once the review is no longer wanted. */
export const reviewRequest = query("session.review", {
  args: v.object({ session: id, step: v.int({ min: 1 }) }),
  access: workerAccess,
}, (ctx, args): ReviewRequest | null => {
  const session = ctx.get(sessions, args.session);
  if (session === null || session.steps !== args.step) return null;
  const calls = reviewing(session);
  if (calls.length === 0) return null;
  const computer = session.computer === null ? null : ctx.get(computers, session.computer);
  return {
    calls: calls.map((call) => reviewCall(ctx, session, call)),
    computer: computer?.kind ?? null,
    surface: session.source?.surface ?? null,
    ...context(ctx, session),
  };
});

function reviewCall(ctx: QueryContext, session: Session, call: Call): ReviewCall {
  const tool = resolveTool(ctx, session, call.name);
  return {
    id: call.id,
    name: call.name,
    description: clipped(tool?.description ?? ""),
    input: clipped(call.input),
    prompt: clipped(call.prompt ?? call.name),
    runsOn: tool?.runsOn ?? "service",
    server: tool?.mcp?.server ?? null,
  };
}

/** The latest user message (or summary), and at most RECENT_EVENTS events after it, up to the response that made the calls. */
function context(ctx: QueryContext, session: Session): { events: Event[]; omitted: number } {
  const picked: Event[] = [];
  let omitted = 0;
  // What follows the response (results of its calls so far, statuses) did not lead to the calls.
  let started = false;
  const floor = Math.max(1, session.compactSeq);
  let before = session.seq + 1;
  for (let scanned = 0; before > floor && scanned < MAX_SCANNED;) {
    const { rows } = ctx.range(events.by("bySession").range({ prefix: [session.id], gte: floor, lt: before, limit: 256, reverse: true }));
    if (rows.length === 0) break;
    for (const { value: event } of rows) {
      scanned += 1;
      before = event.seq;
      const { type } = event.body;
      started ||= type === "assistant";
      if (!started || !CONTEXT.has(type)) continue;
      const opening = type === "user" || type === "compact";
      if (opening || picked.length < RECENT_EVENTS) picked.push({ ...event, body: forReview(event.body) });
      else omitted += 1;
      if (opening) return { events: picked.reverse(), omitted };
    }
  }
  return { events: picked.reverse(), omitted };
}

/** Text and calls only: thinking and provider blocks mean nothing to the reviewer. */
function forReview(body: Body): Body {
  if (body.type !== "assistant") return clipped(body);
  return clipped({ ...body, blocks: body.blocks.filter((block) => block.type === "text" || block.type === "tool_call") });
}

/** Long strings shortened, so a request stays small whatever the log holds. */
function clipped<T>(value: T): T {
  if (typeof value === "string") {
    return (value.length <= TEXT_LIMIT ? value : `${value.slice(0, TEXT_LIMIT)}… (${value.length - TEXT_LIMIT} more characters)`) as T;
  }
  if (Array.isArray(value)) return value.map(clipped) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, clipped(each)])) as T;
  return value;
}

// The reviewer's job

export const claimReview = mutation("worker.reviews.claim", {
  args: v.object({ owner: v.string({ min: 1 }), leaseMs: v.optional(v.int({ min: 1 })) }),
  access: workerAccess,
}, (ctx, args): Claim<ReviewJob> | null => {
  for (;;) {
    const claim = reviews.claim(ctx, args.owner, claimOptions(args));
    if (claim === null) return null;
    const tx = new Tx(ctx);
    const session = waitingOn(tx, claim.payload);
    if (session !== null && claim.attempt <= MAX_REVIEW_ATTEMPTS) return claim;
    reviews.cancel(ctx, claim.id);
    if (session === null) continue;
    // Every earlier attempt lost its lease without reporting.
    settleReview(tx, session, () => unreviewed("The reviewer did not answer."));
    tx.commit();
  }
});

export const completeReview = mutation("worker.reviews.complete", {
  args: v.object({ ...lease, result: reviewOutcomeSchema }),
  access: workerAccess,
}, (ctx, args) => {
  const job = reviews.get(ctx, args.id) ?? leaseLost();
  reviews.complete(ctx, leaseOf(args), args.result);
  reviews.cancel(ctx, job.id);
  const tx = new Tx(ctx);
  const session = waitingOn(tx, job.payload);
  if (session === null) return null;
  settleReview(tx, session, (call) => args.result.verdicts[call.id] ?? unreviewed("The reviewer gave no verdict on this call."));
  tx.commit();
  return null;
});

/** A worker that threw instead of reporting verdicts. */
export const failReview = mutation("worker.reviews.fail", {
  args: v.object({ ...lease, error: workerError }),
  access: workerAccess,
}, (ctx, args) => {
  const job = reviews.get(ctx, args.id) ?? leaseLost();
  const after = reviews.fail(ctx, leaseOf(args), { message: args.error.message }, { retry: job.attempts < MAX_REVIEW_ATTEMPTS });
  if (after.state !== "failed") return null;
  reviews.cancel(ctx, job.id);
  const tx = new Tx(ctx);
  const session = waitingOn(tx, job.payload);
  if (session === null) return null;
  settleReview(tx, session, () => unreviewed(clipped(`The review failed: ${args.error.message}`)));
  tx.commit();
  return null;
});
