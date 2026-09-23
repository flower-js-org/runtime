#!/usr/bin/env node
// The stress preset exercises independent durable Raft groups, pooled HTTP/2,
// local shop previews, fresh audits, and a leader crash in every group.
import { parseOptions } from "./config.mjs";
import { runGroups } from "./multi-group.mjs";
process.env.FLOWER_WRITER_BATCH_MODE ??= "adaptive";
process.env.FLOWER_WRITER_BATCH_MS ??= "50";
process.env.FLOWER_WRITER_QUEUE_CAPACITY ??= "1024";
// All 24 replicas share this host; each needs a small async I/O pool, while
// QuickJS preparation and storage run on their separate blocking workers.
process.env.TOKIO_WORKER_THREADS ??= "2";
process.env.FLOWER_QUERY_WORKERS ??= "16";
process.env.FLOWER_PREPARATION_WORKERS ??= "16";
// Repeated hot-store updates conflict; serial preparation avoids wasted waves.
// Other groups and replica reads still run in parallel.
process.env.FLOWER_WRITER_PREPARATION_WORKERS ??= "1";
const args = process.argv.slice(2);
const options = parseOptions([
  "--groups", "8", "--http2", "--duration", "60", "--concurrency", "256",
  "--workers", "4", "--max-orders", "96", "--chaos",
  ...args,
]);
if (!(await runGroups(options)).passed) process.exitCode = 1;
