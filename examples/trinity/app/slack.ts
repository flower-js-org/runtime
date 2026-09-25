import { fail, mutation, query, v, type QueryContext } from "@flower-js/sdk";
import { adminAccess, caller, canSee, membership, serviceAccess, userAccess, workerAccess } from "./access.ts";
import { advance, halt } from "./loop.ts";
import { attachmentSchema, id } from "./model.ts";
import { decide } from "./sessions.ts";
import { bindings, slackInstalls, slackLinks, slackMessages, type SlackInstall } from "./store.ts";
import { bindCard, receiveOnThread } from "./surfaces.ts";
import { Tx } from "./tx.ts";

// Slack workspaces connected to organizations, Slack people linked to members, and the
// entry points of the Slack worker, which holds the Socket Mode connection. People act as
// the member they linked; someone nobody linked is asked to connect their account first.
// What the worker posts comes from the outbound queue's "slack" scope.

const threadOf = (team: string, channel: string, thread: string) => `${team}/${channel}/${thread}`;

/** The link Slack gives a thread's first message. */
function permalink(workspace: string, channel: string, ts: string): string {
  return `${workspace.replace(/\/?$/, "/")}archives/${channel}/p${ts.replace(".", "")}`;
}

/** The member a Slack user acts as, or null when nobody linked them (or they left the organization). */
function memberFor(ctx: QueryContext, install: SlackInstall, user: string): string | null {
  const link = ctx.get(slackLinks, [install.team, user]);
  if (link === null || link.org !== install.org || membership(ctx, install.org, link.subject) === null) return null;
  return link.subject;
}

const slackId = v.string({ min: 1, max: 64 });

// Connecting workspaces and people. The gateway verifies who asks, then calls these.

export const installSlack = mutation("slack.install", {
  args: v.object({
    org: id, team: slackId, name: v.string({ min: 1, max: 200 }), url: v.string({ min: 1, max: 512 }),
    botUser: slackId, botId: slackId, token: v.string({ min: 1, max: 4_096 }), installedBy: v.string({ min: 1, max: 256 }),
  }),
  access: serviceAccess,
}, (ctx, args) => {
  if (membership(ctx, args.org, args.installedBy)?.role !== "admin") fail("FORBIDDEN", "Only an organization's admins connect Slack workspaces");
  const existing = ctx.get(slackInstalls, args.team);
  if (existing !== null && existing.org !== args.org) fail("SLACK_TEAM_TAKEN", `${args.name} is connected to another organization`);
  ctx.set(slackInstalls, args.team, { ...args, installedAt: ctx.now() });
  return { team: args.team, name: args.name, org: args.org };
});

export const uninstallSlack = mutation("slack.uninstall", { args: v.object({ team: slackId }), access: adminAccess }, (ctx, args) => {
  if (ctx.get(slackInstalls, args.team)?.org !== caller(ctx).org) fail("NOT_FOUND", "No such Slack workspace in this organization");
  ctx.delete(slackInstalls, args.team);
  return null;
});

export const linkSlack = mutation("slack.link", {
  args: v.object({ team: slackId, user: slackId, org: id, subject: v.string({ min: 1, max: 256 }) }),
  access: serviceAccess,
}, (ctx, args) => {
  const install = ctx.get(slackInstalls, args.team) ?? fail("SLACK_NOT_CONNECTED", "This Slack workspace is not connected to Trinity");
  if (install.org !== args.org) fail("WRONG_ORG", `This Slack workspace belongs to organization ${install.org}; switch to it and try again`);
  if (membership(ctx, args.org, args.subject) === null) fail("FORBIDDEN", "Only members link Slack accounts");
  ctx.set(slackLinks, [args.team, args.user], { ...args, linkedAt: ctx.now() });
  return { workspace: install.name };
});

export const unlinkSlack = mutation("slack.unlink", { args: v.object({ team: slackId }), access: userAccess }, (ctx, args) => {
  const who = caller(ctx);
  for (const link of ctx.query(slackLinks.by("bySubject").eq([who.org!, who.subject]))) {
    if (link.team === args.team) ctx.delete(slackLinks, [link.team, link.user]);
  }
  return null;
});

/** The organization's workspaces, and the caller's own Slack accounts. */
export const slackStatus = query("slack.status", { access: userAccess }, (ctx) => {
  const who = caller(ctx);
  return {
    workspaces: ctx.query(slackInstalls.by("byOrg").eq(who.org!))
      .map(({ team, name, url, installedBy, installedAt }) => ({ team, name, url, installedBy, installedAt })),
    linked: ctx.query(slackLinks.by("bySubject").eq([who.org!, who.subject])).map(({ team, user }) => ({ team, user })),
  };
});

// The worker's view

/** Every connected workspace, with its sealed bot token. */
export const slackInstallations = query("slack.installations", { access: workerAccess }, (ctx) =>
  ctx.scan(slackInstalls).map((row) => row.value));

