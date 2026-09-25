# Retention, retries, and recovery

Current retry, transaction-closure and key-lifecycle contract, with disaster-recovery boundaries called out explicitly. The September 24, 2026 [architecture review](DESIGN.md) records the rationale. Retention is opt-in: without initialization, receipts remain retained indefinitely.

The central rule is: **forgetting a result must never make its original request executable again.** Result retention, replay rejection, transaction recovery, and cryptographic destruction have different lifetimes. A single TTL cannot safely govern all four.

## What currently grows

Raft carries evaluated changes and results. It does not retain an eternal command history: snapshots allow old log entries to be purged. Updating or deleting a source key changes current state rather than adding another live version forever.

Each committed external mutation retains its retry receipt until a replicated epoch floor, session acknowledgement or terminal session close makes collection safe. Coordinator decisions and participant completion detail can be collected through the separate closure protocol below; receipt collection never removes those protocol fences. Snapshots include those records, so log compaction does not collect them. Managed-key rotation retains encrypted historical key versions; revocation changes policy rather than deleting the material.

Receipt cost is substantial: 10,000 mutations/second × 600 seconds × 300 bytes is about **1.8 GB per replica**, before indexes, allocation overhead, source data, and backups. A ten-minute retry horizon bounds growth but does not necessarily make it cheap.

Current storage keeps application state and receipts in memory as well as redb. Reclaiming logical records makes storage reusable; it does not promise that the physical database file immediately shrinks.

## 1. Give histories identities that survive movement, but not rollback

Keep these concepts separate:

| Identity | Meaning | Changes when |
| --- | --- | --- |
| Logical database/partition ID | Stable owner of data, requests, and policy | A different logical database is created |
| History incarnation | Which non-rolled-back history a capability belongs to | Disaster restore or intentional fork |
| Placement epoch | Which Raft group currently owns the partition | Partition cutover |
| Retention epoch | Which retry windows remain admissible | Replicated retirement advances |

Moving a tenant preserves its logical ID, history incarnation, receipts, and retention state. A client retry must not become a new request merely because placement changed. Normal Raft catch-up and snapshot installation also preserve the incarnation.

A disaster restore is different. Restoring an old snapshot also restores its old rejection floors, key policy, transaction records, and worker fencing counters. The restored service must receive a new incarnation, and the old deployment must be fenced before traffic resumes. A random new ID distinguishes histories; it does not by itself disable the old cluster or tell an external system which history to trust. That needs operator-controlled isolation or an authority outside the restored backup.

Do not automatically resubmit uncertain old-incarnation mutations under the new incarnation. Their business effects might already have happened. A cross-group restore additionally needs a consistent recovery cut or explicit reconciliation of durable transaction decisions. Restoring one unrelated old participant or coordinator is not a supported recovery protocol.

## 2. Expiry-safe request identities

An SDK-created request identity binds its logical database, incarnation, immutable retry epoch, and a random intent ID. The server advertises the currently admissible window; client wall clocks do not decide what the server must retain. Bound the largest accepted future epoch as well as the oldest accepted one.

Each logical database stores a replicated, monotonically increasing minimum accepted epoch. The rules are:

| Request state | Outcome |
| --- | --- |
| Current incarnation, admissible epoch, no receipt | Evaluate once; commit changes and result together |
| Admissible epoch, matching receipt and business fingerprint | Return the original result after current authorization |
| Same identity, different business fingerprint | `REQUEST_ID_REUSED` |
| Epoch below the replicated floor | `RETRY_WINDOW_EXPIRED`, whether or not physical GC has finished |
| Different history incarnation | Explicit history-mismatch error; never silently convert to a new request |

