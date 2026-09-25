import { fail, mutation, query, v, type MutationContext, type QueryContext } from "@flower-js/sdk";
import { caller, userAccess } from "./access.ts";
import { nextRun, parseCron } from "./cron.ts";
import { receive } from "./loop.ts";
import { id } from "./model.ts";
import { automations, type Automation } from "./store.ts";
import { timers } from "./timers.ts";
import { newSession, Tx } from "./tx.ts";

// An automation starts a new session with the same prompt on a cron schedule. Each run
// schedules the next one; a timer, not a polling worker, does the waiting.

type AutomationInit = Omit<Automation, "nextAt" | "lastRunAt" | "lastSession">;

const timerId = (org: string, automation: string) => `automation:${org}:${automation}`;

export function saveAutomation(ctx: MutationContext, init: AutomationInit): Automation {
  parseCron(init.schedule);
  const previous = ctx.get(automations, [init.org, init.id]);
  const nextAt = init.enabled ? nextRun(init.schedule, ctx.now(), init.offsetMinutes) : null;
  const saved: Automation = { ...init, nextAt, lastRunAt: previous?.lastRunAt ?? null, lastSession: previous?.lastSession ?? null };
  ctx.set(automations, [init.org, init.id], saved);
  if (nextAt === null) timers.cancel(ctx, timerId(init.org, init.id));
  else timers.at(ctx, timerId(init.org, init.id), nextAt, "automationDue", { org: init.org, automation: init.id, at: nextAt });
  return saved;
}

export function removeAutomation(ctx: MutationContext, org: string, automation: string): void {
  ctx.delete(automations, [org, automation]);
  timers.cancel(ctx, timerId(org, automation));
}

export function listAutomations(ctx: QueryContext, org: string): Automation[] {
  return ctx.query(automations.by("byOrg").eq(org)).sort((a, b) => (a.id < b.id ? -1 : 1));
}

function startRun(tx: Tx, automation: Automation, sessionId: string, author: string | null): void {
  const session = newSession(tx, {
    id: sessionId,
    org: automation.org,
    createdBy: automation.createdBy,
    computer: automation.computer,
    ...(automation.model ? { model: automation.model } : {}),
  });
  session.title = automation.name;
  receive(tx, session, { id: `${sessionId}:prompt`, text: automation.prompt, steer: false, at: tx.ctx.now(), attachments: [], author, result: null });
}

/** Start the run due at `at`, then schedule the next one. */
export function runAutomation(ctx: MutationContext, org: string, automationId: string, at: number) {
  const automation = ctx.get(automations, [org, automationId]);
  if (automation === null || !automation.enabled || automation.nextAt !== at) return null;
  const tx = new Tx(ctx);
  const sessionId = `${automationId}-${at}`.slice(0, 128);
  if (tx.find(sessionId) === null) startRun(tx, automation, sessionId, null);
  tx.commit();
  const nextAt = nextRun(automation.schedule, Math.max(ctx.now(), at), automation.offsetMinutes);
  ctx.set(automations, [org, automationId], { ...automation, nextAt, lastRunAt: at, lastSession: sessionId });
  timers.at(ctx, timerId(org, automationId), nextAt, "automationDue", { org, automation: automationId, at: nextAt });
  return null;
}

export const setAutomation = mutation("automation.set", {
  args: v.object({
    id,
    name: v.string({ min: 1, max: 200 }),
    schedule: v.string({ min: 1, max: 200 }),
    offsetMinutes: v.optional(v.int({ min: -1_080, max: 1_080 })),
    prompt: v.string({ min: 1, max: 100_000 }),
    model: v.optional(v.nullable(v.string({ min: 1, max: 128 }))),
    computer: v.optional(v.nullable(id)),
    enabled: v.optional(v.boolean()),
  }),
  access: userAccess,
}, (ctx, args) => {
  const who = caller(ctx);
  const previous = ctx.get(automations, [who.org!, args.id]);
  return saveAutomation(ctx, {
    org: who.org!,
    id: args.id,
    name: args.name,
    schedule: args.schedule,
    offsetMinutes: args.offsetMinutes ?? 0,
    prompt: args.prompt,
    model: args.model ?? null,
    computer: args.computer ?? null,
    enabled: args.enabled ?? true,
    createdBy: previous?.createdBy ?? who.subject,
  });
});

export const deleteAutomation = mutation("automation.delete", { args: v.object({ id }), access: userAccess }, (ctx, args) => {
  const who = caller(ctx);
  if (ctx.get(automations, [who.org!, args.id]) === null) fail("AUTOMATION_NOT_FOUND", `No automation ${args.id}`);
  removeAutomation(ctx, who.org!, args.id);
  return null;
});

export const listAutomationsMethod = query("automation.list", { access: userAccess }, (ctx) => listAutomations(ctx, caller(ctx).org!));

/** Run now, outside the schedule. */
export const runAutomationNow = mutation("automation.run", { args: v.object({ id }), access: userAccess }, (ctx, args) => {
  const who = caller(ctx);
  const automation = ctx.get(automations, [who.org!, args.id]) ?? fail("AUTOMATION_NOT_FOUND", `No automation ${args.id}`);
  const tx = new Tx(ctx);
  const sessionId = `${args.id}-manual-${ctx.now()}`.slice(0, 128);
  startRun(tx, { ...automation, createdBy: who.subject }, sessionId, who.subject);
  tx.commit();
  ctx.set(automations, [who.org!, args.id], { ...automation, lastRunAt: ctx.now(), lastSession: sessionId });
  return { session: sessionId };
});
