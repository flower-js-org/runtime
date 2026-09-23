import { collectionManifest, normalizeAggregateMetadata, rangeQuery } from "./indexing.ts";
import type { AggregateMetadata, CollectionManifest, ScanOptions, RangeOptions, RangeQuery, RangePage } from "./indexing.ts";
export { aggregate } from "./indexing.ts";
export type { Aggregate, AggregateOptions, AggregateMetadata, CollectionManifest, IndexScalar, ScanOptions, RangeOptions, RangeQuery, RangePage } from "./indexing.ts";
import { canonicalJson } from "./json.ts";
import { keyManifest } from "./keys.ts";
import type { ManagedKey } from "./keys.ts";
export { key } from "./keys.ts";
export type { ManagedKey, ManagedKeyVersion, ManagedKeyAlgorithm, KeyUsage, KeyOptions, SharedKey } from "./keys.ts";
export { canonicalJson } from "./json.ts";
export { nacl, jwt, publicKey, keyVersion } from "./crypto.ts";
export type { NaClKeyPair, NaClPRNG, JWTAlgorithm, JWTKey, JWTKeyFormat, JWTClaims, JWTSignOptions, ManagedJWTSignOptions, ManagedJWTVerifyOptions, JWTValidationOptions, JWTVerifyOptions, JWTEncryptOptions, JWTProtectedHeader, JWTVerified } from "./crypto.ts";

/** JSON is Flower's durable value format. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Query<T> {
  readonly kind: "query";
  readonly collection: string;
  readonly fields: readonly string[];
  readonly value: Json;
  /** Carries the record type; it has no runtime representation. */
  readonly __recordType?: T;
}

export interface Collection<T> {
  readonly kind: "collection";
  readonly name: string;
  readonly indexes: Readonly<Record<string, readonly string[]>>;
  index(name: string, fields: readonly (keyof T & string)[]): Collection<T>;
  by(name: string): { eq(value: Json): Query<T>; range(options: RangeOptions): RangeQuery<T> };
}

export interface Derived<Args = Json, Value = Json> {
  readonly kind: "derived";
  readonly name: string;
  readonly compute: (ctx: Context, args: Args) => Value;
  readonly aggregate?: AggregateMetadata;
}

export interface Context {
  /** Trusted server milliseconds, fixed for this invocation; tracks a time dependency. */
  now(): number;
  /** Missing source records return null. Errors in derived values propagate. */
  get<T>(reference: Collection<T>, key: string): T | null;
  get<Args, Value>(reference: Derived<Args, Value>, args: Args): Value;
  /** Constrain an ordered index or source-key walk, then apply offset and limit. */
  scan<T>(reference: Collection<T>, options?: ScanOptions): { key: string; value: T }[];
  query<T>(reference: Query<T>): T[];
  /** Ordered bounded reads; declared indexes seek, undeclared indexes scan in Rust. */
  range<T>(reference: RangeQuery<T>): RangePage<T>;
}

export interface Principal {
  readonly subject: string;
  readonly tenant?: string;
  readonly claims?: Json;
}
export interface AuthorizationRequest {
  readonly credentials: Json;
  readonly method: string;
  readonly args: Json;
  readonly partition: string | null;
  /** Present only on an authenticated participant RPC. The local hook decides which coordinators to trust. */
  readonly delegation: { readonly coordinator: string; readonly principal: Principal | null } | null;
}
export interface HistoryIdentity { readonly database:string; readonly incarnation:string }
export interface QueryContext extends Context {
  /** Stable across movement; changes on explicitly fenced disaster restore. Null before retention initialization. */
  history(): HistoryIdentity | null;
  /** Authenticated by the deployed authorization hook; never supplied by caller arguments. */
  principal(): Principal | null;
}
export interface MutationContext extends QueryContext {
  set<T>(reference: Collection<T>, key: string, value: T): void;
  delete<T>(reference: Collection<T>, key: string): void;
  materialize<Args, Value>(reference: Derived<Args, Value>, args: Args): void;
  unmaterialize<Args, Value>(reference: Derived<Args, Value>, args: Args): void;
}

export type QueryConsistency = "linearizable" | "replica-local";
export interface QueryOptions {
  /** Fresh by default. Replica-local reads may lag and can run without quorum after startup recovery; authorization hooks and managed keys still require fresh policy. */
  readonly consistency?: QueryConsistency;
}

export interface QueryMethod<Args = Json, Value = Json> {
  readonly kind: "queryMethod";
  readonly name: string;
  readonly compute: (ctx: QueryContext, args: Args) => Value;
  readonly consistency?: QueryConsistency;
}