The business fingerprint includes the method identity, arguments, and explicit caller preconditions. Credentials travel separately and do not change intent when refreshed. Receipt ownership is scoped to the authenticated principal and logical database. Replaying a result still requires current authorization; see [the admission design](DESIGN.md#1-make-authorization-a-runtime-stage).

A receipt preserves its original fingerprint, result and committed revision. It does not pin a deployable copy of the old application. An unrelated later deployment does not rewrite the receipt; current method exposure and authorization still govern retrieval. Removing an HTTP alias can revoke permission to retrieve its old results. A strict expectedRevision precondition, when supplied, is part of the original intent.

Changing the expiry creates a different identity. The SDK must not extend or replace an uncertain request behind the application's back.

### Retirement is a replicated transition

Advance the floor through consensus. Once that transition applies, old receipts can be deleted incrementally in bounded batches. Snapshots, restarts, and migration preserve the floor even after every corresponding result is gone.

Validate admissibility in deterministic state-machine application, including atomic batches. Checking only at HTTP ingress loses races with queued calls, speculative preparation, and delayed proposals. A request ordered before the floor transition may commit; one ordered after it must not execute under the retired identity. Per-node wall time must never independently decide whether the same Raft entry applies.

Retirement is operator-controlled, with no automatic wall-clock expiry. A future time-based policy would need an explicit clock-error assumption and jump detection: a forward clock jump must not silently erase the promised retry window. The current epoch protocol deliberately does not claim to implement that policy.

### What expiry means to callers

`RETRY_WINDOW_EXPIRED` means the original result is no longer available through this retry protocol. It does **not** mean the mutation failed. The SDK must surface that uncertainty rather than minting another request ID. An application can resolve it through a durable business identifier such as an order or payment ID.

Transport timeout, lost connection, and cancellation after proposal likewise do not prove abort. Distinguish errors that prove no admission from errors that mean the outcome is unknown. New intent requires an explicit application decision.

Retained-result pressure is an admission problem. Reject new work before commitment if its promised result cannot be retained. Never silently evict an unexpired result to make room, and never remove the compact replay-rejection state with it.

## 3. Sessions and acknowledgements reduce result retention

Optional retry sessions are opened through the authenticated metadata protocol, using a caller-generated 128-bit ID so a lost open response is recoverable. A session has a unique ID, principal/database scope, incarnation, retention epoch, and monotonic sequence numbers. Unknown or expired sessions are not implicitly reopened by a request.

The application acknowledges a **contiguous sequence watermark** only after it has durably consumed every result through that sequence. Advancing the watermark and deleting those individual results is one replicated transition. Retain the watermark:

- A sequence above the watermark can execute or replay its retained result.
- A sequence at or below it returns `ALREADY_ACKNOWLEDGED`; it never executes again.
- An expired session is terminal. Its eventual row deletion is safe only because a surviving generation/epoch floor or equivalent rejection mechanism excludes it.

This makes retained results roughly proportional to unacknowledged work rather than all work inside the retry window. Batch a contiguous prefix into one explicit ACK. Piggybacking on application calls is not implemented; each ACK is its own replicated transition.

Out-of-order concurrent completion creates gaps. A fast later response cannot acknowledge an earlier ambiguous one. Use a bounded outstanding window or compact sparse completion tracking until the contiguous prefix advances. Consumers with independent durable checkpoints should use independent sessions.

Receiving an HTTP response is not the same as durably consuming it. Automatic SDK acknowledgement therefore needs an explicit weaker contract or a caller checkpoint callback; it cannot be an invisible default for crash-safe workflows. A client that loses its own durable session/sequence state also loses the information needed to retry an uncertain intent safely.

## 4. Collect transaction history through a separate closure protocol

A client no longer needing a result does not prove every participant has completed a distributed transaction. An unavailable participant may still need the coordinator's immutable decision. Delayed preparation and completion messages may arrive after detailed records are collected.

Each coordinator assigns a random durable history identity and monotonic sequence. Completed decisions have a sequence index; active recovery has its own index. Before deleting a completed prefix, an operator creates a durable closure intent with its participant set. Each participant quorum-reads that intent, verifies its identity and records a term-fenced rejection floor before acknowledging. Only after all acknowledgements does the coordinator advance its own floor. Delayed prepare/finish messages at or below a floor return TRANSACTION_CLOSED even after detail has been deleted. Floors travel with snapshots and movement. Closure resolves current logical owners, while ordinary in-flight phases remain pinned to their original placement.

Prepared work never aborts merely because a timeout elapsed. An incomplete sequence blocks its prefix. Committed decisions can close while the matching public receipt remains; that receipt still replays after decision collection. An aborted decision has no success receipt, so it can close only after the original public request ID is provably inadmissible: a retired epoch, acknowledged/closed session, old incarnation or legacy ID rejected by initialized retention. An admissible legacy abort therefore blocks its prefix until an operator explicitly adopts a rejecting retention policy.

Use `admin.transactionClosureStatus()` and `admin.controlTransactionClosure({operation:"close",through?,maxBytes?})` on a `FlowerAdmin`. Inspect pending and blockedReason: HTTP success can report bounded partial progress or an unavailable participant. Close is monotonic and recovery resumes a durable intent; repeating it after uncertainty is safe. `admin.controlTransactionClosure({operation:"collect",maxBytes?})` incrementally removes coordinator and participant detail behind the floors. Run collection on each relevant logical database; its persisted cursor prevents one history starving later records. A single record larger than maxBytes needs a larger work budget. Operations remain limited by the node transaction-byte budget. Floors and history identities themselves remain compact retained metadata.

Migration waits for outstanding participant intents and incomplete coordinators, then transfers authoritative history, closure intent, floors, collection progress and public receipts. A closure intent can resume against current owners after movement. Independently rolling back one participant or coordinator can still invalidate those proofs and is not a supported recovery protocol.

## 5. Treat key lifecycle separately

| Transition | Intended meaning |
| --- | --- |
| Rotate | Use a new version for new signing/encryption |
| Retire | Keep an old version usable only for verification/decryption |
| Revoke | Refuse further use of that version |
| Destroy | Remove that version's encrypted material from current state |

All four lifecycle transitions are implemented through operator key methods. Version-qualified ciphertexts and verification inputs must remain usable during retirement. Restrict historical-version selection to the bound logical key and permitted operations.

Do not infer that a key can be destroyed because its database receipts expired. External JWTs and ciphertexts can live much longer, and arbitrary application data does not reveal all dependencies on a key. Destruction needs an explicit operator/application policy and an audit record that does not retain the secret.

Deleting current material does not erase old Raft entries, snapshots, copied backups, or plaintext previously produced by decryption. If the same wrapping key still decrypts a retained backup, restoration can recover that material. Strong cryptographic destruction needs an external destruction boundary with appropriate granularity, or a weaker documented promise of logical deletion. Restoring old backups must reconcile current revocations before serving traffic.

Prepared-key caches remain governed by current authorization and key version. Cache TTL is a memory/reuse policy, not permission to ignore revocation.


## SDK and operator workflow

Import from the published SDK. Retention metadata is scoped to the same root database or named partition as the client. Operator transitions use a `FlowerAdmin` holding the operator token. Session operations use a `FlowerClient` with current application credentials and require a deployed authorization hook, which `define` compiles when `auth.authenticate` or `auth.delegation` is set or an exposed method's `access` is a predicate. The hook receives `$flower.session.open`, `.status`, `.ack` or `.close`, governed by `auth.sessions` (default `auth.default`), and the server derives ownership from its subject and tenant. All anonymous callers share one owner, so give sessions to authenticated principals when ownership matters.

```ts
import { FlowerAdmin, FlowerClient } from "@flower-js/sdk/client";

const operator = new FlowerAdmin("https://db.example", { adminToken });
const status = await operator.retentionStatus();
const hexId = () => crypto.randomUUID().replaceAll("-", "");
await operator.controlRetention(status.revision, {
  operation: "initialize", database: hexId(), incarnation: hexId(),
  max_receipt_bytes: 256 * 1024 * 1024,
});

const client = new FlowerClient("https://db.example", {
  boundedRetries: true, credentials: () => currentCredential(),
});
const requestId = await client.newRequestId("order:business-id");
// Persist requestId and intent before sending; retry these exact bytes.
const receipt = await client.mutate("order", { id: "business-id" }, { requestId, retry: true });
```

`f1:database:incarnation:epoch:SHA256(intent)` IDs retain the original epoch even when the operator advertises a newer one. The SDK's `retry` option resends the same ID and never retries `409` outcomes such as `RETRY_WINDOW_EXPIRED` or `HISTORY_MISMATCH`. `refreshRetryIdentity()` is an explicit action for **new** intent. Initialization rejects all unscoped legacy request IDs, including retries whose old receipt remains stored. Pre-initialization legacy receipts remain retained and epoch collection does not remove them. Do not convert an uncertain legacy request into a new scoped intent without business-level reconciliation. Choose a migration policy for that finite legacy history before enabling retention in a long-running database.

For sustained clients, use sessions:

```ts
const identity = await client.refreshRetryIdentity();
const id = hexId();
// Persist identity and id before opening. Recover with retrySessionStatus.
let session = (await client.openRetrySession(id)).value;
const requestId = client.sessionRequestId(session, 1);
const result = await client.mutate("order", { id: "next-order" }, { requestId });
// Durably checkpoint result and sequence allocation before acknowledging.
session = (await client.acknowledgeRetrySession(session, 1)).value;
```

A session request is `f2:database:incarnation:epoch:session:sequence`. Sequence allocation is caller-owned; sequence numbers are positive safe integers. Strict ACK checks every receipt in the prefix and requires that work to fit `limit` (SDK default 256, operator/caller configurable). A gap returns `RETRY_ACK_GAP`; insufficient work allowance returns `RETRY_ACK_BUDGET`. `abandon:true` explicitly fences ambiguous or unissued sequences and bounds physical cleanup separately. It must never be used as automatic recovery from a timeout. `closeRetrySession` is terminal and can make still-in-flight outcomes unavailable. Closed rows remain until the epoch floor excludes their IDs, preventing reopen after collection.

`advance` accepts `current_epoch` and `min_epoch`, both monotonic safe integers. No wall clock automatically advances either value. `collect` bounds inspected records, counts and reclaims receipts/sessions incrementally, and preserves the rejection floor. `set_budget` changes retained receipt/session logical byte capacity; reducing it does not evict promised results. Reclaiming ACK/close remains possible under a reduced budget, while operations that increase retained bytes must fit. Database-file overhead, allocator overhead, live MVCC roots and backups are outside this logical byte count. Distributed transactions reserve their configured maximum receipt size before preparation and release the reservation with completion.

`reincarnate` records a new 128-bit history ID plus a nonempty operator `fence_attestation`, refuses any retained transaction protocol history, and permanently remembers used incarnation IDs. It **does not** isolate the old deployment, reconcile external effects or implement a multi-group restore. The attestation is an assertion that an operator performed that work, not cryptographic proof. Old-history requests and sessions fail even before physical cleanup. A bounded retry window therefore does not by itself bound the number of deliberately created history incarnations.

## What remains deliberate

- Transaction collection requires explicit durable closure. Unavailable participants, undecided work and still-admissible aborts can delay it; never manually delete their protocol state.
- Retention epochs advance explicitly; automatic time-based retirement needs a trusted clock-error policy first.
- Session acknowledgements do not replace durable business IDs or an outbox. `ctx.history()` exposes database/incarnation after initialization, and `queue()` claims bind it into lease identity. Old-history completion/failure is rejected after reincarnation; existing old-history leases can wait until their expiry before reclamation. External sinks must independently select the accepted incarnation and enforce increasing fencing tokens. Flower cannot retract an external effect after worker lease expiry.
- Logical key destruction does not erase prior backups or plaintext results. Wrapping-key rewrap and mounted previous KEKs support operational rotation, with backup retention managed separately.
