import { fail, mutation, query, v, type MutationContext, type QueryContext } from "@flower-js/sdk";
import type { Claim } from "@flower-js/sdk/temporal";
import { caller, callerOf, userAccess, workerAccess } from "./access.ts";
import { claimOptions, leaseLost, leaseOf } from "./leases.ts";
import { id, lease, workerError } from "./model.ts";
import { computers, provision, type Computer, type ProvisionJob } from "./store.ts";
import { timers } from "./timers.ts";

// A computer runs a session's tools. Local computers are users' machines, online while they
// heartbeat. Sandboxes are containers the provisioner starts when a tool needs one and stops
// once nothing has needed it for a while.

const KEEP_ALIVE_MS = 30 * 60_000;
const ONLINE_MS = 60_000;

export function online(ctx: QueryContext, computer: Computer): boolean {
  if (computer.kind !== "local") return computer.state === "running";
  if (computer.lastSeenAt === null) return false;
  const until = computer.lastSeenAt + ONLINE_MS;
  ctx.changesAt(until);
  return ctx.clock() < until;
}

const view = (ctx: QueryContext, computer: Computer) => ({ ...computer, online: online(ctx, computer), scope: `computer:${computer.id}` });

function provisionJob(ctx: MutationContext, computer: Computer, action: ProvisionJob["action"]): void {
  provision.enqueue(ctx, `${computer.id}:${action}:${ctx.now()}`, { computer: computer.id, action, kind: "docker", image: computer.image });
}

/** A tool job needs this computer: keep a sandbox running, starting it when stopped. */
export function demandComputer(ctx: MutationContext, computerId: string): void {
  const computer = ctx.get(computers, computerId);
  if (computer === null || computer.kind !== "docker") return;
  const wanted: Computer = { ...computer, wantedUntil: Math.max(computer.wantedUntil, ctx.now() + KEEP_ALIVE_MS) };
  if (computer.state === "stopped" || computer.state === "stopping") {
    wanted.state = "starting";
    provisionJob(ctx, computer, "start");
  }
  ctx.set(computers, computer.id, wanted);
  timers.at(ctx, `computer-idle:${computer.id}`, wanted.wantedUntil, "computerIdle", { computer: computer.id });
}

export function idleComputer(ctx: MutationContext, computerId: string) {
  const computer = ctx.get(computers, computerId);
  if (computer === null || computer.kind !== "docker" || computer.state !== "running") return null;
  if (ctx.now() < computer.wantedUntil) {
    timers.at(ctx, `computer-idle:${computer.id}`, computer.wantedUntil, "computerIdle", { computer: computer.id });
    return null;
  }
  ctx.set(computers, computer.id, { ...computer, state: "stopping" });
  provisionJob(ctx, computer, "stop");
  return null;
}

function inCallersOrg(ctx: QueryContext, computerId: string): Computer {
  const computer = ctx.get(computers, computerId);
  if (computer === null || computer.org !== caller(ctx).org) fail("COMPUTER_NOT_FOUND", `No computer ${computerId}`);
  return computer;
}

export const registerComputer = mutation("computer.register", {
  args: v.object({ id, name: v.string({ min: 1, max: 200 }) }),
  access: userAccess,
}, (ctx, args) => {
  const who = caller(ctx);
  const existing = ctx.get(computers, args.id);
  if (existing !== null && (existing.org !== who.org || existing.owner !== who.subject)) {
    fail("COMPUTER_EXISTS", `Computer ${args.id} belongs to someone else`);
  }
  const computer: Computer = {
    ...(existing ?? {
      id: args.id, org: who.org!, owner: who.subject, kind: "local", image: null,
      state: "stopped", lastSeenAt: null, wantedUntil: 0, createdAt: ctx.now(),
    }),
    name: args.name,
  };
  ctx.set(computers, args.id, computer);
  return view(ctx, computer);
});

