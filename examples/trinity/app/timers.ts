import { mutation, v } from "@flower-js/sdk";
import { scheduler } from "@flower-js/sdk/scheduler";
import { runAutomation } from "./automations.ts";
import { idleComputer } from "./computers.ts";
import { advance, finalizeHalt, markResolved, resolveCall } from "./loop.ts";
import { id } from "./model.ts";
import { reviewTimedOut, waitingOn } from "./reviews.ts";
import { toolJobs } from "./store.ts";
import { Tx } from "./tx.ts";

// Every handler re-reads current state: a timer can fire after what it guards has ended.

const finishHalt = mutation("internal.timers.finishHalt", { args: v.object({ session: id }) }, (ctx, args) => {
  const tx = new Tx(ctx);
  const session = tx.find(args.session);
  if (session?.turn?.halting == null) return null;
  finalizeHalt(tx, session);
  advance(tx, session);
  tx.commit();
  return null;
});

const toolTimeout = mutation("internal.timers.toolTimeout", { args: v.object({ session: id, call: v.string({ min: 1 }) }) }, (ctx, args) => {
  const tx = new Tx(ctx);
  const session = tx.find(args.session);
  const call = session?.turn?.calls[args.call];
  if (!session || call?.state !== "running" || call.job === null) return null;
  toolJobs.scope(call.job.scope).cancel(ctx, call.job.id);
  markResolved(tx, session, call, "timed_out");
  resolveCall(tx, session, call, "The tool did not finish in time and was cancelled.", true);
  advance(tx, session);
  tx.commit();
  return null;
});

const reviewTimeout = mutation("internal.timers.reviewTimeout", { args: v.object({ session: id, step: v.int({ min: 1 }) }) }, (ctx, args) => {
  const tx = new Tx(ctx);
  const session = waitingOn(tx, args);
  if (session === null) return null;
  reviewTimedOut(tx, session);
  tx.commit();
  return null;
});

const automationDue = mutation("internal.timers.automation", {
  args: v.object({ org: id, automation: id, at: v.int() }),
}, (ctx, args) => runAutomation(ctx, args.org, args.automation, args.at));

const computerIdle = mutation("internal.timers.computerIdle", {
  args: v.object({ computer: id }),
}, (ctx, args) => idleComputer(ctx, args.computer));

export const timers = scheduler("timers", { finishHalt, toolTimeout, reviewTimeout, automationDue, computerIdle }, {
  maxAttempts: 5, retryDelayMs: 1_000, maxRetryDelayMs: 60_000,
});
