import { fail, mutation, query, v, type QueryContext } from "@flower-js/sdk";
import { adminAccess, caller, signedIn, userAccess } from "./access.ts";
import { monthOf } from "./calendar.ts";
import { id, type Member, type Org, type OrgSettings } from "./model.ts";
import { mcpCatalog, mcpServers, members, orgs, spend } from "./store.ts";

export const DEFAULT_SETTINGS: OrgSettings = {
  model: "claude-opus-5",
  computer: null,
  webTools: true,
  graceMs: 0,
  contextTokens: 200_000,
  budgetNanos: null,
  stripeCustomer: null,
  stripeMeter: "trinity_usage_microdollars",
};

const settingsPatch = v.object({
  model: v.optional(v.string({ min: 1, max: 128 })),
  computer: v.optional(v.nullable(id)),
  webTools: v.optional(v.boolean()),
  graceMs: v.optional(v.int({ min: 0, max: 600_000 })),
  contextTokens: v.optional(v.int({ min: 10_000, max: 900_000 })),
  budgetNanos: v.optional(v.nullable(v.int({ min: 0 }))),
  stripeCustomer: v.optional(v.nullable(v.string({ min: 1, max: 255 }))),
  stripeMeter: v.optional(v.string({ min: 1, max: 100 })),
});

const callersOrg = (ctx: QueryContext) => caller(ctx).org!;
const bySubject = (a: Member, b: Member) => (a.subject < b.subject ? -1 : 1);

// Organizations

export const createOrg = mutation("org.create", { args: v.object({ id, name: v.string({ min: 1, max: 200 }) }), access: signedIn }, (ctx, args): Org => {
  const who = caller(ctx);
  if (ctx.get(orgs, args.id) !== null) fail("ORG_EXISTS", `Organization ${args.id} already exists`);
  const org: Org = { id: args.id, name: args.name, createdAt: ctx.now(), createdBy: who.subject, settings: DEFAULT_SETTINGS };
  ctx.set(orgs, org.id, org);
  ctx.set(members, [org.id, who.subject], { org: org.id, subject: who.subject, role: "admin", name: null, joinedAt: ctx.now() });
  return org;
});

/** The caller's organizations, for choosing which one a token acts in. */
export const myOrgs = query("org.mine", { access: signedIn }, (ctx) =>
  ctx.query(members.by("bySubject").eq(caller(ctx).subject)).flatMap((member) => {
    const org = ctx.get(orgs, member.org);
    return org === null ? [] : [{ id: org.id, name: org.name, role: member.role }];
  }));

export const getOrg = query("org.get", { access: userAccess }, (ctx) => {
  const who = caller(ctx);
  return { org: ctx.get(orgs, who.org!)!, role: ctx.get(members, [who.org!, who.subject])!.role };
});

export const updateOrg = mutation("org.update", {
  args: v.object({ name: v.optional(v.string({ min: 1, max: 200 })), settings: v.optional(settingsPatch) }),
  access: adminAccess,
}, (ctx, args) => {
  const org = ctx.get(orgs, callersOrg(ctx))!;
  const updated: Org = { ...org, name: args.name ?? org.name, settings: { ...org.settings, ...args.settings } };
  ctx.set(orgs, org.id, updated);
  return updated;
});

// Members

export const listMembers = query("org.members", { access: userAccess }, (ctx) =>
  ctx.query(members.by("byOrg").eq(callersOrg(ctx))).sort(bySubject));

export const setMember = mutation("org.setMember", {
  args: v.object({ subject: v.string({ min: 1, max: 256 }), role: v.enum(["admin", "member"]), name: v.optional(v.nullable(v.string({ max: 200 }))) }),
  access: adminAccess,
}, (ctx, args) => {
  const org = callersOrg(ctx);
  const existing = ctx.get(members, [org, args.subject]);
  if (existing?.role === "admin" && args.role !== "admin") keepAnAdmin(ctx, org, args.subject);
  const member: Member = { org, subject: args.subject, role: args.role, name: args.name ?? existing?.name ?? null, joinedAt: existing?.joinedAt ?? ctx.now() };
  ctx.set(members, [org, args.subject], member);
  return member;
});

export const removeMember = mutation("org.removeMember", { args: v.object({ subject: v.string({ min: 1, max: 256 }) }), access: adminAccess }, (ctx, args) => {
  const org = callersOrg(ctx);
  if (ctx.get(members, [org, args.subject])?.role === "admin") keepAnAdmin(ctx, org, args.subject);
  ctx.delete(members, [org, args.subject]);
  return null;
});

function keepAnAdmin(ctx: QueryContext, org: string, leaving: string): void {
  const others = ctx.query(members.by("byOrg").eq(org)).filter((member) => member.role === "admin" && member.subject !== leaving);
  if (others.length === 0) fail("LAST_ADMIN", "An organization needs at least one admin");
}

// Usage

export const orgUsage = query("org.usage", { args: v.object({ month: v.optional(v.string({ pattern: /^\d{4}-\d{2}$/ })) }), access: userAccess }, (ctx, args) => {
  const org = ctx.get(orgs, callersOrg(ctx))!;
  const month = args.month ?? monthOf(ctx.now());
  return { month, ...ctx.get(spend, [org.id, month]), budgetNanos: org.settings.budgetNanos };
});

// MCP servers

export const listMcp = query("mcp.list", { access: userAccess }, (ctx) => {
  const org = callersOrg(ctx);
  return ctx.query(mcpServers.by("byOrg").eq(org)).map((server) => {
    const catalog = ctx.get(mcpCatalog, [org, server.name]);
    return { ...server, tools: catalog?.status === "ready" ? catalog.value.map((tool) => tool.name) : null };
  });
});

/** Header values may name secrets as ${secret:NAME}; workers resolve them, so secret values never enter the database. */
export const setMcp = mutation("mcp.set", {
  args: v.object({
    name: v.string({ min: 1, max: 40, pattern: /^[A-Za-z0-9_-]+$/ }),
    url: v.string({ min: 1, max: 2_048, pattern: /^https?:\/\// }),
    headers: v.optional(v.record(v.string({ max: 4_096 }))),
    trusted: v.optional(v.boolean()),
    enabled: v.optional(v.boolean()),
  }),
  access: adminAccess,
}, (ctx, args) => {
  const org = callersOrg(ctx);
  const server = { org, name: args.name, url: args.url, headers: args.headers ?? {}, trusted: args.trusted ?? false, enabled: args.enabled ?? true, updatedAt: ctx.now() };
  ctx.set(mcpServers, [org, args.name], server);
  return server;
});

export const removeMcp = mutation("mcp.remove", { args: v.object({ name: v.string({ min: 1, max: 40 }) }), access: adminAccess }, (ctx, args) => {
  ctx.delete(mcpServers, [callersOrg(ctx), args.name]);
  return null;
});
