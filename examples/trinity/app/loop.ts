import type { Json } from "@flower-js/sdk";
import { demandComputer } from "./computers.ts";
import { append, setStatus } from "./log.ts";
import { memorySnapshot } from "./memories.ts";
import type { Block, Call, CompletionJob, CompletionKind, CompletionMessage, Queued, Resolution, Session } from "./model.ts";
import { clearPartial, partialText } from "./partials.ts";
import { endReview, startReview } from "./reviews.ts";
import { requestSeal } from "./sealing.ts";
import { blobRefs, completions, titleSources, toolJobs } from "./store.ts";
import { askOnSurface, replyOnSurface, resolvedOnSurface } from "./surfaces.ts";
import { timers } from "./timers.ts";
import { resolveTool } from "./tools.ts";
import { BASE_TOKENS, type Tx } from "./tx.ts";
import { recordUsage, withinBudget } from "./usage.ts";

// A session's turn, as a state machine. Every function here runs inside one mutation and
// leaves the session consistent: whatever it enqueued, appended or changed commits together.

const DEFAULT_TOOL_TIMEOUT_MS = 600_000;

export const toolJobId = (session: string, call: string) => `${session}:${call}`;

const hasRunning = (session: Session) => Object.values(session.turn?.calls ?? {}).some((call) => call.state === "running");

/**
 * Move the session forward until it waits on a worker, on the user, or on nothing.
 * Continuation follows outstanding calls and owed completions, never a provider's stop reason.
 */
export function advance(tx: Tx, session: Session): void {
  const { ctx } = tx;
  for (;;) {
    const turn = session.turn;
    if (turn === null) {
      if (session.status !== "halted" && session.queued.length > 0) {
        openTurn(tx, session, session.queued.splice(0));
        continue;
      }
      if (session.status === "working" || session.status === "waiting_on_user") setStatus(ctx, session, "idle");
      return;
    }
    if (turn.halting !== null) {
      if (!hasRunning(session)) finalizeHalt(tx, session);
      return;
    }
    if (turn.completion !== null) return setStatus(ctx, session, "working");

    const calls = Object.values(turn.calls);
    if (calls.some((call) => call.state === "awaiting")) return setStatus(ctx, session, "waiting_on_user");
    if (calls.some((call) => call.state === "running" || call.state === "reviewing")) return setStatus(ctx, session, "working");

    // Steers and background results join the turn at this boundary; follow-ups wait for the next turn.
    const steers = session.queued.filter((message) => message.steer);
    if (steers.length > 0) {
      session.queued = session.queued.filter((message) => !message.steer);
      for (const message of steers) admit(tx, session, message);
      turn.owed = true;
    }

    if (turn.owed) {
      if (!withinBudget(ctx, session.org)) {
        settleError(tx, session, "BUDGET_EXCEEDED", "The organization reached its monthly spending limit.");
        continue;
      }
      const tooLong = session.contextEstimate > session.contextTokens && turn.lastKind !== "compact";
      return startCompletion(tx, session, tooLong ? "compact" : "respond");
    }

    session.turn = null;
    turnEnded(tx, session, { kind: "done" });
  }
}

/**
 * Accept a message from a user: it opens a turn, waits in the queue, or preempts open prompts.
 * A message with the ID of the last queued one replaces it, so what a surface thread says
 * before the session takes it in joins the log as one message.
 */
export function receive(tx: Tx, session: Session, message: Queued): void {
  const last = session.queued.length - 1;
  if (last >= 0 && session.queued[last]!.id === message.id) session.queued[last] = message;
  else session.queued.push(message);
  const turn = session.turn;
  if (turn !== null && message.steer && !message.aside && turn.completion === null && turn.halting === null) {
    for (const call of Object.values(turn.calls)) {
      if (call.state !== "awaiting") continue;
      markResolved(tx, session, call, "preempted");
      resolveCall(tx, session, call, "The user sent a new message instead of responding to this.", true);
    }
  }
  // A halted session resumes with everything the user queued.
  if (turn === null && session.status === "halted") session.status = "idle";
  advance(tx, session);
}

function openTurn(tx: Tx, session: Session, messages: Queued[]): void {
  session.turn = { message: messages[0]!.id, owed: true, calls: {}, completion: null, halting: null, lastKind: null };
  session.lastText = null;
  session.archived = false;
  session.memory = memorySnapshot(tx.ctx, session);
  setStatus(tx.ctx, session, "working");
  for (const message of messages) admit(tx, session, message);
}

