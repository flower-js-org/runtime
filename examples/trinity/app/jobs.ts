import { mutation, v, type MutationContext } from "@flower-js/sdk";
import type { Claim, Job, LeaseIdentity } from "@flower-js/sdk/temporal";
import { scopeAccess, workerAccess } from "./access.ts";
import { claimOptions, leaseLost, leaseOf } from "./leases.ts";
import { append } from "./log.ts";
import { advance, backgroundDone, recordCompletion, resolveCall, settleError } from "./loop.ts";
import {
  deltaSchema, id, lease, outcomeSchema, toolOutcomeSchema, workerError,
  type Call, type CompletionJob, type CompletionOutcome, type Session, type ToolJob, type ToolOutcome,
} from "./model.ts";
import { appendPartial } from "./partials.ts";
import { completions, MAX_COMPLETION_ATTEMPTS, MAX_TOOL_ATTEMPTS, toolJobs } from "./store.ts";
import { resolveTool } from "./tools.ts";
import { Tx } from "./tx.ts";

// Workers drive these through runQueueWorker, which calls `${queue}.claim`, `.renew`,
// `.complete`, `.fail` and `.ready`. Claims, completions and failures are replaced here
// so each one moves the owning session in the same commit as the job.

type Failure = Extract<CompletionOutcome, { ok: false }>["error"];

/** The session a completion job still serves, or null once it moved on. */
function servedBy(tx: Tx, job: CompletionJob, jobId: string): Session | null {
  const session = tx.find(job.session);
  return session?.turn?.completion?.job === jobId ? session : null;
}

export const claimCompletion = mutation("worker.completions.claim", {
  args: v.object({ owner: v.string({ min: 1 }), leaseMs: v.optional(v.int({ min: 1 })) }),
  access: workerAccess,
}, (ctx, args): Claim<CompletionJob> | null => {
  for (;;) {
    const claim = completions.claim(ctx, args.owner, claimOptions(args));
    if (claim === null) return null;
    const tx = new Tx(ctx);
    const session = servedBy(tx, claim.payload, claim.id);
    if (session !== null && claim.attempt <= MAX_COMPLETION_ATTEMPTS) return claim;
    completions.cancel(ctx, claim.id);
    if (session === null) continue;
    // Every earlier attempt lost its lease without reporting.
    settleError(tx, session, "COMPLETION_ATTEMPTS", `The model call did not finish after ${MAX_COMPLETION_ATTEMPTS} attempts.`);
    advance(tx, session);
    tx.commit();
  }
});

export const completeCompletion = mutation("worker.completions.complete", {
  args: v.object({ ...lease, result: outcomeSchema }),
  access: workerAccess,
}, (ctx, args) => {
  const job = completions.get(ctx, args.id) ?? leaseLost();
  if (!args.result.ok) return failCompletion(ctx, args, job, args.result.error);
  completions.complete(ctx, leaseOf(args), args.result);
  completions.cancel(ctx, job.id);
  const tx = new Tx(ctx);
  const session = servedBy(tx, job.payload, job.id);
  if (session === null) return null;
  recordCompletion(tx, session, job.payload, args.result.message);
  tx.commit();
  return null;
});

/** A worker that threw instead of reporting an outcome. */
export const failCompletionMethod = mutation("worker.completions.fail", {
  args: v.object({ ...lease, error: workerError }),
  access: workerAccess,
}, (ctx, args) => {
  const job = completions.get(ctx, args.id) ?? leaseLost();
  return failCompletion(ctx, args, job, { code: "WORKER_ERROR", message: args.error.message, retryable: true });
});

function failCompletion(ctx: MutationContext, args: LeaseIdentity, job: Job<CompletionJob, CompletionOutcome>, error: Failure) {
  const tx = new Tx(ctx);
  const session = servedBy(tx, job.payload, job.id);
  const retry = error.retryable && job.attempts < MAX_COMPLETION_ATTEMPTS;
  const delayMs = retry ? Math.min(30_000, error.retryAfterMs ?? 500 * 2 ** (job.attempts - 1)) : 0;
  completions.fail(ctx, leaseOf(args), { code: error.code, message: error.message }, retry ? { delayMs } : { retry: false });
  if (session === null) return null;
  if (retry) {
    append(ctx, session, { type: "error", code: error.code, message: error.message, retryInMs: delayMs });
  } else {
    completions.cancel(ctx, job.id);
    settleError(tx, session, error.code, error.message);
    advance(tx, session);
  }
  tx.commit();
  return null;
}

