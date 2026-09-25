import { fail, type Principal, type QueryContext } from "@flower-js/sdk";
import type { Role, Session } from "./model.ts";
import { members, sessions } from "./store.ts";

/**
 * Who is calling, from verified token claims. `org` is the organization the token acts in;
 * membership rows, not the claim, decide what a user may do there.
 */
export interface Caller { subject: string; role: Role; org: string | null; computer: string | null }

/** Tokens are Ed25519 JWTs from this issuer, for this audience. */
export const TOKEN_ISSUER = "trinity";
export const TOKEN_AUDIENCE = "trinity";

const ROLES: readonly Role[] = ["user", "worker", "computer", "service"];

export function callerOf(principal: Principal | null): Caller | null {
  if (principal === null) return null;
  const claims = (principal.claims ?? {}) as Record<string, unknown>;
  const role = claims.role;
  if (typeof role !== "string" || !ROLES.includes(role as Role)) return null;
  return {
    subject: principal.subject,
    role: role as Role,
    org: typeof claims.org === "string" ? claims.org : null,
    computer: typeof claims.computer === "string" ? claims.computer : null,
  };
}

export function caller(ctx: QueryContext): Caller {
  const found = callerOf(ctx.principal());
  if (found === null) fail("UNAUTHENTICATED", "Sign in first");
  return found;
}

export function membership(ctx: QueryContext, org: string, subject: string) {
  return ctx.get(members, [org, subject]);
}

/** A user of the token's organization, and an admin when asked. */
export function userIn(ctx: QueryContext, principal: Principal | null, admin = false): boolean {
  const who = callerOf(principal);
  if (who?.role !== "user" || who.org === null) return false;
  const member = membership(ctx, who.org, who.subject);
  return member !== null && (!admin || member.role === "admin");
}

export function canSee(ctx: QueryContext, who: Caller, session: Session): boolean {
  if (who.role === "worker") return true;
  if (who.org !== session.org) return false;
  if (who.role === "service") return true;
  if (who.role !== "user" || membership(ctx, session.org, who.subject) === null) return false;
  return !session.private || session.createdBy === who.subject;
}

/** Users of a session's organization (only its creator for a private session), and services acting for it. */
export function sessionAccess(ctx: QueryContext, principal: Principal | null, args: { session: string }): boolean {
  const who = callerOf(principal);
  if (who === null || who.role === "worker" || who.role === "computer") return false;
  const session = ctx.get(sessions, args.session);
  // A missing session is reported by the method itself.
  return session === null || canSee(ctx, who, session);
}

export const workerAccess = (_ctx: QueryContext, principal: Principal | null) => callerOf(principal)?.role === "worker";
export const serviceAccess = (_ctx: QueryContext, principal: Principal | null) => callerOf(principal)?.role === "service";
export const userAccess = (ctx: QueryContext, principal: Principal | null) => userIn(ctx, principal);
export const adminAccess = (ctx: QueryContext, principal: Principal | null) => userIn(ctx, principal, true);
/** Any signed-in user, member of an organization or not. */
export const signedIn = (_ctx: QueryContext, principal: Principal | null) => callerOf(principal)?.role === "user";

/** Workers claim any computer's tools; a computer claims only its own. */
export function scopeAccess(_ctx: QueryContext, principal: Principal | null, args: { scope: string }): boolean {
  const who = callerOf(principal);
  if (who?.role === "worker") return true;
  return who?.role === "computer" && who.computer !== null && args.scope === `computer:${who.computer}`;
}