function admit(tx: Tx, session: Session, message: Queued): void {
  const { ctx } = tx;
  if (message.result !== null) {
    append(ctx, session, { type: "background_result", ...message.result });
    session.contextEstimate += Math.ceil(message.result.content.length / 4);
    return;
  }
  append(ctx, session, { type: "user", message: message.id, text: message.text, attachments: message.attachments, author: message.author });
  for (const attachment of message.attachments) {
    ctx.set(blobRefs, [session.id, attachment.blob], { session: session.id, key: attachment.blob });
  }
  // An image or document costs roughly a page of tokens; the next completion's usage corrects the estimate.
  session.contextEstimate += Math.ceil(message.text.length / 4) + 1_600 * message.attachments.length;
  if (session.parent === null && ctx.get(titleSources, session.id) === null) {
    ctx.set(titleSources, session.id, { text: message.text });
  }
}

function startCompletion(tx: Tx, session: Session, kind: CompletionKind): void {
  const turn = session.turn!;
  session.steps += 1;
  const job = `${session.id}:${session.steps}`;
  completions.enqueue(tx.ctx, job, { session: session.id, step: session.steps, uptoSeq: session.seq, kind });
  turn.completion = { step: session.steps, job, uptoSeq: session.seq, kind };
  // A compaction leaves the response still owed.
  turn.owed = kind === "compact";
  turn.calls = {};
  setStatus(tx.ctx, session, "working");
}

export function recordCompletion(tx: Tx, session: Session, job: CompletionJob, message: CompletionMessage): void {
  const { ctx } = tx;
  const turn = session.turn!;
  turn.completion = null;
  turn.lastKind = job.kind;
  clearPartial(ctx, session.id);
  const cost = recordUsage(tx, session, job.step, message.model, message.usage);
  const text = message.blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n\n");
  if (job.kind === "compact") return recordSummary(tx, session, text);

  // A refusal's partial output is billed, but it is not a response and its calls must not run.
  const refused = message.stopReason === "refusal";
  append(ctx, session, {
    type: "assistant",
    blocks: refused ? [] : message.blocks,
    model: message.model,
    stopReason: message.stopReason,
    usage: message.usage,
    costNanos: cost,
    interrupted: false,
  });
  const { input, cacheRead, cacheWrite, output } = message.usage;
  session.contextEstimate = input + cacheRead + cacheWrite + output;
  if (refused) {
    settleError(tx, session, "REFUSED", "The model declined to continue.");
    return advance(tx, session);
  }
  if (text !== "") session.lastText = text;
  // The provider paused a long server-side tool loop; sending the paused message back resumes it.
  if (message.stopReason === "pause_turn") turn.owed = true;

  const toolCalls = message.blocks.filter((block): block is Extract<Block, { type: "tool_call" }> => block.type === "tool_call");
  for (const block of toolCalls) {
    const call: Call = { id: block.id, name: block.name, input: block.input, state: "running", approval: null, prompt: null, job: null, child: null };
    turn.calls[call.id] = call;
    if (message.stopReason === "max_tokens") {
      resolveCall(tx, session, call, "Not run: the response reached its output limit while writing this call, so its input may be truncated.", true);
    } else {
      dispatch(tx, session, call);
    }
  }
  if (toolCalls.length > 0) turn.owed = true;

  const reviewing = Object.values(turn.calls).filter((call) => call.state === "reviewing");
  if (reviewing.length > 0) startReview(tx, session, reviewing);
  const waiting = Object.values(turn.calls).filter((call) => call.state === "awaiting");
  if (waiting.length > 0 && session.source !== null) askOnSurface(tx, session, waiting);
  advance(tx, session);
}

function recordSummary(tx: Tx, session: Session, summary: string): void {
  if (summary === "") {
    settleError(tx, session, "COMPACTION_FAILED", "Summarizing the conversation produced no text.");
    return advance(tx, session);
  }
  session.compactSeq = append(tx.ctx, session, { type: "compact", summary });
  session.contextEstimate = BASE_TOKENS + Math.ceil(summary.length / 4);
  // Requests start at the summary from now on, so the log before it can move to blob storage.
  requestSeal(tx.ctx, session, session.compactSeq - 1);
  advance(tx, session);
}

