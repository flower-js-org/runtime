import { fail, mutation, query, v, type QueryContext } from "@flower-js/sdk";
import { caller, userAccess } from "./access.ts";
import type { Session } from "./model.ts";
import { memories } from "./store.ts";

// Memory is a small set of documents per organization and per user that persists across
// sessions. Each scope's index.md is shown to the agent at the start of every turn.

const PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const INDEX_LIMIT = 8_000;

/** Memory files are addressed by relative paths without dot segments. */
export function memoryPath(path: string): string {
  const normalized = path.replace(/^\/+/, "");
  if (!PATH.test(normalized) || normalized.length > 256) fail("INVALID_PATH", `Invalid memory path ${JSON.stringify(path)}`);
  return normalized;
}

/** "org" is shared with the organization; anything else is private to the user a session works for. */
export function memoryScope(owner: Pick<Session, "createdBy">, scope: "org" | "user" | undefined): string {
  return scope === "org" ? "org" : `user:${owner.createdBy}`;
}

/** The index files a turn starts with, or null when there are none. */
export function memorySnapshot(ctx: QueryContext, session: Session): string | null {
  const scopes = [["Organization memory", "org"], ["Your memory for this user", `user:${session.createdBy}`]] as const;
  const parts = scopes.flatMap(([label, scope]) => {
    const index = ctx.get(memories, [session.org, scope, "index.md"]);
    return index === null || index.content.trim() === "" ? [] : [`## ${label}\n\n${index.content.slice(0, INDEX_LIMIT)}`];
  });
  return parts.length === 0 ? null : parts.join("\n\n");
}

const scopeArg = v.optional(v.enum(["org", "user"]));

function scopeOf(ctx: QueryContext, scope: "org" | "user" | undefined) {
  const who = caller(ctx);
  return { org: who.org!, scope: memoryScope({ createdBy: who.subject }, scope), subject: who.subject };
}

export const listMemory = query("memory.list", { args: v.object({ scope: scopeArg }), access: userAccess }, (ctx, args) => {
  const { org, scope } = scopeOf(ctx, args.scope);
  return ctx.query(memories.by("byScope").eq([org, scope]))
    .map(({ path, updatedAt, updatedBy, content }) => ({ path, updatedAt, updatedBy, size: content.length }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
});

export const readMemory = query("memory.read", { args: v.object({ path: v.string({ min: 1 }), scope: scopeArg }), access: userAccess }, (ctx, args) => {
  const { org, scope } = scopeOf(ctx, args.scope);
  return ctx.get(memories, [org, scope, memoryPath(args.path)]);
});

export const writeMemory = mutation("memory.write", {
  args: v.object({ path: v.string({ min: 1 }), content: v.string({ max: 100_000 }), scope: scopeArg }),
  access: userAccess,
}, (ctx, args) => {
  const { org, scope, subject } = scopeOf(ctx, args.scope);
  const path = memoryPath(args.path);
  ctx.set(memories, [org, scope, path], { org, scope, path, content: args.content, updatedAt: ctx.now(), updatedBy: subject });
  return null;
});

export const deleteMemory = mutation("memory.delete", { args: v.object({ path: v.string({ min: 1 }), scope: scopeArg }), access: userAccess }, (ctx, args) => {
  const { org, scope } = scopeOf(ctx, args.scope);
  ctx.delete(memories, [org, scope, memoryPath(args.path)]);
  return null;
});
