# Application state footprint, 2026-09-25

Every replica holds its whole application state in memory as `Records`, and rebuilds it from redb at startup. Before choosing a disk-backed design ([DESIGN.md](../DESIGN.md) asks to measure representative state sizes first), this measures what that state costs in memory, what startup spends its time on, and what reading the same records from redb would cost.

## Workload and method

[`flower-footprint`](../src/bin/flower-footprint.rs) seeds [footprint.ts](footprint.ts) through the production evaluator, 500 orders per mutation. Each order has an order row, a customer row (215 bytes of JSON), and three order lines. The lines carry an equality index, which also stores an ordered entry per line. A derived subtotal reads the order's index bucket, and a total is materialized for each order. That is 14 keys and about 1.9 KB of JSON per order.

The binary then measures:

- **Heap**: live requested bytes, counted by a wrapper around mimalloc, the server's allocator. Allocator rounding and free pages are not included; the process footprint is reported separately in the raw results.
- **Representations** of the same records, each built from their stored JSON: keys only (`im::OrdMap<String, ()>`), keys and JSON text (`Arc<[u8]>`), keys and parsed values (`Arc<Value>`), and the production `Records`, which also derives the reactive graph metadata.
- **Startup**: a redb table with the production name and encoding, read back the way `load_or_migrate_application` reads application data. The file is written with `F_NOCACHE`, so the first scan reads the SSD; later passes hit the OS page cache.
- **Point reads**: 200,000 uniform random keys, after one untimed pass over the same keys. The SSD row reads 20,000 keys through a 16 MiB redb cache on an `F_NOCACHE` file, before anything is cached.
- **Mutations**: the mean of 20 independent single-order creations, single-line updates and single-order deletions against the seeded state.

```sh
node -e 'import("./sdk/bundle.ts").then(async ({buildBundle}) => {
  const fs = await import("node:fs");
  fs.mkdirSync("target/footprint", {recursive: true});
  fs.writeFileSync("target/footprint/footprint.js", (await buildBundle("bench/footprint.ts")).javascript);
})'
nix develop -c cargo build --release --bin flower-footprint
FLOWER_RUST_MEMORY_BYTES=34359738368 target/release/flower-footprint \
  --bundle target/footprint/footprint.js --orders 100000 --dir target/footprint
```

The raised budget is needed beyond about 40,000 orders (see below). `--breakdown` attributes the graph metadata to key classes instead of timing storage. `--profile SECONDS` samples single-row mutations with macOS `sample`.

Apple M5 Pro, 18 logical CPUs, 48 GiB, Darwin 27.2.0; release build of main at 66349bc plus this harness. One run per size. Heap bytes are deterministic; times are single samples. Raw reports are in [footprint-results](footprint-results).

## Memory

Bytes per order:

| | 10,000 orders | 100,000 | 300,000 |
| --- | ---: | ---: | ---: |
| JSON text, keys and values | 1,843 | 1,897 | 1,940 |
| redb file | 3,369 | 2,695 | 3,593 |
| Heap: keys only | 1,771 | 1,809 | 1,837 |
| Heap: keys and JSON text | 3,482 | 3,533 | 3,563 |
| Heap: keys and parsed values | 10,698 | 10,752 | 10,795 |
| Heap: production `Records` | 25,461 | 24,654 | 25,541 |
| Added by the first mutation after loading | 768 | 730 | 757 |

The cost per order does not change with size. Serving state takes about 13 times its JSON text and 7–9 times its redb file. On this workload a replica needs 26 KB of heap per order, so 32 GiB holds about 1.3 million orders, or 2.5 GB of JSON.

**The graph metadata is the largest part.** `Records` minus a plain map of the same parsed values is 14.7 KB per order, more than the parsed values themselves. Adding key classes one at a time (10,000 orders) attributes it:

| Keys included | Metadata per order |
| --- | ---: |
| Source rows | 9 |
| + index and ordered entries | 439 |
| + materialized roots | 796 |
| + derived cells | 14,745 |

Each derived cell costs about 7 KB. The reverse-edge map keeps one `im::HashSet` of readers per dependency target ([metadata.rs](../src/evaluator/rust_engine/metadata.rs)), and here almost every target has one reader: each order's two cells depend on six targets. A one-member `im::HashSet<String>` takes 1,166 bytes of heap, against 102 for a one-element boxed slice. The first mutation after loading adds the graph's reachability proof, another 750 bytes per order.

**Parsed values take 5 times the heap of their JSON text.** Keys and `Arc<Value>` take 9 KB per order more than keys alone; keys and `Arc<[u8]>` take 1.7 KB more. serde_json stores every object as a `BTreeMap`, so even a small object allocates a whole node.

**Keys alone are not small.** A key-only `im::OrdMap` takes 131 bytes per key, for keys averaging 61 bytes. An in-memory key index would still cap a 32 GiB replica at about 250 million keys.