function dispatch(tx: Tx, session: Session, call: Call): void {
  const tool = resolveTool(tx.ctx, session, call.name);
  if (tool === undefined) return resolveCall(tx, session, call, `Unknown tool ${JSON.stringify(call.name)}.`, true);
  let input: unknown;
  try {
    input = tool.input.parse(call.input);
  } catch (error) {
    return resolveCall(tx, session, call, `Invalid input: ${(error as Error).message}`, true);
  }
  const allowed = tool.approval === "permission" && session.allow.includes(call.name);
  if (tool.approval === undefined || allowed) return run(tx, session, call, input);
  call.approval = tool.approval;
  call.prompt = tool.prompt?.(input) ?? call.name;
  // The response's permission requests go to the reviewer together, once all its calls are dispatched.
  if (call.approval === "permission" && session.autoApprove) call.state = "reviewing";
  else awaitUser(tx, session, call);
}

/** Put a call to the user: a permission request, or a question. */
export function awaitUser(tx: Tx, session: Session, call: Call): void {
  call.state = "awaiting";
  append(tx.ctx, session, { type: "tool_awaiting", call: call.id, kind: call.approval!, prompt: call.prompt ?? call.name });
}

/** Run an admitted call: inline tools now, the others as jobs on the session's computer or the service. */
export function run(tx: Tx, session: Session, call: Call, input: unknown = call.input): void {
  const { ctx } = tx;
  const tool = resolveTool(ctx, session, call.name)!;
  call.state = "running";
  if (tool.runsOn === "inline") {
    const outcome = tool.run!(tx, session, input, call);
    // An asynchronous inline tool (a subagent) resolves the call later.
    if (outcome !== "async") resolveCall(tx, session, call, outcome.content, outcome.isError);
    return;
  }

  const scope = tool.runsOn === "service" ? "service" : session.computer === null ? null : `computer:${session.computer}`;
  if (scope === null) return resolveCall(tx, session, call, "No computer is attached to this session, so computer tools cannot run.", true);
  const job = { id: toolJobId(session.id, call.id), scope };
  const background = tool.background?.(input) ?? false;
  toolJobs.scope(scope).enqueue(ctx, job.id, { session: session.id, call: call.id, name: call.name, input: input as Json, background, mcp: tool.mcp ?? null });
  if (tool.runsOn === "computer") demandComputer(ctx, session.computer!);

  if (background) {
    session.background[call.id] = { ...job, name: call.name };
    return resolveCall(tx, session, call, `Started in the background as ${call.id}. Its result will arrive as a message when it finishes.`, false);
  }
  call.job = job;
  timers.after(ctx, `timeout:${job.id}`, tool.timeoutMs?.(input) ?? DEFAULT_TOOL_TIMEOUT_MS, "toolTimeout", { session: session.id, call: call.id });
}

export function resolveCall(tx: Tx, session: Session, call: Call, content: string, isError: boolean, blob: string | null = null): void {
  const { ctx } = tx;
  if (call.job !== null) timers.cancel(ctx, `timeout:${call.job.id}`);
  call.state = "done";
  append(ctx, session, { type: "tool_result", call: call.id, content, isError, blob });
  if (blob !== null) ctx.set(blobRefs, [session.id, blob], { session: session.id, key: blob });
  session.contextEstimate += Math.ceil(content.length / 4);
}

/** A background call finished: its result joins the session like a steer. */
export function backgroundDone(tx: Tx, session: Session, callId: string, content: string, isError: boolean, blob: string | null): void {
  if (session.background[callId] === undefined) return;
  delete session.background[callId];
  if (blob !== null) tx.ctx.set(blobRefs, [session.id, blob], { session: session.id, key: blob });
  session.queued.push({
    id: `result:${callId}`, text: "", steer: true, at: tx.ctx.now(), attachments: [], author: null,
    result: { call: callId, content, isError, blob },
  });
  advance(tx, session);
}

/** End the turn after a failure. Queued follow-ups still run. */
export function settleError(tx: Tx, session: Session, code: string, message: string): void {
  append(tx.ctx, session, { type: "error", code, message, retryInMs: null });
  if (session.turn !== null) abandonTurn(tx, session, "Not run: the turn ended with an error.");
  setStatus(tx.ctx, session, "error");
  turnEnded(tx, session, { kind: "error", message });
}

