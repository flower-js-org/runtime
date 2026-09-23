# Read and write latency measurements

The current publication measures **56,154.7 successful customer calls/sec**, **12.9 ms read p99** and **228.3 ms write p99**. All eight independent audits passed, with zero failed customer calls and all 768 orders delivered.

[Charts, recovery, and every group](../docs/bench/latest.html) · [raw measurements](../docs/bench/latest.json) · [latency experiments and tracing](LATENCY.md) · [reproduction](README.md).

## Host and workload

Measured **2026-09-25T00:20:27.346Z–2026-09-25T00:21:27.487Z**, over **60.141 seconds**, including final in-flight customer tails. Apple M5 Pro, 18 logical CPUs, 48 GiB RAM, Darwin 27.2.0 arm64, Node.js v26.10.0. All 24 durable replicas, eight Rust drivers and eight Node controllers shared this desktop. Builds, tests and telemetry diagnostics ran outside uninstrumented measurement windows; ordinary desktop applications remained active.

Eight independent three-node Raft groups each ran **256 closed-loop customer loops**, four delivery workers, two tenants with four stores each, a 96-order cap, one second of warmup and 60 seconds of load. Each leader was killed halfway through. About 70% of calls read replica-local committed snapshots over pooled HTTP/2 and may lag; 30% are durable mutations. Final audits use fresh reads. The application has no authorization hook.

Runtime settings: adaptive batching with a **50 ms preparation ceiling**, 1,024-request writer queue, 16 query/cache-probe slots, 16 shared preparation slots, one serial writer-preparation worker and two Tokio async workers per replica. OTEL was explicitly disabled. The ceiling is not an end-to-end latency bound.

## Recorded results

| Measurement | Current run |
| --- | ---: |
| Successful customer calls | 3,377,202 |
| Customer reads / writes | 2,362,869 / 1,014,333 |
| Customer goodput | 56,154.7/sec |
| Read p50 / p95 / p99 | 1.0 / 4.8 / 12.9 ms |
| Write p50 / p95 / p99 | 96.1 / 172.8 / 228.3 ms |
| Failed customer calls | 0 |
| Audited orders / pizzas | 768 / 1,916 |
| Exact receipt replays / stale-lease rejections | 101,757 / 107 |
| Estimated mean server cores | 8.39 |
| Per-server CPU sampling coverage | 95.5–99.1% |

Goodput excludes retries, worker traffic, replay probes, warmup and drain. Zero failed logical calls does not mean every HTTP attempt succeeded. Percentiles merge per-group histogram buckets. CPU counters include all server work; estimated mean cores extrapolate sampled intervals and do not establish instantaneous utilization or exact request CPU cost.

## Comparison with previous publications

| Measurement | Prior M5 Pro publication | Current M5 Pro run | Change |
| --- | ---: | ---: | ---: |
| Customer goodput | 89,127.3/sec | 56,154.7/sec | −37.0% |
| Read p99 | 69.2 ms | 12.9 ms | −81.4% |
| Write p99 | 491.2 ms | 228.3 ms | −53.5% |

