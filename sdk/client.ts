import { canonicalJson } from "./json.ts";
import type { Json } from "./index.ts";
import type { ManagedKeyAlgorithm, KeyUsage } from "./keys.ts";
import { applyWatchPatch, cloneWatchValue, controlledWatch, decodeWatchEvent, readSse, watchBudgets, WatchProtocolError } from "./watch.ts";
import type { WatchBudgets, WatchDelta } from "./watch.ts";

export interface Bundle { hash: string; javascript: string }
export interface RequestOptions { signal?: AbortSignal; credentials?: Json }
export interface MutationOptions extends RequestOptions { requestId?: string; expectedRevision?: number }
export interface DeploymentOptions { requestId?: string; signal?: AbortSignal; /** Online preparation preserves writes but may conflict; blocking guarantees an exclusive preparation window. */ preparation?: "online" | "blocking" }
/** The JSON POST subset used by Flower; custom transports need not implement general fetch. */
export interface FlowerRequestInit { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }
export type FlowerFetch = (url: string, init: FlowerRequestInit) => Promise<Response>;
export interface FlowerClientOptions {
  /** Use epoch-scoped retry IDs. Enable server retention first; expired IDs are never silently renewed. */
  boundedRetries?: boolean;
  /** Evaluated for each call/connection; refreshed credentials keep the same business intent. */
  credentials?: Json | (() => Json | Promise<Json>);
  adminToken?: string;
  fetch?: FlowerFetch;
  /** Round-robin endpoints for query() and new watches. Deployed code controls
   * freshness; this changes routing only. Mutations and call() use the primary URL.
   * Each watch stays on its selected endpoint; no automatic retry or failover.
   */
  queryUrls?: readonly string[];
}
export interface QueryResult<Value = Json> { revision: number; value: Value }
export interface MutationResult<Value = Json> extends QueryResult<Value> { duplicate: boolean }
export interface DeploymentReceipt { revision: number; value: Json; duplicate: boolean }
/** Physical Raft groups are provisioned separately; addresses use host:port. */
export interface ClusterGroup { id: string; addresses: string[] }
export type PartitionMovePhase = "copying" | "freezing" | "importing" | "activating" | "retiring" | "complete";
export interface PartitionMove {
  operation: string; partition: string; source: ClusterGroup; destination: ClusterGroup;
  source_epoch: number; epoch: number; phase: PartitionMovePhase;
}
export interface PartitionPlacement {
  partition: string; epoch: number; owner: ClusterGroup;
  status: "creating" | "active" | "moving"; operation: string; movement: PartitionMove | null;
}
export interface RebalanceMove { partition: string; source: string; destination: string; operation: string }
export interface RebalancePlan {
  operation: string; groups: ClusterGroup[]; moves: RebalanceMove[]; next: number; complete: boolean;
}
export interface ClusterLayout {
  groups: ClusterGroup[]; partitions: PartitionPlacement[]; moves: PartitionMove[]; rebalance: RebalancePlan | null;
}
export interface ControlOptions extends RequestOptions { /** Retain across retries of create, move or resize. */ requestId?: string }
export interface KeyGenerateOptions extends ControlOptions { /** RSA modulus size; ignored/rejected for other algorithms by native policy. */ bits?: number }
export interface KeyRevokeOptions extends ControlOptions { /** Omit to revoke every version. */ version?: number }
export interface SealedKeyImport {
  version: 1;
  wrappingId: string;
  nonce: string;
  ciphertext: string;
}
export interface ManagedKeyCatalog {
  domain: string | null;
  revision: number;
  keys: Record<string, { id: string; algorithm: ManagedKeyAlgorithm; activeVersion: number; versions: { version: number; revoked: boolean; retired: boolean; destroyed: boolean; wrappingId: string | null; kid: string }[] }>;
  bindings: Record<string, { key: string; usages: KeyUsage[] }>;
}
export interface KeyCacheStats { entries: number; bytes: number; budgetBytes: number; hits: number; misses: number; loads: number; evictions: number; flightEntries: number; flightBytes: number; coalesced: number }
export interface PartitionWaitOptions extends RequestOptions { timeoutMs?: number; intervalMs?: number }
export interface WatchOptions extends WatchBudgets, RequestOptions { /** @deprecated Use watchPoll for interval-based polling. */ intervalMs?: number }
export interface WatchPollOptions extends RequestOptions { /** Integer milliseconds in the runtime timer range 1..2147483647. Default: 250. */ intervalMs?: number }

