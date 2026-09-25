import type { MutationContext } from "@flower-js/sdk";
import type { Body, Session, Status } from "./model.ts";
import { events } from "./store.ts";

/** Append to the session's log and return the entry's sequence number. The session row, saved by the caller, carries it. */
export function append(ctx: MutationContext, session: Session, body: Body): number {
  session.seq += 1;
  ctx.set(events, [session.id, session.seq], { session: session.id, seq: session.seq, at: ctx.now(), body });
  return session.seq;
}

export function setStatus(ctx: MutationContext, session: Session, status: Status): void {
  if (session.status === status) return;
  session.status = status;
  append(ctx, session, { type: "status", status });
}