/** Whom a Slack user acts as, for the App Home tab. */
export const slackWhois = query("slack.whois", { args: v.object({ team: slackId, user: slackId }), access: serviceAccess }, (ctx, args) => {
  const install = ctx.get(slackInstalls, args.team);
  return install === null ? null : { org: install.org, member: memberFor(ctx, install, args.user) };
});

/**
 * A message in a channel, group or direct message where the bot is. Mentions and direct
 * messages reach the thread's session, starting one on the thread's first message. Replies in
 * a bound thread that do not mention the bot are left alone, and their author is nudged once.
 * The worker passes the message's timestamp, which it also uses as the request ID.
 */
export const receiveSlack = mutation("slack.receive", {
  args: v.object({
    team: slackId, channel: slackId, thread: slackId, ts: slackId, user: slackId,
    text: v.string({ min: 1, max: 1_000_000 }),
    dm: v.boolean(),
    mentioned: v.boolean(),
    label: v.optional(v.string({ max: 200 })),
    attachments: v.optional(v.array(attachmentSchema, { max: 20 })),
  }),
  access: serviceAccess,
}, (ctx, args) => {
  const install = ctx.get(slackInstalls, args.team);
  if (install === null) return { outcome: "unknown" as const };
  const thread = threadOf(args.team, args.channel, args.thread);
  const binding = ctx.get(bindings, ["slack", thread]);

  if (!args.dm && !args.mentioned) {
    if (binding === null || binding.nudged?.includes(args.user)) return { outcome: "ignored" as const };
    ctx.set(bindings, ["slack", thread], { ...binding, nudged: [...binding.nudged ?? [], args.user] });
    return { outcome: "nudge" as const };
  }

  const subject = memberFor(ctx, install, args.user);
  if (subject === null) return { outcome: "link" as const };
  const tx = new Tx(ctx);
  const bound = binding === null ? null : tx.find(binding.session);
  if (bound !== null && !canSee(ctx, { subject, role: "user", org: install.org, computer: null }, bound)) return { outcome: "private" as const };
  const session = receiveOnThread(tx, {
    org: install.org,
    surface: "slack",
    thread,
    meta: { team: args.team, channel: args.channel, thread: args.thread },
    message: args.ts,
    author: subject,
    text: args.text,
    attachments: args.attachments ?? [],
    createdBy: subject,
    private: args.dm,
    url: permalink(install.url, args.channel, args.thread),
    ...(args.label === undefined ? {} : { label: args.label }),
  });
  ctx.set(slackMessages, [args.team, args.channel, args.ts], { thread });
  tx.commit();
  return { outcome: "received" as const, session: session.id, status: session.status };
});

/** The worker posted in a bound thread: reactions on the post find the session, and a prompt's card follows its call. */
export const slackPosted = mutation("slack.posted", {
  args: v.object({ team: slackId, channel: slackId, thread: slackId, ts: slackId, session: id, call: v.optional(v.string({ min: 1 })) }),
  access: workerAccess,
}, (ctx, args) => {
  ctx.set(slackMessages, [args.team, args.channel, args.ts], { thread: threadOf(args.team, args.channel, args.thread) });
  if (args.call === undefined) return null;
  const tx = new Tx(ctx);
  const session = tx.find(args.session);
  if (session !== null) bindCard(tx, session, args.call, args.ts);
  tx.commit();
  return null;
});

/** A stop sign on any message of a bound thread halts its session. Anyone in the workspace may. */
export const haltSlack = mutation("slack.halt", {
  args: v.object({ team: slackId, channel: slackId, ts: slackId, user: slackId }),
  access: serviceAccess,
}, (ctx, args) => {
  const thread = ctx.get(slackMessages, [args.team, args.channel, args.ts])?.thread ?? threadOf(args.team, args.channel, args.ts);
  const binding = ctx.get(bindings, ["slack", thread]);
  const tx = new Tx(ctx);
  const session = binding === null ? null : tx.find(binding.session);
  if (session === null) return { halted: false };
  const halted = halt(tx, session);
  advance(tx, session);
  tx.commit();
  return { halted, session: session.id };
});

/** A button or form on one of the thread's prompts, answered as the member the Slack user linked. */
export const resolveSlack = mutation("slack.resolve", {
  args: v.object({
    team: slackId, user: slackId, session: id, call: v.string({ min: 1 }),
    approve: v.optional(v.boolean()), answer: v.optional(v.string({ max: 100_000 })),
  }),
  access: serviceAccess,
}, (ctx, args) => {
  const install = ctx.get(slackInstalls, args.team);
  if (install === null) return { outcome: "unknown" as const };
  const subject = memberFor(ctx, install, args.user);
  if (subject === null) return { outcome: "link" as const };
  const tx = new Tx(ctx);
  const session = tx.find(args.session);
  if (session === null || !canSee(ctx, { subject, role: "user", org: install.org, computer: null }, session)) return { outcome: "forbidden" as const };
  if (session.turn?.calls[args.call]?.state !== "awaiting") return { outcome: "stale" as const };
  decide(tx, session, { call: args.call, approve: args.approve, answer: args.answer }, subject);
  tx.commit();
  return { outcome: "resolved" as const };
});
