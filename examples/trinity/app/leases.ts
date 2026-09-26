import { fail } from "@flower-js/sdk";
import type { LeaseIdentity } from "@flower-js/sdk/temporal";

/** The lease fields of a worker's report, without the rest of its arguments. */
export function leaseOf(args: LeaseIdentity): LeaseIdentity {
  return { id: args.id, owner: args.owner, token: args.token, ...(args.history ? { history: args.history } : {}) };
}

export function leaseLost(): never {
  return fail("LEASE_LOST", "Job lease is missing, expired, or held by another claim");
}

/** Claim options with only what the caller asked for. */
export function claimOptions(args: { leaseMs?: number }): { leaseMs?: number } {
  return args.leaseMs === undefined ? {} : { leaseMs: args.leaseMs };
}
