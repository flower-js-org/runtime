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
target/release/flower-footprint \
  --bundle target/footprint/footprint.js --orders 100000 --dir target/footprint
```

Builds before 41b392c need `FLOWER_RUST_MEMORY_BYTES=34359738368` beyond about 40,000 orders (see below). `--breakdown` attributes the graph metadata to key classes instead of timing storage. `--profile SECONDS` samples single-row mutations with macOS `sample`.

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

Both limits below are fixed: main charges a transaction for the graph it changes since 41b392c, and [incremental graph maintenance](#incremental-graph-maintenance) finds root changes from the invocation's own operations. The measurements are of 66349bc.

**The graph must fit in one transaction's budget.** Once a mutation touches the graph, the accounted size of the whole graph counts toward that transaction's `FLOWER_RUST_MEMORY_BYTES`, 128 MiB by default ([graph.rs](../src/evaluator/rust_engine/graph.rs), `refresh_graph_budget`). With 100 orders per mutation, seeding fails at 40,400 orders with `Graph index exceeds FLOWER_RUST_MEMORY_BYTES`; with 2,000 per mutation, it fails at 28,000. The accounting charges about 3.3 KB per order, a fifth of the measured heap.

**Adding a materialized root walks every root.** When a write changes the root set, `run_preview_inner` makes three full passes over the roots. Creating one order costs about 0.7 µs per existing order; updating a line does not:

| | 10,000 orders | 30,000 | 100,000 | 300,000 |
| --- | ---: | ---: | ---: | ---: |
| Create one order | 4.5 ms | 14.7 ms | 53.1 ms | 208 ms |
| Update one line | 0.070 ms | 0.077 ms | 0.083 ms | 0.093 ms |

Seeding batches slowed from 62 ms to 352 ms across the runs for the same reason.

## What this means for disk-backed serving

- Moving values to disk alone gains at most a factor of 1.5: keys, graph metadata and the proof would still take 17 KB per order. The graph metadata has to shrink or move to disk as well. Keys alone cost 131 bytes each in memory, so a disk-backed design has to keep them on disk too.
- Before storage mattered, materialized collections needed the two fixes above, now made: charge a transaction for the graph it changes, and find added and removed roots from the transaction's own operations.
- Most graph metadata can leave memory before any storage change. [Restructured graph metadata](#restructured-graph-metadata) moves reverse edges into records and drops three other per-cell structures, halving `Records`.
- Startup needed the graph metadata read from disk rather than rebuilt through per-record persistent-map updates. It now is: reader and height records load like any other.
- Warm redb reads are cheap enough to serve from. The risk is SSD misses on the serial sequencer path: at 25–150 µs each, a few thousand per batch would stall a group for hundreds of milliseconds. Certificate validation should not need to reread values.
- Receipts belong on disk too, or under retention.

## Restructured graph metadata

A follow-up on branch `memory-footprint` removes most per-cell structures from memory. Measuring each structure by building `Records` without it first (10,000 orders) put reverse edges at 10.7 KB per order, the cells map at 1.7 KB, outcome markers at 0.9 KB, bucket memberships at 0.4 KB, and roots at 0.3 KB. The changes:

- **Reverse edges are records.** For each non-scan dependency of a stored cell, the engine writes `reader:<dependency>\0<cell>` in the same patch, like an index entry. Propagation seeks a dependency's readers by prefix. They are replicated, persisted and copied like any other record, so startup no longer derives them. Reader records share one null value in memory.
- **No cells map.** The index keeps a count of cells and parses a cell record again when it is replaced. Code that needs every cell scans the `cell:` records of its graph.
- **No outcome markers.** A certificate stamps a stored cell by its record's allocation. Patches never rewrite an unchanged record, so the stamp holds until the outcome or the dependencies change. Before, a change to dependencies alone, with the same outcome, kept cached results valid; now it invalidates them.
- **No marker per equality bucket.** A certificate stamps a bucket by the entries in its range, like an index window, with one marker per index as the fast path. A change to any bucket of that index makes the next check compare the bucket's entries.

Heap per order at 10,000 orders:

| | Before | After |
| --- | ---: | ---: |
| Keys per order | 14 | 20 |
| Stored JSON text | 1,843 | 2,346 |
| Keys and parsed values | 10,698 | 11,956 |
| Graph metadata | 14,779 | 702 |
| Production `Records` | 25,461 | 12,659 |

Creating an order writes 6 reader records, 27% more stored text. Alternating runs of both builds at 30,000 orders, on a host loaded by other benchmarks:

| | Before | After |
| --- | ---: | ---: |
| Load into `Records` | 1,089–1,128 ms | 507–562 ms |
| First mutation after loading | 79–82 ms | 63–65 ms |
| Seeding 30,000 orders | 6.0–6.5 s | 5.1–6.0 s |
| Process CPU time | 16.3–16.6 s | 12.9–14.1 s |
| Create one order | 16.9–17.2 ms | 17.2–19.7 ms |
| Update one line | 0.09–0.13 ms | 0.08–0.16 ms |

All 623 library tests pass. The JavaScript-reference differential test now compares patches without reader records, then checks after every step that the stored reader records are exactly the reverse of every cell's dependencies. A new case covers rows moving between equality buckets.

### Incremental graph maintenance

The in-memory topology proof and root maps are gone too. What they did is now kept in records, and a preview updates it only where its writes changed the graph:

- **Heights.** A cell that reads other cells has a `height:` record: the number of cells on its longest derived path, itself included. A preview recomputes heights only for cells whose derived edges it changed, in write order, so children come before parents. It then follows reader records to the parents of any cell whose height changed. A height above 128 is an error. A cycle raises heights without bound, so it is caught the same way, and the full traversal then reports the same error the reference does.
- **Collection.** Cells that lose a reader or their root, and new cells, are collected at the end of the preview if no reader record or root holds them. Deleting a cell deletes its reader records, which can release the cells it read.
- **Roots.** An invocation tracks the roots it materializes and unmaterializes, plus the one temporary root a preview stores to read a derived value. The root set is no longer compared as a whole. Roots are read from their `root:` records.

Deployments, which reevaluate every cell, still traverse from every root. So does a preview in which a callback error kept a dirty child it never evaluated. The traversal is also the test reference: randomized comparisons check that incremental maintenance produces the same patches, callbacks and errors.

This removes the last per-row graph structures from memory, and the traversals from root and edge changes and from the first mutation after a restart. Stored graphs are now trusted: the engine checks cycles, depth and missing children when it writes cells, and no longer revalidates records it did not write. At 30,000 orders, compared with 66349bc:

| | Before | After |
| --- | ---: | ---: |
| Keys per order | 14 | 21 |
| Stored JSON text per order | 1,883 | 2,437 |
| `Records` heap per order | 25,308 | 11,889 |
| Load into `Records` | 1,089–1,128 ms | 341 ms |
| First mutation after loading | 79–82 ms | 0.46 ms |

Single-row mutations no longer grow with the database:

| | 10,000 orders | 30,000 | 100,000 |
| --- | ---: | ---: | ---: |
| Create one order | 0.16 ms (was 4.5) | 0.18 ms (was 14.7) | 0.20 ms (was 53) |
| Delete one order | 0.14 ms (was 32) | 0.15 ms (was 146) | 0.18 ms |
| Update one line | 0.07 ms | 0.07 ms | 0.08 ms |

`Records` minus a plain map of the same parsed values is now slightly negative, because reader records share one null value. What remains in memory is keys and parsed values, the next target for disk-backed serving. Scan windows are still indexed in memory per reading cell.

## What this does not measure

One schema, in one process, without the server: no Raft log, query cache, watch hubs or Wasm pools. The 11.3 GB peak resident size at 300,000 orders includes the seeded state and an encoded copy. Heap counts exclude allocator overhead. The SSD reads are single-threaded, through `F_NOCACHE` on APFS with a 16 MiB redb cache; no run used a file larger than RAM. Workloads with fewer derived cells per row would spend less on graph metadata, and ones with larger rows more on parsed values.