export interface MutationMethod<Args = Json, Value = Json> {
  readonly kind: "mutationMethod";
  readonly name: string;
  readonly compute: (ctx: MutationContext, args: Args) => Value;
}

export type TransactionCall = ({readonly group:string;readonly partition?:never} | {readonly partition:string;readonly group?:never}) & {
  readonly method: string;
  readonly args?: Json;
}
export interface TransactionPlan<Value = Json> {
  readonly calls: readonly TransactionCall[];
  readonly value?: Value;
}
export interface TransactionMethod<Args = Json, Value = Json> {
  readonly kind: "transactionMethod";
  readonly name: string;
  readonly compute: (ctx: Context, args: Args) => TransactionPlan<Value>;
}
export type Definition = Derived<any, any> | QueryMethod<any, any> | MutationMethod<any, any> | TransactionMethod<any, any>;
export type HttpMethod = QueryMethod<any, any> | MutationMethod<any, any> | TransactionMethod<any, any>;
export interface MaintenanceFailure { error: { code: string; message: string }; failedAt: number }
/** Return this hint from maintenance to request another separately committed
 * invocation. The host stops catch-up after a call takes the writer turn past its
 * configured maintenance time budget (50 ms by default);
 * idle invocations always stop. Omit the hint to keep the normal 250 ms cadence.
 */
export interface MaintenanceContinuation { $flower: { continue: boolean } }
export interface MaintenanceHandlers {
  run: MutationMethod<any, any>;
  onError: MutationMethod<MaintenanceFailure, any>;
}
export interface MaintenanceManifest {
  readonly name: string;
  readonly kind: "mutation";
  readonly onError?: Readonly<{ name: string; kind: "mutation" }>;
}
export interface ModuleConfig {
  /** Pure query run before every public call, retry, cached result and watch refresh. Return null to deny. */
  authorize?: QueryMethod<AuthorizationRequest, Principal | null>;
  keys?: readonly ManagedKey[];
  collections?: readonly Collection<any>[];
  definitions?: readonly Definition[];
  http?: Readonly<Record<string, HttpMethod>>;
  maintenance?: MutationMethod<any, any> | MaintenanceHandlers;
}
export interface FlowerModule {
  readonly authorize?: Readonly<{ name: string }>;
  readonly keys?: readonly ManagedKey[];
  readonly collections?: readonly CollectionManifest[];
  readonly definitions: Readonly<Record<string, Definition>>;
  readonly http: Readonly<Record<string, Readonly<
    { name: string; kind: "query"; consistency?: QueryConsistency } | { name: string; kind: "mutation" | "transaction" }
  >>>;
  readonly maintenance: MaintenanceManifest | null;
}

function checkName(name: string, label: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
}

/** Declare a namespaced source collection with optional equality and ordered indexes. */
export function collection<T = Record<string, Json>>(name: string): Collection<T> {
  checkName(name, "Collection name");
  const indexes: Record<string, readonly string[]> = Object.create(null);
  const reference = { kind: "collection", name, indexes } as Collection<T>;
  Object.defineProperties(reference, {
    index: {
      value(indexName: string, fields: readonly string[]) {
        checkName(indexName, "Index name");
        if (!Array.isArray(fields) || fields.length === 0 ||
            fields.some((field) => typeof field !== "string" || field.length === 0)) {
          throw new TypeError("An index requires one or more field names");
        }
        if (new Set(fields).size !== fields.length) {
          throw new TypeError("Index field names must be distinct");
        }
        if (Object.hasOwn(indexes, indexName)) {
          throw new TypeError(`Index ${JSON.stringify(indexName)} is already declared`);
        }
        indexes[indexName] = Object.freeze([...fields]);
        return reference;
      },
    },
    by: {
      value(indexName: string) {
        if (!Object.hasOwn(indexes, indexName)) {
          throw new TypeError(`Unknown index ${JSON.stringify(indexName)} on ${name}`);
        }
        const fields = indexes[indexName];
        return {
          range(options: RangeOptions): RangeQuery<T> { return rangeQuery(name, fields, options); },
          eq(value: Json): Query<T> {
            canonicalJson(value);
            if (fields.length > 1 && (!Array.isArray(value) || value.length !== fields.length)) {
              throw new TypeError(`Index ${JSON.stringify(indexName)} requires a ${fields.length}-element tuple`);
            }
            return { kind: "query", collection: name, fields, value };
          },
        };
      },
    },
  });
  return Object.freeze(reference);
}