export const createSandbox = mutation("computer.createSandbox", {
  args: v.object({ id, name: v.string({ min: 1, max: 200 }), image: v.string({ min: 1, max: 512 }) }),
  access: userAccess,
}, (ctx, args) => {
  const who = caller(ctx);
  if (ctx.get(computers, args.id) !== null) fail("COMPUTER_EXISTS", `Computer ${args.id} already exists`);
  const computer: Computer = {
    id: args.id, org: who.org!, owner: who.subject, name: args.name, kind: "docker", image: args.image,
    state: "stopped", lastSeenAt: null, wantedUntil: 0, createdAt: ctx.now(),
  };
  ctx.set(computers, args.id, computer);
  return view(ctx, computer);
});

export const removeComputer = mutation("computer.remove", { args: v.object({ id }), access: userAccess }, (ctx, args) => {
  const computer = inCallersOrg(ctx, args.id);
  if (computer.kind === "docker" && computer.state !== "stopped") provisionJob(ctx, computer, "stop");
  timers.cancel(ctx, `computer-idle:${computer.id}`);
  ctx.delete(computers, computer.id);
  return null;
});

export const listComputers = query("computer.list", { access: userAccess }, (ctx) =>
  ctx.query(computers.by("byOrg").eq(caller(ctx).org!)).map((computer) => view(ctx, computer)));

/** Local computers heartbeat with their own computer token. */
export const heartbeat = mutation("computer.heartbeat", {
  args: v.object({ id }),
  access: (_ctx, principal, args: { id: string }) => callerOf(principal)?.computer === args.id,
}, (ctx, args) => {
  const computer = ctx.get(computers, args.id) ?? fail("COMPUTER_NOT_FOUND", `No computer ${args.id}`);
  ctx.set(computers, args.id, { ...computer, lastSeenAt: ctx.now() });
  return null;
});

/** The sandboxes the executor should serve. */
export const runningSandboxes = query("computer.running", { access: workerAccess }, (ctx) =>
  ctx.query(computers.by("byKindState").eq(["docker", "running"]))
    .map((computer) => ({ id: computer.id, image: computer.image, scope: `computer:${computer.id}` })));

export const claimProvision = mutation("provision.claim", {
  args: v.object({ owner: v.string({ min: 1 }), leaseMs: v.optional(v.int({ min: 1 })) }),
  access: workerAccess,
}, (ctx, args): Claim<ProvisionJob> | null => provision.claim(ctx, args.owner, claimOptions(args)));

/** The provider started or stopped the sandbox; the job and the computer's state change together. */
export const completeProvision = mutation("provision.complete", {
  args: v.object({ ...lease, result: v.json() }),
  access: workerAccess,
}, (ctx, args) => {
  const job = provision.get(ctx, args.id) ?? leaseLost();
  provision.complete(ctx, leaseOf(args), args.result);
  provision.cancel(ctx, args.id);
  const computer = ctx.get(computers, job.payload.computer);
  if (computer === null) return null;
  const stillWanted = job.payload.action === "stop" && computer.wantedUntil > ctx.now();
  if (stillWanted) {
    // Demand arrived while it stopped.
    ctx.set(computers, computer.id, { ...computer, state: "starting" });
    provisionJob(ctx, computer, "start");
  } else {
    ctx.set(computers, computer.id, { ...computer, state: job.payload.action === "start" ? "running" : "stopped" });
  }
  return null;
});

export const failProvision = mutation("provision.fail", {
  args: v.object({ ...lease, error: workerError }),
  access: workerAccess,
}, (ctx, args) => {
  const after = provision.fail(ctx, leaseOf(args), { message: args.error.message });
  if (after.state !== "failed") return null;
  provision.cancel(ctx, args.id);
  const computer = ctx.get(computers, after.payload.computer);
  if (computer !== null) ctx.set(computers, computer.id, { ...computer, state: after.payload.action === "start" ? "stopped" : "running" });
  return null;
});