**Retry receipts** take 1,581 bytes of heap each, against 236 bytes encoded. With indefinite retention they grow with every request, independently of the data.

## Startup

| | 10,000 orders | 100,000 | 300,000 |
| --- | ---: | ---: | ---: |
| Scan, SSD | 69 ms | 610 ms | 2,190 ms |
| Scan and parse, page cache | 28 ms | 284 ms | 850 ms |
| Load into `Records`, page cache | 257 ms | 3,229 ms | 10,511 ms |
| First mutation after loading | 20 ms | 227 ms | 777 ms |

A warm load takes 32–35 µs per order, of which reading and parsing the JSON is under 3 µs; building `Records` is the other 92%. Index entries are the slowest keys to insert, at about 1.8 µs each. The likely cause, from reading the code rather than a profile: each insertion updates a persistent membership map that the previous insertion just shared with every graph generation, so the update copies map nodes. A cold start at 300,000 orders would take about 12 s (the SSD scan plus the rest of a warm load), and then the first mutation validates the whole graph.

## Reads

Nanoseconds per uniform random read:

| | 10,000 orders | 100,000 | 300,000 |
| --- | ---: | ---: | ---: |
| `Records::get` | 555 | 1,073 | 1,525 |
| redb get, 1 GiB cache | 665 | 963 | 1,206 |
| redb get and parse | 851 | 1,193 | 1,427 |
| redb get, 16 MiB cache over page cache | 880 | 1,835 | 2,677 |
| redb get, SSD | 23,786 | 108,863 | 156,350 |
| 10 keys from a range: `Records` / redb | 936 / 1,111 | 1,491 / 1,344 | 1,944 / 1,534 |

When its cache holds the file, redb is as fast as `Records`, and faster from 1.4 million keys on. Probably its pages store keys inline, while each comparison in `im::OrdMap` follows a pointer to a heap string; `Records::get` also looks up the active graph first for cell and root keys, 3 of the 14 per order. A redb cache miss served by the page cache costs about twice as much. A read that misses both costs 24–156 µs at queue depth one, rising as the tree deepens past what the small cache holds.

## Limits independent of storage

**The graph must fit in one transaction's budget.** Once a mutation touches the graph, the accounted size of the whole graph counts toward that transaction's `FLOWER_RUST_MEMORY_BYTES`, 128 MiB by default ([graph.rs](../src/evaluator/rust_engine/graph.rs), `refresh_graph_budget`). With 100 orders per mutation, seeding fails at 40,400 orders with `Graph index exceeds FLOWER_RUST_MEMORY_BYTES`; with 2,000 per mutation, it fails at 28,000. The accounting charges about 3.3 KB per order, a fifth of the measured heap.

**Adding a materialized root walks every root.** When a write changes the root set, `run_preview_inner` makes three full passes over the roots. Creating one order costs about 0.7 µs per existing order; updating a line does not:

| | 10,000 orders | 30,000 | 100,000 | 300,000 |
| --- | ---: | ---: | ---: | ---: |
| Create one order | 4.5 ms | 14.7 ms | 53.1 ms | 208 ms |
| Update one line | 0.070 ms | 0.077 ms | 0.083 ms | 0.093 ms |

Seeding batches slowed from 62 ms to 352 ms across the runs for the same reason.

## What this means for disk-backed serving

- Moving values to disk alone gains at most a factor of 1.5: keys, graph metadata and the proof would still take 17 KB per order. The graph metadata has to shrink or move to disk as well. Keys alone cost 131 bytes each in memory, so a disk-backed design has to keep them on disk too.
- Before storage matters, materialized collections need the two fixes above: charge a transaction for the graph it changes, not the whole graph, and find added and removed roots from the transaction's writes. Otherwise they stop at about 40,000 rows per logical database.
- Smaller in-memory sets would help today. Storing lone readers inline instead of in singleton `im::HashSet`s would save about 1 KB per dependency target, roughly 6 of this workload's 14.7 KB per order. That is an estimate from the singleton measurement, not an end-to-end result.
- Startup needs the graph metadata built in bulk or read from disk, not rebuilt through per-record persistent-map updates. Scanning and parsing redb is under 10% of today's load.
- Warm redb reads are cheap enough to serve from. The risk is SSD misses on the serial sequencer path: at 25–150 µs each, a few thousand per batch would stall a group for hundreds of milliseconds. Certificate validation should not need to reread values.
- Receipts belong on disk too, or under retention.

## What this does not measure

One schema, in one process, without the server: no Raft log, query cache, watch hubs or Wasm pools. The 11.3 GB peak resident size at 300,000 orders includes the seeded state and an encoded copy. Heap counts exclude allocator overhead. The SSD reads are single-threaded, through `F_NOCACHE` on APFS with a 16 MiB redb cache; no run used a file larger than RAM. Workloads with fewer derived cells per row would spend less on graph metadata, and ones with larger rows more on parsed values.
