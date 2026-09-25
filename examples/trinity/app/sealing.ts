import { canonicalJson, fail, mutation, query, v, type MutationContext } from "@flower-js/sdk";
import { workerAccess } from "./access.ts";
import { leaseLost, leaseOf } from "./leases.ts";
import { checksum, id, lease, type Event, type Session } from "./model.ts";
import { blobRefs, events, sealing, segments } from "./store.ts";
import { Tx } from "./tx.ts";

// Sealing moves a range of a session's log into one blob, so live state holds only the
// history that requests still need. The events leave the database only once the stored
// copy has been checked against them.

/** One seal job per session at a time; a request during a running one is remembered and follows it. */
export function requestSeal(ctx: MutationContext, session: Session, through: number): void {
  if (through <= session.sealedThrough) return;
  const jobId = `${session.id}:seal`;
  const running = sealing.get(ctx, jobId);
  if (running?.state === "leased") {
    session.sealWanted = Math.max(session.sealWanted, through);
    return;
  }
  if (running !== null) sealing.cancel(ctx, jobId);
  sealing.enqueue(ctx, jobId, { session: session.id, from: session.sealedThrough + 1, to: Math.max(through, session.sealWanted) });
  session.sealWanted = 0;
}

function eventsBetween(ctx: MutationContext, session: string, from: number, to: number): Event[] {
  const found: Event[] = [];
  for (let next = from; next <= to;) {
    const { rows } = ctx.range(events.by("bySession").range({ prefix: [session], gte: next, lte: to, limit: 1_000 }));
    if (rows.length === 0) break;
    for (const row of rows) found.push(row.value);
    next = rows.at(-1)!.value.seq + 1;
  }
  return found;
}

/** A page of the log, for the sealing worker. */
export const readEvents = query("session.events", {
  args: v.object({ session: id, from: v.int({ min: 1 }), to: v.int({ min: 1 }), limit: v.optional(v.int({ min: 1, max: 2_000 })) }),
  access: workerAccess,
}, (ctx, args) => ctx.range(events.by("bySession").range({ prefix: [args.session], gte: args.from, lte: args.to, limit: args.limit ?? 1_000 }))
  .rows.map((row) => row.value));

export const completeSeal = mutation("sealing.complete", {
  args: v.object({
    ...lease,
    result: v.object({ key: v.string({ pattern: /^sha256\/[0-9a-f]{64}$/ }), count: v.int({ min: 0 }), checksum: v.string() }),
  }),
  access: workerAccess,
}, (ctx, args) => {
  const job = sealing.get(ctx, args.id) ?? leaseLost();
  sealing.complete(ctx, leaseOf(args), args.result);
  sealing.cancel(ctx, args.id);

  const tx = new Tx(ctx);
  const session = tx.find(job.payload.session);
  if (session === null || job.payload.from !== session.sealedThrough + 1) return { sealed: false };
  const sealed = eventsBetween(ctx, session.id, job.payload.from, job.payload.to);
  if (sealed.length !== args.result.count || checksum(canonicalJson(sealed)) !== args.result.checksum) {
    fail("SEAL_MISMATCH", "The stored segment does not match the log");
  }

  for (const event of sealed) ctx.delete(events, [session.id, event.seq]);
  ctx.set(segments, [session.id, job.payload.from], { session: session.id, from: job.payload.from, to: job.payload.to, key: args.result.key, count: sealed.length });
  ctx.set(blobRefs, [session.id, args.result.key], { session: session.id, key: args.result.key });
  session.sealedThrough = job.payload.to;
  if (session.sealWanted > session.sealedThrough) requestSeal(ctx, session, session.sealWanted);
  tx.commit();
  return { sealed: true };
});