/** Declare a synchronous, pure reactive function. */
export function derive<Args, Value>(
  name: string,
  compute: (ctx: Context, args: Args) => Value,
): Derived<Args, Value> {
  checkName(name, "Definition name");
  if (typeof compute !== "function") throw new TypeError("A definition requires a compute function");
  return Object.freeze({ kind: "derived", name, compute });
}

/** Declare a private read-only method. Expose it explicitly in define({ http }). */
export function query<Args, Value>(
  name: string, compute: (ctx: QueryContext, args: Args) => Value,
  options?: QueryOptions,
): QueryMethod<Args, Value> {
  checkName(name, "Method name");
  if (typeof compute !== "function") throw new TypeError("A query requires a compute function");
  if (options === undefined) return Object.freeze({ kind: "queryMethod", name, compute });
  const setting = plainDataObject(options, "Query options");
  if (Object.keys(setting).some((key) => key !== "consistency")) {
    throw new TypeError("Query options accept only consistency");
  }
  if (Object.hasOwn(setting, "consistency") && !["linearizable", "replica-local"].includes(setting.consistency as string)) {
    throw new TypeError("Query consistency must be linearizable or replica-local");
  }
  return Object.freeze({
    kind: "queryMethod", name, compute,
    ...(setting.consistency === "replica-local" ? { consistency: "replica-local" as const } : {}),
  });
}

/** Declare a private atomic method. Expose it explicitly in define({ http }). */
export function mutation<Args, Value>(
  name: string, compute: (ctx: MutationContext, args: Args) => Value,
): MutationMethod<Args, Value> {
  checkName(name, "Method name");
  if (typeof compute !== "function") throw new TypeError("A mutation requires a compute function");
  return Object.freeze({ kind: "mutationMethod", name, compute });
}

/** Declare an atomic cross-group operation as a pure, code-owned call plan.
 * Each participant invokes exposed methods. All groups commit or none do.
 * Planning cannot read database state; put validations in participant methods.
 */
export function transaction<Args, Value = Json>(
  name: string, plan: (args: Args) => TransactionPlan<Value>,
): TransactionMethod<Args, Value> {
  checkName(name, "Transaction name");
  if (typeof plan !== "function") throw new TypeError("A transaction requires a plan function");
  return Object.freeze({ kind: "transactionMethod", name, compute: (_ctx: Context, args: Args) => plan(args) });
}

function plainDataObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} requires enumerable string properties without accessors`);
    }
  }
  return value as Record<string, unknown>;
}

function validateDefinition(value: unknown): Definition {
  const definition = plainDataObject(value, "Definition");
  const keys = Object.keys(definition);
  if (keys.length !== (3 + Number(Object.hasOwn(definition, "consistency")) + Number(Object.hasOwn(definition, "aggregate"))) ||
      !keys.every((key) => ["kind", "name", "compute", "consistency", "aggregate"].includes(key)) ||
      !["derived", "queryMethod", "mutationMethod", "transactionMethod"].includes(definition.kind as string) ||
      typeof definition.compute !== "function") {
    throw new TypeError("A definition requires kind, name, and compute fields");
  }
  if (Object.hasOwn(definition, "consistency") && (definition.kind !== "queryMethod" ||
      !["linearizable", "replica-local"].includes(definition.consistency as string))) {
    throw new TypeError("Consistency requires a query method and linearizable or replica-local");
  }
  if (Object.hasOwn(definition, "aggregate")) {
    if (definition.kind !== "derived") throw new TypeError("Aggregate metadata requires a derived definition");
    normalizeAggregateMetadata(definition.aggregate);
  }
  checkName(definition.name as string, "Definition name");
  return definition as unknown as Definition;
}

/** Define private internals and the complete code-owned HTTP allowlist. */
export function define(config: ModuleConfig = {}): FlowerModule {
  const options = plainDataObject(config, "Module configuration");
  if (Object.keys(options).some((key) => !["definitions", "http", "maintenance", "collections", "keys", "authorize"].includes(key))) {
    throw new TypeError("Module configuration accepts only definitions, http, maintenance, collections, keys, and authorize");
  }
  const collections = collectionManifest(options.collections);
  const keys = keyManifest(options.keys);
  const privateDefinitions = Object.hasOwn(options, "definitions") ? options.definitions : undefined;
  const httpDefinitions = Object.hasOwn(options, "http") ? options.http : undefined;
  if (privateDefinitions !== undefined && !Array.isArray(privateDefinitions)) {
    throw new TypeError("definitions must be an array");
  }
  const definitions: Record<string, Definition> = Object.create(null);
  const http: Record<string, FlowerModule["http"][string]> = Object.create(null);
  const originals = new Map<string, Definition>();
  function register(value: unknown): Definition {
    const definition = validateDefinition(value);
    if (originals.has(definition.name) && originals.get(definition.name) !== definition) {
      throw new TypeError(`Conflicting definition ${JSON.stringify(definition.name)}`);
    }
    if (!originals.has(definition.name)) {
      originals.set(definition.name, definition);
      definitions[definition.name] = Object.freeze({
        kind: definition.kind, name: definition.name, compute: definition.compute,
        ...(definition.kind === "derived" && definition.aggregate !== undefined ?
          { aggregate: normalizeAggregateMetadata(definition.aggregate) } : {}),
        ...(definition.kind === "queryMethod" && definition.consistency === "replica-local" ?
          { consistency: "replica-local" as const } : {}),
      }) as Definition;
    }
    return definition;
  }
  for (const definition of (privateDefinitions ?? []) as unknown[]) register(definition);
  if (httpDefinitions !== undefined) {
    const exposed = plainDataObject(httpDefinitions, "HTTP allowlist");
    for (const alias of Object.keys(exposed)) {
      checkName(alias, "HTTP alias");
      const definition = register(exposed[alias]);
      if (definition.kind === "derived") throw new TypeError("Only query, mutation, and transaction methods may be exposed over HTTP");
      http[alias] = Object.freeze({
        name: definition.name, kind: definition.kind === "queryMethod" ? "query" : definition.kind === "transactionMethod" ? "transaction" : "mutation",
        ...(definition.kind === "queryMethod" && definition.consistency === "replica-local" ?
          { consistency: "replica-local" as const } : {}),
      });
    }
  }
  let maintenance: MaintenanceManifest | null = null;
  if (Object.hasOwn(options, "maintenance") && options.maintenance !== undefined) {
    const setting = plainDataObject(options.maintenance, "Maintenance configuration");
    if (Object.hasOwn(setting, "kind")) {
      const definition = register(setting);
      if (definition.kind !== "mutationMethod") throw new TypeError("Maintenance must be a mutation method");
      maintenance = Object.freeze({ name: definition.name, kind: "mutation" });
    } else {
      const keys = Object.keys(setting);
      if (keys.length !== 2 || !Object.hasOwn(setting, "run") || !Object.hasOwn(setting, "onError")) {
        throw new TypeError("Maintenance configuration requires run and onError mutation methods");
      }
      const run = register(setting.run);
      const onError = register(setting.onError);
      if (run.kind !== "mutationMethod" || onError.kind !== "mutationMethod") {
        throw new TypeError("Maintenance run and onError must be mutation methods");
      }
      maintenance = Object.freeze({
        name: run.name, kind: "mutation", onError: Object.freeze({ name: onError.name, kind: "mutation" }),
      });
    }
  }
  let authorize: Readonly<{ name: string }> | undefined;
  if (options.authorize !== undefined) {
    const definition = register(options.authorize);
    if (definition.kind !== "queryMethod" || definition.consistency === "replica-local") {
      throw new TypeError("Authorization requires a fresh read-only query method");
    }
    authorize = Object.freeze({ name: definition.name });
  }
  return Object.freeze({ definitions: Object.freeze(definitions), http: Object.freeze(http), maintenance,
    ...(authorize ? { authorize } : {}),
    ...(collections.length ? { collections } : {}),
    ...(keys.length ? { keys } : {}),
  });
}


export { FlowerClient, FlowerError } from "./client.ts";
export type { StagedDeploymentState, StagedDeploymentAction, TransactionClosureTarget, TransactionClosureState, TransactionClosureAction, RetryIdentity, RetrySession, SessionOptions, RetentionState, RetentionAction, ClusterGroup, PartitionMovePhase, PartitionMove, PartitionPlacement, RebalanceMove, RebalancePlan, ClusterLayout, ControlOptions, KeyGenerateOptions, KeyRevokeOptions, SealedKeyImport, ManagedKeyCatalog, KeyCacheStats, PartitionWaitOptions, MutationOptions, MutationResult, QueryResult, DeploymentReceipt, DeploymentOptions, WatchOptions, WatchPollOptions, Bundle, RequestOptions, FlowerClientOptions, FlowerFetch, FlowerRequestInit } from "./client.ts";
export type { WatchDelta, WatchSnapshot, WatchPatch, JsonPatchOperation } from "./watch.ts";