export interface RetryIdentity { database: string; incarnation: string; currentEpoch: number; minEpoch: number }
export interface RetentionState extends RetryIdentity {
  receiptBytes: number; receiptCount: number; maxReceiptBytes: number | null; gcCursor: string | null; gcComplete: boolean;
  sessionBytes: number; sessionCount: number; gcReceiptsComplete: boolean; gcSessionCursor: string | null;
}
export interface RetrySession {
  database:string; incarnation:string; id:string; epoch:number; acknowledgedThrough:number; closed:boolean;
}
export interface SessionOptions extends RequestOptions { limit?:number; /** Explicitly retire unknown/abandoned intents too. Never automatic. */ abandon?:boolean }
export type RetentionAction =
  | { operation: "initialize"; database: string; incarnation: string; max_receipt_bytes: number | null }
  | { operation: "advance"; incarnation: string; current_epoch: number; min_epoch: number }
  | { operation: "collect"; incarnation: string; limit: number }
  | { operation: "set_budget"; incarnation: string; max_receipt_bytes: number | null }
  | { operation: "reincarnate"; incarnation: string; new_incarnation: string; fence_attestation: string };

/** Pinned placement recorded in transaction protocol metadata, not a client routing hint. */
export interface TransactionClosureTarget { group: string; partition: string | null; epoch: number; addresses?: string[] }
export interface TransactionClosureState {
  history: string | null; nextSequence: number; closedThrough: number;
  pending: { through: number; participants: TransactionClosureTarget[]; acknowledged: TransactionClosureTarget[] } | null;
  blockedReason: string | null; deletedRecords: number;
}
export type TransactionClosureAction =
  | { operation: "close"; through?: number; maxBytes?: number }
  | { operation: "collect"; maxBytes?: number };

/** Durable resumable index and materialized-graph preparation. Active code remains visible until activation. */
export interface StagedDeploymentState {
  requestId: string;
  phase: "backfill" | "rebuilding" | "ready" | "failed" | "active" | "canceled" | "collected";
  baseRevision: number;
  baseBundleHash: string | null;
  bundleHash: string;
  cursor: string | null;
  scannedRows: number;
  builtEntries: number;
  graphCursor: string | null;
  rebuiltRoots: number;
  generation: string | null;
  error?: string | null;
  cleanupCursor: string | null;
}
export type StagedDeploymentAction =
  | { operation: "advance" | "collect"; requestId: string; maxBytes?: number }
  | { operation: "activate" | "cancel"; requestId: string };

export class FlowerError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 0, code = "FLOWER_ERROR") {
    super(message);
    this.name = "FlowerError";
    this.status = status;
    this.code = code;
  }
}

/** All application reads and writes invoke deployed TypeScript methods.
 * The URL can address any reachable member; servers route writes to the leader.
 */
