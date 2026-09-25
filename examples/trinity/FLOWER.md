# What Trinity needs from Flower

Measured with `npm run bench` against `trinity sim` on one local node (2026-09-25, a shared 18-core Mac, fsync-bound). Ordered by what limits Trinity most.

## 1. Watches that wake only for their own data

Every commit costs work for every open watch, even watches on rows the commit never touched. The same 300 sessions × 5 turns:

| Extra idle watches on unrelated sessions | Completions/s | Session creation |
| --- | --- | --- |
| none | 165 | 2,377/s |
| 3,000 | 53 | 98/s |

With 10,000 people each watching their own session (`session.get`), Flower spent ~12 cores and the loop fell to ~14 completions/s; the same backlog drained at ~410/s once the watches closed. Idle watches with no commits cost nothing (2,000 of them: 0.1% CPU), so the cost is per commit × per watch. DESIGN.md already names the fix (dependency certificates, shared hubs): re-evaluate a watch only when a commit writes a key or range it read.

**Done when** the table's two rows match within noise, and 10,000 watched sessions sustain the no-watch throughput. To measure, with `dev --sim` running:

```sh
npm run bench -- --sessions 300 --turns 5 --think-ms 0 --ramp-s 1
npm run bench -- --sessions 300 --turns 5 --think-ms 0 --ramp-s 1 --idle-watches 3000
```

## 2. Writes that skip the durable log

Streamed deltas (`completions.progress`) are Trinity's most frequent mutation: about 20 per real completion at the LLM worker's 250 ms flush interval, so most of all commits. They need ordering, fencing and watch delivery, but not fsync, receipts, or survival across a leader change (a lost batch only makes a live view briefly stale; the complete message carries the full text). A volatile collection kind, replicated in memory and dropped on failover, or at least a per-method `receipts: false`, would remove most of Trinity's fsync load.

## 3. Claim several jobs, or wait for one, in one request

Workers watch `ready` and then claim one job per commit. Each `runQueueWorker` lane holds its own watch (which item 1 makes expensive), and a pool of 16 concurrent claimers topped out near 330 claims/s here. Wanted: `claim({ max, waitMs })` that returns up to `max` jobs in one commit and holds the request until work arrives, plus `complete` that can claim the next job in the same commit.

## 4. Many watches on one stream

A connection carries a bounded number of HTTP/2 streams (hyper's default is 200), and every watch holds one, so the bench spreads 10,000 watches over 101 connections, and a web client following many sessions opens many streams. A multiplexed watch endpoint (subscribe and unsubscribe queries on one SSE stream) would fix both.

## 5. Smaller items

- **JWT verification**: `jsonwebtoken::pem::decoder::classify_pem` shows up in profiles; `jwtBearer` could keep the parsed key.
- **Queue depth in `stats`**: counts of ready and leased jobs per scope, for the bench and for autoscaling workers.
- **Sealed secrets for workers**: rows whose values only principals with a given role can read, decrypted by the server. Trinity seals Slack bot tokens itself today, with a key derived from its signing key.