/** Store streamed deltas. `stop` tells the worker its step is no longer wanted, so it can abort without waiting for a renewal. */
export const progressCompletion = mutation("worker.completions.progress", {
  args: v.object({ ...lease, deltas: v.array(deltaSchema, { max: 4_096 }) }),
  access: workerAccess,
}, (ctx, args) => {
  const job = completions.get(ctx, args.id);
  const held = job?.state === "leased" && job.lease?.owner === args.owner && job.lease.token === args.token;
  if (!held) return leaseLost();
  const session = servedBy(new Tx(ctx), job.payload, job.id);
  if (session === null) return { stop: true };
  appendPartial(ctx, session.id, job.payload.step, args.token, args.deltas);
  return { stop: false };
});

/** The call a tool job still answers: a running foreground call, or a background job (`call` is then null). */
function answering(tx: Tx, job: ToolJob): { session: Session; call: Call | null } | null {
  const session = tx.find(job.session);
  if (session === null) return null;
  if (job.background) return session.background[job.call] === undefined ? null : { session, call: null };
  const call = session.turn?.calls[job.call];
  return call?.state === "running" && call.job !== null ? { session, call } : null;
}

function answer(tx: Tx, job: ToolJob, target: { session: Session; call: Call | null }, outcome: ToolOutcome): void {
  const blob = outcome.blob ?? null;
  if (target.call === null) return backgroundDone(tx, target.session, job.call, outcome.content, outcome.isError, blob);
  resolveCall(tx, target.session, target.call, outcome.content, outcome.isError, blob);
  advance(tx, target.session);
}

const isIdempotent = (ctx: MutationContext, target: { session: Session } | null, name: string) =>
  target !== null && (resolveTool(ctx, target.session, name)?.idempotent ?? false);

export const claimTool = mutation("worker.tools.claim", {
  args: v.object({ scope: id, owner: v.string({ min: 1 }), leaseMs: v.optional(v.int({ min: 1 })) }),
  access: scopeAccess,
}, (ctx, args): Claim<ToolJob> | null => {
  const jobs = toolJobs.scope(args.scope);
  for (;;) {
    const claim = jobs.claim(ctx, args.owner, claimOptions(args));
    if (claim === null) return null;
    const tx = new Tx(ctx);
    const target = answering(tx, claim.payload);
    const idempotent = isIdempotent(ctx, target, claim.payload.name);
    const mayRun = claim.attempt === 1 || (idempotent && claim.attempt <= MAX_TOOL_ATTEMPTS);
    if (target !== null && mayRun) return claim;
    jobs.cancel(ctx, claim.id);
    if (target === null) continue;
    // An earlier worker took this call and never reported. Running it again could repeat its effects.
    answer(tx, claim.payload, target, {
      content: idempotent
        ? `The tool did not finish after ${MAX_TOOL_ATTEMPTS} attempts.`
        : "The worker running this tool stopped before reporting a result, so its outcome is unknown. Check the current state before retrying.",
      isError: true,
    });
    tx.commit();
  }
});

export const completeTool = mutation("worker.tools.complete", {
  args: v.object({ scope: id, ...lease, result: toolOutcomeSchema }),
  access: scopeAccess,
}, (ctx, args) => {
  const jobs = toolJobs.scope(args.scope);
  const job = jobs.get(ctx, args.id) ?? leaseLost();
  jobs.complete(ctx, leaseOf(args), args.result);
  jobs.cancel(ctx, job.id);
  const tx = new Tx(ctx);
  const target = answering(tx, job.payload);
  if (target === null) return null;
  answer(tx, job.payload, target, args.result);
  tx.commit();
  return null;
});

export const failTool = mutation("worker.tools.fail", {
  args: v.object({ scope: id, ...lease, error: workerError }),
  access: scopeAccess,
}, (ctx, args) => {
  const jobs = toolJobs.scope(args.scope);
  const job = jobs.get(ctx, args.id) ?? leaseLost();
  const tx = new Tx(ctx);
  const target = answering(tx, job.payload);
  const retry = isIdempotent(ctx, target, job.payload.name) && job.attempts < MAX_TOOL_ATTEMPTS;
  const after = jobs.fail(ctx, leaseOf(args), { message: args.error.message }, { retry });
  if (after.state !== "failed") return null;
  jobs.cancel(ctx, job.id);
  if (target === null) return null;
  answer(tx, job.payload, target, { content: `The tool failed: ${args.error.message}`, isError: true });
  tx.commit();
  return null;
});