The [previous M5 Pro publication](https://github.com/flower-js-org/runtime/blob/a49b549/docs/bench/latest.json) used 512 loops/group and a 200 ms ceiling. **Both concurrency and server implementation changed.** This comparison shows the chosen throughput/latency tradeoff, not an isolated engine speedup. [Matched runs](LATENCY.md) distinguish replication overlap, snapshot compression and offered concurrency, including runs that did not improve.

The earlier [M6 publication](https://github.com/flower-js-org/runtime/blob/17084fae8cdcb45d0c13fcbd08970355840710e9/docs/bench/latest.json) measured 58,784.8 calls/sec, 109.3 ms read p99 and 675.4 ms write p99 on an Apple M6 with 12 logical CPUs and Darwin 27.0.0. Hardware, OS, executable and now scheduling settings differ. These are individual observations, not a controlled hardware comparison.

## Implementation, tracing and reproduction

The server overlaps Raft replication with the leader's durable log flush and uses **redb application tables as the durable recovery source**. Periodic snapshots flush a small metadata checkpoint; they no longer serialize or persist another full state image. Transfer images are encoded lazily when a replica needs one, and installation remains atomic and immediately durable. Application indices, materialized values, receipts and partitions stay in the logical state. Prior snapshot formats remain readable and are retired atomically on checkpoint. [The latency investigation](LATENCY.md) records the intermediate compression experiment, matched controls, power-loss tests and measured storage stages.

The [earlier CPU study](CPU.md) remains a separate experiment. [OpenTelemetry reporting](../TELEMETRY.md) covers ingress, query, writer, evaluator, storage and Raft stages, including metadata checkpoint and on-demand snapshot transfer costs. Instrumented runs are diagnostic, not capacity measurements.

```sh
nix develop
npm ci
cargo build --release --locked --bin flower --bin flower-bench-driver
FLOWER_OTEL_ENABLED=0 OTEL_SDK_DISABLED=true npm run bench:stress
node scripts/publish-bench-results.mjs bench/results/latest.json
node scripts/publish-bench-results.mjs --check
```

Server SHA-256: `f9272bd6ccd6b252f6b16cb7e0582878fbc2d8d8936fb5a0fce8c2871a32292e`. Driver SHA-256: `1cf843cbf4e064d13a1d3597d9295c509325fee5c74b6eb2242ac7e98ece553d`. Bundle hash: `264f2718f2336ea92b850ec939282695609e4ac929a73006455bf212872473b0`. The raw report records exact runtime options, binary identities, faults, customer accounting and per-group audits. Validation details are in [LATENCY.md](LATENCY.md).

## Earlier capacity study

The following study predates this refresh. Its comparisons, profiles, validation counts, and references to the “latest” run or “current checkout” describe the earlier M5 Pro work, not the local run above. The public JSON and HTML now contain the new local measurement; the previous measurements remain in these tables.

The previously published stress run completed **62,815 successful customer calls/sec across eight independent Raft groups**, with **313.9 ms customer p99**, zero failed customer calls, and all eight independent audits passing. This is one measured run, not a maximum capacity claim or a single-group throughput figure.

### Measured configuration

The load ran on **2026-09-24, 16:48:35.142–16:49:35.347 UTC**, on an Apple M5 Pro with 18 logical CPUs, Darwin 27.2.0 arm64. All 24 durable replicas, eight Rust customer drivers, and eight Node controllers shared that host. Each group ran 512 customer loops, four delivery workers, two tenants with four stores each, and 96 retained orders. Every group's leader was killed halfway through.

The server used QuickJS-NG inside Wasmtime with static application initialization and fresh isolated callback heaps. Settings were adaptive batching, a **200 ms maximum preparation window**, a 1,024-request writer queue, 16 authorization/cache-probe slots, 16 shared preparation slots, and two Tokio async workers per replica. Writer preparation was serial for this conflicting hot-store workload; independent groups and reads remained parallel. These settings are recorded in the report and stress preset. General runtime defaults remain unchanged. The 200 ms ceiling does not bound request latency: requests can also queue, prepare dependencies, replicate, retry, or wait for maintenance.

Approximately 70% of customer calls read replica-local committed snapshots over pooled HTTP/2, spread across all replicas. Those reads may lag. The remaining 30% were durable mutations; final audits used fresh reads. The application has no authorization hook. Eight independent writers share the host; there is no cross-group transaction or global atomic snapshot in this workload.

| Measurement | Previous publication |
| --- | ---: |
| Successful customer calls | 3,781,777 |
| Reads / mutations | 2,646,220 / 1,135,557 |
| Aggregate customer goodput | 62,815.0/sec |
| Customer p50 / p95 / p99 | 2.9 / 226.0 / 313.9 ms |
| Read p99 / mutation p99 | 16.7 / 431.6 ms |
| Audited orders / pizzas | 768 / 1,914 |
| Exact receipt replays checked | 113,216 |
| Stale leases rejected | 106 |
| Failed customer calls | 0 |
| Serving-quorum recovery after leader crash | 573–791 ms |
| Restarted replica catch-up | 2.36–3.59 seconds |
| Per-group oven-lateness p95 | 495–703 ms |
| Per-group order-to-delivery p95 | 9.7–11.2 seconds |

Goodput excludes worker traffic, retries, explicit replay probes, warmup, and drain. Its denominator is the **60.205-second union of synchronized load intervals**, including final in-flight customer tails. Percentiles merge histogram buckets. Zero failed customer calls does not mean every HTTP attempt succeeded: failed attempts during elections were retried. Quorum recovery and restarted-replica catch-up are separate measurements.

Sampled load CPU averaged approximately **11.19 server cores**, **1.25 Rust driver cores**, and **0.40 Node controller cores**. These are sampled process CPU measurements with reported coverage gaps, not utilization measurements for every instant or evidence that idle cores can automatically accelerate an ordered writer. The capacity run had no concurrent build, test, or profiler work.

### What improved

Against the prior published 50,009.6/sec run, goodput rose **25.6%**, overall p99 fell **18.0%**, and mutation p99 fell **4.9%**. The workload, eight groups, 512 loops per group, durability guarantee, and 200 ms preparation ceiling stayed the same. Both implementation and writer speculation settings changed, so this comparison does not isolate one optimization. Mutation p99 remains substantially higher than the overall p99; the read-heavy mix must not hide that tail.

The changes reduce work around each isolated callback:

- Consecutive public mutations in a serial stretch share one blocking worker dispatch. Each method still samples its own clock, uses a fresh callback heap, checks the same guards, and retains its own rollback boundary, revision and retry receipt. This also applies during adaptive conflict cooldowns. Cancellation wakes pending evaluation waits; successor preparation does not delay predecessor acknowledgements.
- The SDK's canonical key encoder uses a protected native QuickJS helper for finite JSON scalars and ordinary dense arrays of scalars. It preserves the engine's escaping and number formatting, and falls back before invoking application code for unsupported shapes or modified intrinsics. Other JavaScript hosts retain the TypeScript implementation.
- Each pristine Wasm image reserves a 4 KiB input allocation. Small calls write into their own COW bytes without another guest allocator entry; larger inputs allocate normally. Native host replies also encode their fixed success envelope without constructing a temporary JSON map. Mutable Stores and callback heaps are never reused.

The existing quorum-durable Raft log and atomic deferred application checkpoint policy is unchanged. Fresh reads, startup recovery fences, snapshots and purge retain their existing guarantees. See [architecture and tradeoffs](ARCHITECTURE.md) and [the storage contract](../PROTOCOL.md).

The current checkout also avoids repeated failed Raft wrapper decodes through one field-presence scan, borrows scoped command buffers, and moves uniquely owned Rust patch values after releasing their private overlays. Terminal graph validation omits rollback copies that cannot be observed, while intermediate previews retain rollback. Guarded native host reads parse reply bytes directly, and disposable callbacks retain their final QuickJS string buffer until Store teardown. These additional mechanisms preserve validation, isolation and durability; the measurement above predates them and does not establish their performance effect.

### Tuning evidence and its limits

Exploratory 20-second runs without leader failures used the same final binary:

| Writer preparation | Loops per group | Goodput / sec | Customer p99 |
| --- | ---: | ---: | ---: |
| Adaptive speculation | 512 | 62,218 | 307.7 ms |
| Serial | 512 | 65,651 | 289.9 ms |
| Serial | 384 | 60,903 | 239.9 ms |

Short steady-state results overstate the full failure run. A separate 60-second run with serial preparation and 448 loops reached **58,128/sec and 317.0 ms p99**, passing every audit. The final 512-loop run was better on both measures, so the stress preset keeps 512. These are individual observations, not a statistical bound or evidence that more concurrency always helps. All exploratory artifacts stayed outside the retained results directory.

Bounded debug traces compared the earlier 512-loop adaptive configuration with the optimized 448-loop serial configuration. Mean hot-mutation evaluation, including its dispatch wrapper, fell from approximately **519 to 342 µs**; evaluator-internal wall time fell from **421 to 331 µs**. The new serial-worker counters showed roughly **178 requests per blocking job**. Mean group preparation was 60 ms and durable commit was 31 ms in the optimized trace. Preparation and predecessor commit overlap; these timings cannot be added as CPU percentages. The runs differed in configuration, tracing perturbed execution, and bounded buffers dropped records, so these numbers locate costs rather than establish isolated speedups.

Validation passed 473 Rust tests, 325 JS/TS tests and typechecking, strict Clippy, SDK package/consumer checks, native guest ABI/differential checks, and Rust-driver, replica-read and SSE integration tests. Focused tests cover canonical encoding and observable fallback behavior, COW buffer boundaries and isolation, FIFO/CAS/receipts, rollback after method failure, one-slot admission, cancellation, and prompt durable replies.

### Remaining limits

The hot-store workload makes each group's mutation work largely serial. Native canonical encoding and fewer scheduler/allocator crossings reduce that cost but do not remove QuickJS execution, reactive recomputation, host serialization, Raft ordering, or disk/quorum latency. Durable commits account for a larger share of the remaining critical path. Parallel speculative preparation remains available for independent writes; forcing it off is a workload-specific choice. Larger queues or batching windows can worsen tails and timer lateness without adding goodput.

The order population is bounded and the dataset is hot. After reaching the order cap, traffic is mostly repeated shop previews and tips; it is not an indefinitely growing order stream. Application state remains in memory as well as durable storage. Dataset growth, many distinct queries or watches, large values, crypto-heavy authorization, index backfills, and transactions across groups need separate measurements. Applications with authorization hooks and managed-key queries take the full admitted path; this run does not measure their cost. Local co-location also does not model network or disk isolation across production machines.

This closed-loop run reduces arrivals when service slows. It does not establish sustainable service under a fixed offered arrival rate or provide an overload latency guarantee. Use `--offered-rate` and inspect driver drops as well as latency. Repeat matched runs on a quiet host before attributing a difference to a code change. [Architecture notes](ARCHITECTURE.md) and the [capacity controls](LIMITS.md) describe the implementation tradeoffs.

The measured server SHA-256 is `a3395d8f2d2533b4fc47dbe741412d86c6812bee6f9298ca58f130db3b6f07f2`; the Rust driver SHA-256 is `4f2cccb7ae1b58b877cbf69d416d4648351746a1eb39d9b596e12c97f5738839`. Rebuilding the current checkout may produce a different binary; retain those identities when comparing results.
