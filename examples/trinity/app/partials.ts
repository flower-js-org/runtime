import type { MutationContext, QueryContext } from "@flower-js/sdk";
import type { Delta } from "./model.ts";
import { partialHeads, partials } from "./store.ts";

// While a completion streams, its worker stores deltas one flush per row, so each write
// carries only its own bytes. The head row says which step and attempt the rows belong to.

/** The streamed deltas of `step`, or null when nothing of that step was stored. */
export function partialDeltas(ctx: QueryContext, session: string, step: number): Delta[] | null {
  const head = ctx.get(partialHeads, session);
  if (head === null || head.step !== step) return null;
  const deltas: Delta[] = [];
  let after: string | undefined;
  do {
    const page = ctx.range(partials.by("bySession").range({ prefix: [session], limit: 256, ...(after === undefined ? {} : { after }) }));
    for (const row of page.rows) deltas.push(...row.value.deltas);
    after = page.cursor ?? undefined;
  } while (after !== undefined);
  return deltas;
}

/** The streamed text blocks of `step`, in order. */
export function partialText(ctx: QueryContext, session: string, step: number): string[] {
  const blocks = new Map<number, string>();
  for (const delta of partialDeltas(ctx, session, step) ?? []) {
    if (delta.type === "text") blocks.set(delta.index, (blocks.get(delta.index) ?? "") + delta.text);
  }
  return [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text)
    .filter((text) => text.length > 0);
}

export function appendPartial(ctx: MutationContext, session: string, step: number, token: number, deltas: Delta[]): void {
  let head = ctx.get(partialHeads, session);
  // A new attempt starts over: what an earlier attempt streamed belongs to no response.
  if (head === null || head.step !== step || head.token !== token) {
    clearPartial(ctx, session);
    head = { step, token, next: 0 };
  }
  ctx.set(partials, [session, head.next], { session, n: head.next, deltas });
  ctx.set(partialHeads, session, { ...head, next: head.next + 1 });
}

export function clearPartial(ctx: MutationContext, session: string): void {
  if (ctx.get(partialHeads, session) === null) return;
  for (;;) {
    const { rows } = ctx.range(partials.by("bySession").range({ prefix: [session], limit: 256 }));
    if (rows.length === 0) break;
    for (const row of rows) ctx.delete(partials, row.key);
  }
  ctx.delete(partialHeads, session);
}
