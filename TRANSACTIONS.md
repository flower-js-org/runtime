# Transactions between logical databases

A TypeScript transaction method coordinates exposed methods across root group databases or stable named partitions using durable two-phase commit. Logical targets may share a physical Raft group or live on different groups. Prepared barriers are scoped to the participating logical database; unrelated named tenants keep running.

```ts
import { define, transaction } from "@flower-js/sdk";

const transfer = transaction("bank.transfer", (args: {
  from: string; to: string; cents: number;
}) => ({
  calls: [
    { partition: "west", method: "debit", args: { account: args.from, cents: args.cents } },
    { partition: "east", method: "credit", args: { account: args.to, cents: args.cents } },
  ],
  value: { transferred: args.cents },
}));

export default define({ http: { transfer } });
```

Deploy `debit` and `credit` as ordinary exposed mutation methods in their named partitions. `{group:"name",method,args}` still targets a configured physical group’s root database; specify exactly one of `partition` or `group`. Named targets require `FLOWER_CATALOG_GROUP`, and the runtime resolves and durably pins their placement epoch and bootstrap addresses before contacting participants. Validate balances and amounts inside those methods. A thrown error aborts the whole transaction, including earlier successful calls. Participants may also call exposed queries; a later call in the same logical target observes earlier staged writes.

A planner receives only its arguments. It cannot read database state, access a context, perform I/O, or call another transaction. The returned plan is fixed before execution; one participant's result cannot dynamically choose another participant's calls. Internal definition names are not callable unless explicitly exposed as HTTP aliases.

```ts
import { FlowerClient } from "@flower-js/sdk/client";

const client = new FlowerClient("http://coordinator-member:7101");
const requestId = crypto.randomUUID(); // Save this before sending.
const receipt = await client.call("transfer", {
  from: "alice", to: "bob", cents: 500,
}, { requestId });

// receipt.value = {
//   results: [debitResult, creditResult],
//   value: { transferred: 500 },
// }
```

`results` follows the original call order. `value` is the optional value returned by the planner, including an explicit `null`. The receipt's revision belongs to the coordinator logical database; it is not shared across participants. `expectedRevision`, when supplied, checks the coordinator revision when a new plan begins.

## Configure and operate

Configure every node with its own group name, the same group registry, and a shared peer credential. Operator credentials remain separate:

```sh
export FLOWER_GROUP=west
export FLOWER_GROUPS='{"west":["west-1:7101","west-2:7101","west-3:7101"],"east":["east-1:7101","east-2:7101","east-3:7101"]}'
export FLOWER_ADMIN_TOKEN='your-operator-secret'
export FLOWER_PEER_TOKEN='your-shared-peer-secret'
flower --id 1 --listen 0.0.0.0:7101 --advertise west-1:7101 --data ./west-1
```

Initialize each group separately with only its own members. Use `FLOWER_GROUP=east` on east nodes. Registry addresses are `host:port`, without a URL scheme or path. Addresses must be unique across the registry. Keep the registry and shared peer credential consistent, and retain an address list through leadership changes. The coordinator tries configured peers; the SDK may target any coordinator member; the server forwards leader-bound work.

Cross-group RPCs use pooled HTTP/2 connections (verified HTTPS when native TLS is configured) and require the peer bearer token, the expected group identity, and the same wire/state/snapshot/value/QuickJS compatibility contract as ordinary peer traffic. Protect this operator network as described in the operating guide. Public callers only invoke deployed method aliases; they do not receive an arbitrary transaction endpoint.

`FLOWER_TRANSACTION_MAX_BYTES` bounds durable transaction records and patches; `FLOWER_RPC_MAX_BYTES` bounds internal exchange bodies. Existing read, commit, and connection budgets apply. All calls in one participant preparation share a single `FLOWER_EVALUATION_TIMEOUT_MS` deadline, including evaluator queue waits; adding more calls does not multiply that budget. Authentication and compatibility are checked before parsing an internal request body. The runtime checks that a prepared patch and the eventual receipt can be stored before deciding to commit. It reserves enough safe integer revisions to finish outstanding transactions, preventing unrelated writes from consuming their final revisions.

## What a transaction guarantees

The coordinator durably records every planned participant before contacting any of them. It prepares distinct logical targets in deterministic order, preserving call order within each target. Independent request IDs have separate coordinator locks; conflicting preparations abort rather than waiting for another transaction’s lock, avoiding distributed wait cycles. Participants evaluate into private state, then replicate a prepared lock, patch, and results. Once every participant is prepared, the coordinator replicates an immutable commit decision. Participants independently read that decision through the coordinator's quorum before applying their patches. Success is returned only after every participant confirms completion and the coordinator stores the retry receipt.

