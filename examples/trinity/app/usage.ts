import type { QueryContext } from "@flower-js/sdk";
import { monthOf } from "./calendar.ts";
import type { Session, Usage } from "./model.ts";
import { costNanos } from "./pricing.ts";
import { billing, orgs, spend, usage } from "./store.ts";
import type { Tx } from "./tx.ts";

/** Price one completion by the model that served it, count it, and queue its meter event. Returns its cost. */
export function recordUsage(tx: Tx, session: Session, step: number, model: string, used: Usage): number {
  const { ctx } = tx;
  const cost = costNanos(model, used);
  const month = monthOf(ctx.now());
  ctx.set(usage, [session.org, month, session.id, step], { org: session.org, month, session: session.id, step, model, ...used, costNanos: cost, at: ctx.now() });
  session.usage = {
    input: session.usage.input + used.input,
    output: session.usage.output + used.output,
    cacheRead: session.usage.cacheRead + used.cacheRead,
    cacheWrite: session.usage.cacheWrite + used.cacheWrite,
  };
  session.costNanos += cost;

  const settings = ctx.get(orgs, session.org)?.settings;
  if (settings?.stripeCustomer && cost > 0) {
    const identifier = `${session.id}:${step}`;
    billing.enqueue(ctx, identifier, {
      org: session.org,
      customer: settings.stripeCustomer,
      meter: settings.stripeMeter,
      value: Math.max(1, Math.round(cost / 1_000)),
      identifier,
      at: ctx.now(),
    });
  }
  return cost;
}

/** Whether the organization may start another completion this month. */
export function withinBudget(ctx: QueryContext, org: string): boolean {
  const budget = ctx.get(orgs, org)?.settings.budgetNanos ?? null;
  return budget === null || ctx.get(spend, [org, monthOf(ctx.now())]).costNanos < budget;
}
