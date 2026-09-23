import { define, mutation, query } from "../sdk/index.ts";
import type { Json } from "../sdk/index.ts";
import { expiringCollection, workQueue } from "../sdk/temporal.ts";
import type { Expiration, LeaseIdentity } from "../sdk/temporal.ts";

export const MAX_LEASE_MS = 30_000;
export const jobs = workQueue<Json, Json>("workerJobs", { maxLeaseMs: MAX_LEASE_MS, defaultLeaseMs: 1_000 });
export const cache = expiringCollection<Json>("workerCache", { expiration: { afterUpdateMs: 60_000 } });

export const enqueueJob = mutation("internal.jobs.enqueue", (ctx, args: { id: string; payload: Json; replaceFinished?: boolean }) =>
  jobs.enqueue(ctx, args.id, args.payload, { replaceFinished: args.replaceFinished }),
);
export const claimJob = mutation("internal.jobs.claim", (ctx, args: { owner: string; leaseMs?: number }) =>
  jobs.claim(ctx, args.owner, args.leaseMs),
);
export const completeJob = mutation("internal.jobs.complete", (ctx, args: LeaseIdentity & { result: Json }) =>
  jobs.complete(ctx, args, args.result),
);
export const failJob = mutation("internal.jobs.fail", (ctx, args: LeaseIdentity & { error: Json }) =>
  jobs.fail(ctx, args, args.error),
);
export const retryJob = mutation("internal.jobs.retry", (ctx, id: string) => jobs.retry(ctx, id));
export const getJob = query("internal.jobs.get", (ctx, id: string) => jobs.get(ctx, id));
// A watch is a wakeup hint; only claimJob grants ownership. Include expired
// leases so workers can wake without waiting for maintenance to reclaim them.
// Close the watch on true, drain claims to null, then open a fresh watch: its
// initial snapshot prevents a missed wakeup if false -> true was coalesced.
export const jobsReady = query("internal.jobs.ready", (ctx) =>
  ctx.range(jobs.records.by("pending").range({ prefix: ["", "pending"], limit: 1 })).rows.length > 0 ||
  ctx.range(jobs.records.by("leased").range({ prefix: ["", "leased"], lte: ctx.now(), limit: 1 })).rows.length > 0,
);

// Add workers when the oldest waiting job keeps getting older.
export const jobsBacklog = query("internal.jobs.backlog", (ctx) => {
  const oldest = ctx.range(jobs.records.by("pending").range({ prefix: ["", "pending"], limit: 1 })).rows[0];
  return { oldestWaitingSeconds: oldest ? Math.floor((ctx.now() - oldest.value.createdAt) / 1000) : 0 };
});

export const setCache = mutation("internal.cache.set", (ctx, args: { key: string; value: Json; expiration?: Expiration }) =>
  cache.set(ctx, args.key, args.value, args.expiration),
);
export const getCache = query("internal.cache.get", (ctx, key: string) => cache.get(ctx, key));
export const entryCache = query("internal.cache.entry", (ctx, key: string) => cache.entry(ctx, key));

// The leader invokes this privately. Correct expiration and lease ownership do
// not depend on its schedule: reads filter expiry and claims reclaim inline.
export const maintenance = mutation("internal.workers.maintenance", (ctx) => ({
  expiredKeys: cache.sweep(ctx),
  reclaimedLeases: jobs.sweep(ctx),
}));

export default define({
  collections: [jobs.records, cache.records],
  maintenance,
  http: {
    "jobs.enqueue": enqueueJob,
    "jobs.claim": claimJob,
    "jobs.complete": completeJob,
    "jobs.fail": failJob,
    "jobs.retry": retryJob,
    "jobs.get": getJob,
    "jobs.ready": jobsReady,
    "jobs.backlog": jobsBacklog,
    "cache.set": setCache,
    "cache.get": getCache,
    "cache.entry": entryCache,
  },
});