Once a node applies a prepared lock, it blocks ordinary reads, watches, mutations, deployment, and maintenance in that logical database until it applies the durable decision. Fresh reads establish a quorum barrier and therefore observe that lock. Opt-in replica-local reads and watches may be on a lagging replica that has not applied the lock or final commit; they retain their explicitly stale semantics and are excluded from the cross-group atomic visibility guarantee. Existing reads that already acquired a snapshot can finish against that snapshot. An affected watch reports an error and closes; reconnect it after the group becomes available. A transaction touching several groups can therefore temporarily reduce availability across all of them, including unrelated keys in those logical databases. Other named partitions on the same physical group have independent writers and remain available.

For fresh reads, these barriers prevent a new read from exposing an uncommitted participant patch. They do not create a global snapshot for independent client requests: two separate reads at different times can straddle a completed transaction. Put related reads into one transaction when they require the participant barriers. Results from a query-only transaction use the same prepare/decision protocol.

## Failure and retry

- After a timeout or lost response, retry the same arguments with the **same request ID**. A completed commit returns its original receipt with `duplicate: true`; changed content returns `REQUEST_ID_REUSED`.
- `TRANSACTION_ABORTED` is durable for that request ID. Retrying it keeps the abort. After correcting the cause, start a new attempt with a new ID.
- `TRANSACTION_PREPARED` means a participant is waiting for its coordinator's durable outcome. Restore the coordinator's quorum/connectivity and retry. There is no timeout that discards a prepared transaction.
- A coordinator recovering an unfinished preparation durably aborts it. A committed decision is never rolled back. Recovery repeatedly finishes decided transactions, including after leadership changes or process restarts.
- An uncertain prepare causes a durable abort that is sent to every planned participant. A participant captures its Raft leader term, then checks the coordinator decision while holding its writer lock before preparing. The replicated state machine rejects a preparation submitted in another term, including after a former leader returns. If an abort finds no prepared work, it can acknowledge without a write: delayed prepares must observe the immutable abort. Participants that did prepare atomically retain a completion tombstone when clearing their lock.

Coordinator records, completion receipts, and participant tombstones are retained durably. Operator-driven close/collect now reclaims detail behind durable history floors; deleting metadata manually still breaks retry and delayed-message fencing. Each coordinator assigns a random history and monotonic sequence. Close persists a completed-prefix intent, obtains durable rejection-floor acknowledgements from all participants, then advances the coordinator floor. Delayed prepare/finish messages are rejected after collection. Committed public receipts remain available under their retry contract; an aborted decision cannot close until its original request ID is inadmissible. Use FlowerClient.transactionClosureStatus() and controlTransactionClosure({operation:"close"|"collect",maxBytes?}); close also accepts through. Repeated calls make bounded, monotonic progress, reported through pending/blockedReason/deletedRecords. Collection runs per coordinator/participant database. See [RETENTION.md](RETENTION.md#4-collect-transaction-history-through-a-separate-closure-protocol). Prepared state and decisions travel with normal Raft snapshots and backups. Tenant cutover waits for prepared work and incomplete coordinators to close; status and completion messages remain allowed during movement so recovery can release those barriers. Completed decisions and receipts move with the tenant, preserving replay and abort identity. Restoring only one group from an older, unrelated backup is not a cross-group restore protocol.

## Validation

```sh
cargo test --lib service::transactions::tests -- --test-threads=1
cargo build
node tests/e2e-transactions.mjs
node tests/e2e-partition-transactions.mjs
```

The focused tests cover private staging, abort fencing, idempotent decisions, unavailable coordinators, recovery after lost prepare acknowledgements and durable commit decisions, authentication/compatibility, JSON depth, and revision reservations. The process test uses two independent three-node groups and exercises atomic commit/abort, result ordering, fresh replica reads, coordinator death while the first participant is prepared and the second is unavailable, receipt replay after leader failure, and a complete cluster restart.

Application authorization runs before external transaction receipt replay and planning. The durable coordinator stores the resulting principal, excluding raw credentials. Each participant’s current hook sees the public alias and a server-supplied delegation `{coordinator,principal}` and decides whether to accept it; named participants must return their own tenant scope. Refreshing credentials for the same subject/tenant preserves the original intent, while revoked authorization blocks replay. A planner still receives only arguments, never a context or participant results.