export class FlowerClient {
  readonly url: string;
  private readonly adminToken?: string;
  private readonly fetch: FlowerFetch;
  private readonly queryUrls: readonly string[];
  private nextQuery = 0;
  private readonly credentials: FlowerClientOptions["credentials"];
  private readonly boundedRetries: boolean;
  private retryIdentity?: Promise<RetryIdentity>;
  constructor(url = "http://127.0.0.1:7101", options: FlowerClientOptions = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new TypeError("Flower URL must use HTTP or HTTPS");
    }
    this.url = url.replace(/\/+$/, "");
    if (options.queryUrls !== undefined && (!Array.isArray(options.queryUrls) || options.queryUrls.length === 0)) {
      throw new TypeError("queryUrls must be a nonempty array of HTTP or HTTPS URLs");
    }
    this.queryUrls = Object.freeze(Array.from(options.queryUrls ?? [this.url], (address) => {
      if (typeof address !== "string") throw new TypeError("queryUrls must contain HTTP or HTTPS URLs");
      const endpoint = new URL(address);
      if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
        throw new TypeError("queryUrls must contain HTTP or HTTPS URLs");
      }
      return address.replace(/\/+$/, "");
    }));
    this.adminToken = options.adminToken;
    this.credentials = options.credentials;
    this.boundedRetries = options.boundedRetries ?? false;
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  }

  private queryUrl(): string {
    const address = this.queryUrls[this.nextQuery];
    this.nextQuery = (this.nextQuery + 1) % this.queryUrls.length;
    return address;
  }

  private async authorization(options: RequestOptions): Promise<Record<string, Json>> {
    const credentials = options.credentials !== undefined ? options.credentials :
      typeof this.credentials === "function" ? await this.credentials() : this.credentials;
    if (credentials === undefined) return {};
    canonicalJson(credentials);
    return { credentials };
  }

  /** Refresh only for new intent; keep every previously issued ID across uncertain retries. */
  async refreshRetryIdentity(options: RequestOptions = {}): Promise<RetryIdentity> {
    const pending=this.request<QueryResult<RetryIdentity | null>>("/v1/identity",{}, {signal:options.signal})
      .then(({value})=>{
        if(!value) throw new FlowerError("Retry retention is not initialized",409,"RETENTION_NOT_INITIALIZED");
        if(!/^[a-f0-9]{32}$/.test(value.database) || !/^[a-f0-9]{32}$/.test(value.incarnation) ||
          !Number.isSafeInteger(value.currentEpoch) || !Number.isSafeInteger(value.minEpoch) ||
          value.minEpoch<0 || value.currentEpoch<value.minEpoch) throw new FlowerError("Invalid retry identity",0,"PROTOCOL_ERROR");
        return Object.freeze({...value});
      });
    this.retryIdentity=pending;
    try {return await pending;} catch(error) {if(this.retryIdentity===pending)this.retryIdentity=undefined; throw error;}
  }

  /** Persist the returned ID before sending. Re-scoping an uncertain intent is unsafe. */
  async newRequestId(intent: string = crypto.randomUUID(), options: RequestOptions = {}): Promise<string> {
    const identity=await (this.retryIdentity ?? this.refreshRetryIdentity(options));
    const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(intent));
    const hash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
    return `f1:${identity.database}:${identity.incarnation}:${identity.currentEpoch}:${hash}`;
  }

  private async automaticRequestId(options: ControlOptions): Promise<string> {
    return options.requestId ?? (this.boundedRetries ? this.newRequestId(undefined,options) : crypto.randomUUID());
  }

  async retentionStatus(options: RequestOptions = {}): Promise<QueryResult<RetentionState | null>> {
    return this.request("/admin/retention",{operation:"status"},{admin:true,signal:options.signal});
  }

  /** Fresh operator view of distributed closure, independent of client receipt retention. */
  async transactionClosureStatus(options: RequestOptions = {}): Promise<QueryResult<TransactionClosureState>> {
    return this.request("/admin/transactions", { operation: "status" }, { admin: true, signal: options.signal });
  }

  /** Monotonic, retryable closure/collection. Inspect blockedReason and pending before assuming completion. */
  async controlTransactionClosure(action: TransactionClosureAction, options: RequestOptions = {}): Promise<QueryResult<TransactionClosureState>> {
    return this.request("/admin/transactions", action, { admin: true, signal: options.signal });
  }

  /** Revision-conditional control. After an uncertain response, inspect status before another transition. */
  async controlRetention(expectedRevision: number, action: RetentionAction, options: RequestOptions = {}): Promise<MutationResult<{state:RetentionState;collected:number}>> {
    return this.request("/admin/retention",{expected_revision:expectedRevision,action},{admin:true,signal:options.signal});
  }

  /** Save id/identity before opening if the response must be recoverable. The hook sees $flower.session.open. */
  async openRetrySession(id: string = crypto.randomUUID().replaceAll("-",""), options: RequestOptions = {}): Promise<QueryResult<RetrySession>> {
    const identity=await (this.retryIdentity??this.refreshRetryIdentity(options));
    return this.sessionCommand({operation:"open",session:id,incarnation:identity.incarnation,epoch:identity.currentEpoch},options);
  }

  /** Persist sequence allocation yourself; no implicit acknowledgements or sequence advancement. */
  sessionRequestId(session:RetrySession,sequence:number):string {
    if(!Number.isSafeInteger(sequence)||sequence<1||session.closed||sequence<=session.acknowledgedThrough ||
      !/^[a-f0-9]{32}$/.test(session.id)||!/^[a-f0-9]{32}$/.test(session.database)||!/^[a-f0-9]{32}$/.test(session.incarnation)||
      !Number.isSafeInteger(session.epoch)||session.epoch<0)throw new TypeError("Invalid or retired session sequence");
    return `f2:${session.database}:${session.incarnation}:${session.epoch}:${session.id}:${sequence}`;
  }

  async retrySessionStatus(session:Pick<RetrySession,"id"|"incarnation">,options:RequestOptions={}):Promise<QueryResult<RetrySession>> {
    return this.sessionCommand({operation:"status",session:session.id,incarnation:session.incarnation},options);
  }

  /** Acknowledge only a durably consumed contiguous prefix. abandon explicitly fences unknown outcomes too. */
  async acknowledgeRetrySession(session:RetrySession,through:number,options:SessionOptions={}):Promise<QueryResult<RetrySession>> {
    return this.sessionCommand({operation:"ack",session:session.id,incarnation:session.incarnation,through,
      limit:options.limit??256,abandon:options.abandon??false},options);
  }

  /** Terminal: in-flight results may become unavailable; cleanup is bounded and may need later operator GC. */
  async closeRetrySession(session:RetrySession,options:SessionOptions={}):Promise<QueryResult<RetrySession>> {
    return this.sessionCommand({operation:"close",session:session.id,incarnation:session.incarnation,limit:options.limit??256},options);
  }

  private async sessionCommand(body:Record<string,unknown>,options:RequestOptions):Promise<QueryResult<RetrySession>> {
    return this.request("/v1/session",{...body,...await this.authorization(options)},{signal:options.signal});
  }

  private async request<T>(path: string, body: unknown, options: { admin?: boolean; signal?: AbortSignal; url?: string } = {}): Promise<T> {
    canonicalJson(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.admin && this.adminToken) headers.authorization = `Bearer ${this.adminToken}`;
    const response = await this.fetch((options.url ?? this.url) + path, {
      method: "POST", headers, body: JSON.stringify(body), signal: options.signal,
    });
    const text = await response.text();
    let data: any;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) {
      const message = typeof data?.error === "string" ? data.error :
        data?.error?.message ?? data?.message ?? (text || response.statusText);
      throw new FlowerError(message, response.status, data?.error?.code ?? data?.code ?? "HTTP_ERROR");
    }
    return data as T;
  }

  async initialize(members: Record<string, string>, options: RequestOptions = {}): Promise<void> {
    await this.request("/raft/initialize", members, { admin: true, signal: options.signal });
  }

  /** Operator-only metadata; private material is never returned. */
  async keyList(options: RequestOptions = {}): Promise<MutationResult<ManagedKeyCatalog>> {
    return this.request("/admin/keys", { operation: "list" }, { admin: true, signal: options.signal });
  }

  /** Node-local prepared-key cache across partitions; this does not route to an owner/leader. */
  async keyCacheStats(options: RequestOptions = {}): Promise<MutationResult<KeyCacheStats>> {
    return this.request("/admin/keys", { operation: "cache" }, { admin: true, signal: options.signal });
  }

  /** Generate within the native service; retain requestId on uncertain retries. */
  async keyGenerate(name: string, algorithm: ManagedKeyAlgorithm, options: KeyGenerateOptions = {}): Promise<MutationResult<ManagedKeyCatalog>> {
    return this.keyCommand({ operation: "generate", name, algorithm, ...(options.bits === undefined ? {} : { bits: options.bits }) }, options);
  }

  /** Import only an encrypted envelope produced by the native key seal command. */
  async keyImport(name: string, algorithm: ManagedKeyAlgorithm, sealed: SealedKeyImport, options: ControlOptions = {}): Promise<MutationResult<ManagedKeyCatalog>> {
    canonicalJson(sealed);
    if (sealed === null || typeof sealed !== "object" || Array.isArray(sealed) || sealed.version !== 1 ||
        Object.keys(sealed).length !== 4 || Object.keys(sealed).some(name => !["version", "wrappingId", "nonce", "ciphertext"].includes(name)) ||
        typeof sealed.wrappingId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(sealed.wrappingId) ||
        typeof sealed.nonce !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(sealed.nonce) ||
        typeof sealed.ciphertext !== "string" || !/^[A-Za-z0-9_-]{23,}$/.test(sealed.ciphertext) || sealed.ciphertext.length % 4 === 1) {
      throw new TypeError("Key import requires the encrypted envelope produced by native flower key seal");
    }
    return this.keyCommand({ operation: "import", name, algorithm, sealed }, options);
  }

  async keyBind(name: string, key: string, usages: readonly KeyUsage[], options: ControlOptions = {}): Promise<MutationResult<ManagedKeyCatalog>> {
    return this.keyCommand({ operation: "bind", name, key, usages }, options);
  }

  async keyUnbind(name: string, options: ControlOptions = {}): Promise<MutationResult<ManagedKeyCatalog>> {
    return this.keyCommand({ operation: "unbind", name }, options);
  }

  async keyRotate(name: string, options: KeyGenerateOptions = {}): Promise<MutationResult<ManagedKeyCatalog>> {
    return this.keyCommand({ operation: "rotate", name, ...(options.bits === undefined ? {} : { bits: options.bits }) }, options);
  }

  async keyRevoke(name: string, options: KeyRevokeOptions = {}): Promise<MutationResult<ManagedKeyCatalog>> {
    return this.keyCommand({ operation: "revoke", name, ...(options.version === undefined ? {} : { version: options.version }) }, options);
  }

  async keyRetire(name: string, options: KeyRevokeOptions = {}): Promise<MutationResult<ManagedKeyCatalog>> {
    return this.keyCommand({operation:"retire",name,...(options.version===undefined?{}:{version:options.version})},options);
  }
  async keyDestroy(name: string, options: KeyRevokeOptions = {}): Promise<MutationResult<ManagedKeyCatalog>> {
    return this.keyCommand({operation:"destroy",name,...(options.version===undefined?{}:{version:options.version})},options);
  }
  async keyRewrap(name: string, options: KeyRevokeOptions = {}): Promise<MutationResult<ManagedKeyCatalog>> {
    return this.keyCommand({operation:"rewrap",name,...(options.version===undefined?{}:{version:options.version})},options);
  }

  private async keyCommand(body: Record<string, unknown>, options: ControlOptions): Promise<MutationResult<ManagedKeyCatalog>> {
    return this.request("/admin/keys", { ...body, requestId: await this.automaticRequestId(options) }, { admin: true, signal: options.signal });
  }

  /** Stable gateway URL for one logical database; ownership is resolved by servers.
   * Identical keys and request IDs in different partitions remain independent.
   */
  partition(name: string): FlowerClient {
    if (!name.trim() || /[\u0000-\u001f\u007f]/u.test(name)) throw new TypeError("Partition name must be nonempty and contain no control characters");
    const path = "/partitions/" + encodeURIComponent(name);
    return new FlowerClient(this.url + path, { adminToken: this.adminToken, fetch: this.fetch,
      credentials: this.credentials,
      boundedRetries: this.boundedRetries,
      queryUrls: this.queryUrls.map((url) => url + path) });
  }

  /** Fresh operator view of registered groups, placements and durable moves. */
  async layout(options: RequestOptions = {}): Promise<ClusterLayout> {
    return this.request("/admin/partitions/catalog", { action: "list" }, { admin: true, signal: options.signal });
  }

  async registerGroup(group: ClusterGroup, options: RequestOptions = {}): Promise<ClusterGroup> {
    return this.request("/admin/partitions/catalog", { action: "register_group", group }, { admin: true, signal: options.signal });
  }

  /** Unregisters an empty, unreferenced worker group; does not stop its processes. */
  async removeGroup(group: string, options: RequestOptions = {}): Promise<{ removed: string }> {
    return this.request("/admin/partitions/catalog", { action: "remove_group", group }, { admin: true, signal: options.signal });
  }

  /** Durably starts creation. Wait for active before deploying the application. */
  async createPartition(partition: string, group: string, options: ControlOptions = {}): Promise<PartitionPlacement> {
    return this.request("/admin/partitions/catalog", { action: "create", partition, group,
      operation: options.requestId ?? crypto.randomUUID() }, { admin: true, signal: options.signal });
  }

  /** Copies while serving, then briefly pauses this partition for final changes and ownership cutover. */
  async movePartition(partition: string, destination: string, options: ControlOptions = {}): Promise<PartitionMove> {
    return this.request("/admin/partitions/catalog", { action: "begin_move", partition, destination,
      operation: options.requestId ?? crypto.randomUUID() }, { admin: true, signal: options.signal });
  }

  /** Balances partition counts over existing groups, moving one partition at a time.
   * This neither provisions replicas nor balances measured CPU/data size.
   */
  async resize(groups: string[], options: ControlOptions = {}): Promise<RebalancePlan> {
    return this.request("/admin/partitions/catalog", { action: "rebalance", groups,
      operation: options.requestId ?? crypto.randomUUID() }, { admin: true, signal: options.signal });
  }

  async partitionStatus(partition: string, options: RequestOptions = {}): Promise<PartitionPlacement> {
    return this.request("/admin/partitions/catalog", { action: "resolve", partition }, { admin: true, signal: options.signal });
  }

  /** Waits for creation/movement to activate the owner. Cancellation does not undo
   * the durable operation; use the same operation ID to inspect/retry it.
   */
  async waitForPartition(partition: string, options: PartitionWaitOptions = {}): Promise<PartitionPlacement> {
    const timeoutMs = options.timeoutMs ?? 30_000, intervalMs = options.intervalMs ?? 100;
    for (const [name, value] of Object.entries({ timeoutMs, intervalMs })) {
      if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) throw new TypeError(`${name} must be a positive integer within the timer range`);
    }
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new FlowerError("Timed out waiting for partition activation", 0, "PARTITION_WAIT_TIMEOUT")), timeoutMs);
    try {
      while (true) {
        signal.throwIfAborted();
        const placement = await this.partitionStatus(partition, { signal });
        signal.throwIfAborted();
        if (placement.status === "active") return placement;
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(poll); signal.removeEventListener("abort", done); resolve(); };
          const poll = setTimeout(done, intervalMs); signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
    } finally { clearTimeout(timer); }
  }

  async deploy(bundle: Bundle, options: DeploymentOptions = {}): Promise<DeploymentReceipt> {
    const request: Record<string, unknown> = { requestId: await this.automaticRequestId(options), bundle };
    if (options.preparation !== undefined) {
      if (options.preparation !== "online" && options.preparation !== "blocking") throw new TypeError("preparation must be online or blocking");
      request.preparation = options.preparation;
    }
    return this.request("/admin/deploy", request, { admin: true, signal: options.signal });
  }

  /** Start or recover the same durable deployment job. Preserve requestId after uncertain responses. */
  async stageDeployment(bundle: Bundle, options: ControlOptions = {}): Promise<QueryResult<StagedDeploymentState>> {
    return this.request("/admin/deployments", {
      operation: "stage", requestId: await this.automaticRequestId(options), bundle,
    }, { admin: true, signal: options.signal });
  }

  async stagedDeploymentStatus(options: RequestOptions = {}): Promise<QueryResult<StagedDeploymentState | null>> {
    return this.request("/admin/deployments", { operation: "status" }, { admin: true, signal: options.signal });
  }

  /** Advance index/graph preparation, activate a ready job, cancel, or collect obsolete state. */
  async controlStagedDeployment(action: StagedDeploymentAction, options: RequestOptions = {}): Promise<QueryResult<StagedDeploymentState>> {
    return this.request("/admin/deployments", action, { admin: true, signal: options.signal });
  }

  async query<Args = Json, Value = Json>(
    name: string, args: Args = null as Args, options: RequestOptions = {},
  ): Promise<QueryResult<Value>> {
    return this.request("/v1/query", { name, args, ...await this.authorization(options) }, { signal: options.signal, url: this.queryUrl() });
  }

  /** Keep requestId when retrying after an uncertain response; the original result is preserved. */
  async mutate<Args = Json, Value = Json>(
    name: string, args: Args = null as Args, options: MutationOptions = {},
  ): Promise<MutationResult<Value>> {
    const request: Record<string, unknown> = {
      name, args,
      ...await this.authorization(options),
      requestId: await this.automaticRequestId(options),
    };
    if (options.expectedRevision !== undefined) request.expectedRevision = options.expectedRevision;
    return this.request("/v1/mutate", request, { signal: options.signal });
  }

  /** Invoke an HTTP alias; deployed code decides whether it is a query or mutation. */
  async call<Args = Json, Value = Json>(
    name: string, args: Args = null as Args, options: MutationOptions = {},
  ): Promise<MutationResult<Value>> {
    const request: Record<string, unknown> = { name, args, requestId: await this.automaticRequestId(options), ...await this.authorization(options) };
    if (options.expectedRevision !== undefined) request.expectedRevision = options.expectedRevision;
    return this.request("/v1/call", request, { signal: options.signal });
  }

  /** Stream a named query; equal values are suppressed even when revision changes. */
  watch<Args = Json, Value = Json>(
    name: string, args: Args = null as Args, options: WatchOptions = {},
  ): AsyncGenerator<QueryResult<Value>> {
    const client = this;
    const budgets = watchBudgets(options);
    return controlledWatch(options.signal, async function* (signal) {
      let baseline: Json = null;
      try {
        for await (const event of client.watchDeltas<Args, Json>(name, args, { ...options, ...budgets, signal })) {
          baseline = event.type === "snapshot" ? cloneWatchValue(event.value) : applyWatchPatch(baseline, event.patch, budgets);
          yield { revision: event.revision, value: cloneWatchValue(baseline) as Value };
        }
      } catch (error) {
        if (error instanceof WatchProtocolError) throw new FlowerError(error.message, 0, "WATCH_PROTOCOL_ERROR");
        throw error;
      }
    });
  }

  /** Raw SSE snapshot/patch events. Each call starts with a full snapshot at the producer’s current sequence; no automatic reconnect. */
  watchDeltas<Args = Json, Value = Json>(
    name: string, args: Args = null as Args, options: WatchOptions = {},
  ): AsyncGenerator<WatchDelta<Value>> {
    const client = this;
    const budgets = watchBudgets(options);
    return controlledWatch(options.signal, async function* (signal) {
      if (options.intervalMs !== undefined) throw new TypeError("intervalMs is only supported by watchPoll(); watch() uses SSE");
      canonicalJson({ name, args });
      const response = await client.fetch(client.queryUrl() + "/v1/watch", {
        method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ name, args, ...await client.authorization(options) }), signal,
      });
      try {
        if (!response.ok) {
          // Error bodies are bounded independently of the indefinitely long stream.
          const reader = response.body?.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          const cancel = () => { void reader?.cancel(signal.reason).catch(() => {}); };
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
          if (reader) try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              if ((bytes += next.value.byteLength) > budgets.maxEventBytes) throw new FlowerError("Watch HTTP error body exceeds maxEventBytes", response.status, "HTTP_ERROR");
              chunks.push(next.value);
            }
          } finally { signal.removeEventListener("abort", cancel); void reader.cancel().catch(() => {}); reader.releaseLock(); }
          else signal.removeEventListener("abort", cancel);
          const buffer = new Uint8Array(bytes);
          let offset = 0;
          for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
          const text = new TextDecoder().decode(buffer);
          let value: any;
          try { value = JSON.parse(text); } catch { value = null; }
          throw new FlowerError(value?.error?.message ?? text ?? response.statusText, response.status, value?.error?.code ?? "HTTP_ERROR");
        }
        if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "text/event-stream" || !response.body) {
          throw new FlowerError("Expected a text/event-stream response body", response.status, "WATCH_PROTOCOL_ERROR");
        }
        let sequence = -1, revision = -1;
        for await (const frame of readSse(response.body, signal, budgets.maxEventBytes)) {
          const event = decodeWatchEvent(frame, sequence, revision, budgets);
          if (event.type === "error") throw new FlowerError(event.error.message, event.error.status, event.error.code);
          sequence = event.sequence; revision = event.revision;
          yield event as WatchDelta<Value>;
        }
        if (!signal.aborted && sequence < 0) throw new FlowerError("Watch ended before its initial snapshot", 0, "WATCH_PROTOCOL_ERROR");
      } catch (error) {
        if (error instanceof WatchProtocolError) throw new FlowerError(error.message, 0, "WATCH_PROTOCOL_ERROR");
        throw error;
      } finally { if (!response.body?.locked) void response.body?.cancel().catch(() => {}); }
    });
  }

  /** Explicit polling compatibility API; emits revision changes even for equal values. */
  watchPoll<Args = Json, Value = Json>(
    name: string, args: Args = null as Args, options: WatchPollOptions = {},
  ): AsyncGenerator<QueryResult<Value>> {
    const client = this;
    const { intervalMs = 250 } = options;
    if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) throw new TypeError("Polling intervalMs must be an integer from 1 to 2147483647 milliseconds");
    return controlledWatch(options.signal, async function* (signal) {
      const url = client.queryUrl();
      let revision: number | undefined;
      let value: string | undefined;
      while (!signal.aborted) {
        const result = await client.request<QueryResult<Value>>("/v1/query", {
          name, args, ...await client.authorization(options),
        }, { signal, url });
        const nextValue = canonicalJson(result.value);
        if (result.revision !== revision || nextValue !== value) {
          revision = result.revision;
          value = nextValue;
          yield result;
        }
        await new Promise<void>((resolve) => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
          const timer = setTimeout(finish, intervalMs);
          signal.addEventListener("abort", finish, { once: true });
          if (signal.aborted) finish();
        });
      }
    });
  }
}