/**
 * Stop the turn. Streamed text is kept, and prompts and reviews are cancelled at once; running tools get
 * the session's grace window to finish. Every call still gets a result.
 */
export function halt(tx: Tx, session: Session, options: { background?: boolean } = {}): boolean {
  const { ctx } = tx;
  if (options.background) {
    for (const [callId, job] of Object.entries(session.background)) {
      toolJobs.scope(job.scope).cancel(ctx, job.id);
      delete session.background[callId];
    }
  }
  const turn = session.turn;
  if (turn === null) return false;
  if (turn.halting !== null) return true;

  if (turn.completion !== null) keepPartial(tx, session);
  endReview(tx, session);
  for (const call of Object.values(turn.calls)) {
    if (call.state !== "awaiting" && call.state !== "reviewing") continue;
    markResolved(tx, session, call, "cancelled");
    resolveCall(tx, session, call, "Cancelled by user halt.", true);
  }
  if (session.graceMs > 0 && hasRunning(session)) {
    turn.halting = { until: ctx.now() + session.graceMs };
    timers.after(ctx, `halt:${session.id}`, session.graceMs, "finishHalt", { session: session.id });
    return true;
  }
  finalizeHalt(tx, session);
  return true;
}

export function finalizeHalt(tx: Tx, session: Session): void {
  timers.cancel(tx.ctx, `halt:${session.id}`);
  abandonTurn(tx, session, "Tool execution cancelled by user halt.");
  setStatus(tx.ctx, session, "halted");
  append(tx.ctx, session, { type: "interrupted" });
  turnEnded(tx, session, { kind: "halted" });
}

function abandonTurn(tx: Tx, session: Session, reason: string): void {
  const turn = session.turn!;
  if (turn.completion !== null) keepPartial(tx, session);
  endReview(tx, session);
  for (const call of Object.values(turn.calls)) {
    if (call.state === "done") continue;
    if (call.job !== null) toolJobs.scope(call.job.scope).cancel(tx.ctx, call.job.id);
    markResolved(tx, session, call, "cancelled");
    resolveCall(tx, session, call, reason, true);
    // The call is answered first, so the child's own halt has nothing left to deliver.
    const child = call.child === null ? null : tx.find(call.child);
    if (child !== null) halt(tx, child);
  }
  session.turn = null;
}

/** Cancel the running completion and keep what it streamed as an interrupted response. */
function keepPartial(tx: Tx, session: Session): void {
  const { ctx } = tx;
  const completion = session.turn!.completion!;
  completions.cancel(ctx, completion.job);
  const text = partialText(ctx, session.id, completion.step);
  if (text.length > 0) {
    append(ctx, session, {
      type: "assistant",
      blocks: text.map((part) => ({ type: "text", text: part })),
      model: session.model,
      stopReason: null,
      usage: null,
      costNanos: 0,
      interrupted: true,
    });
  }
  clearPartial(ctx, session.id);
  session.turn!.completion = null;
}

/** Record why a call stopped waiting or running, and who decided, and drop its prompt from a surface thread. */
export function markResolved(tx: Tx, session: Session, call: Call, resolution: Resolution, by?: string): void {
  append(tx.ctx, session, { type: "tool_resolved", call: call.id, resolution, ...(by === undefined ? {} : { by }) });
  if (session.source !== null) resolvedOnSurface(tx, session, call.id);
}

export type TurnOutcome = { kind: "done" } | { kind: "error"; message: string } | { kind: "halted" };

/** Tell whoever waits on this session: a parent's subagent call, a surface thread. */
function turnEnded(tx: Tx, session: Session, outcome: TurnOutcome): void {
  if (session.parent !== null) answerParent(tx, session, outcome);
  if (session.source !== null) replyOnSurface(tx, session, outcome);
}

function answerParent(tx: Tx, child: Session, outcome: TurnOutcome): void {
  const parent = tx.find(child.parent!.session);
  const call = parent?.turn?.calls[child.parent!.call];
  if (!parent || !call || call.state !== "running" || call.child !== child.id) return;
  const answer = outcome.kind === "done" ? child.lastText ?? "The subagent finished without a response."
    : outcome.kind === "error" ? `The subagent failed: ${outcome.message}`
    : "The subagent was halted.";
  resolveCall(tx, parent, call, answer, outcome.kind !== "done");
  advance(tx, parent);
}
