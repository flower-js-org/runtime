import type { Collection, Context, Derived, Json } from "./index.ts";
import { canonicalJson } from "./json.ts";

/** Scalar ordering is null, false, true, number, then UTF-16 string order. */
export type IndexScalar = null | boolean | number | string;
export interface ScanOptions {
  /** Declared index name. Omit to walk source keys in UTF-16 order. */
  readonly index?: string;
  /** Equality on initial indexed fields; bounds select the next field.
   * Without an index, use [] or [exactSourceKey] and string bounds.
   */
  readonly prefix?: readonly IndexScalar[];
  readonly gt?: IndexScalar;
  readonly gte?: IndexScalar;
  readonly lt?: IndexScalar;
  readonly lte?: IndexScalar;
  /** Nonnegative safe integer; omitted returns all remaining matching rows. */
  readonly limit?: number;
  /** Nonnegative safe integer; skip matching rows in traversal order. Defaults to 0. */
  readonly offset?: number;
  /** Reverse the complete index tuple and source-key order. Defaults to false. */
  readonly reverse?: boolean;
}
export interface RangeOptions {
  /** Equality on initial indexed fields; bounds select the next field. */
  readonly prefix?: readonly IndexScalar[];
  readonly gt?: IndexScalar;
  readonly gte?: IndexScalar;
  readonly lt?: IndexScalar;
  readonly lte?: IndexScalar;
  readonly limit: number;
  readonly after?: string;
  readonly reverse?: boolean;
}
export interface RangeQuery<T> {
  readonly kind: "range";
  readonly collection: string;
  readonly fields: readonly string[];
  readonly options: RangeOptions;
  readonly __recordType?: T;
}
export interface RangePage<T> {
  readonly rows: { key: string; value: T }[];
  /** Continuation against the next invocation's snapshot, not a pinned snapshot. */
  readonly cursor: string | null;
}

/** Internal builder shared by collection index references. */
export function rangeQuery<T>(collection: string, columns: readonly string[], value: RangeOptions): RangeQuery<T> {
  const input = data(value, "Range options");
  if (Object.keys(input).some((key) => !["prefix", "gt", "gte", "lt", "lte", "limit", "after", "reverse"].includes(key))) {
    throw new TypeError("Unknown range option");
  }
  const scalar = (part: unknown): IndexScalar => {
    if (part === null || typeof part === "boolean" || typeof part === "string") return part;
    if (typeof part === "number" && Number.isFinite(part)) return part === 0 ? 0 : part;
    throw new TypeError("Ordered index components must be null, boolean, finite number or string");
  };
  if (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1) throw new TypeError("Range limit must be a positive safe integer");
  const prefix = Object.hasOwn(input, "prefix") ? input.prefix : [];
  if (!Array.isArray(prefix) || prefix.length > columns.length) throw new TypeError("Invalid range prefix");
  canonicalJson(prefix); // Validate descriptors before reading caller-provided arrays.
  const copied = Array.from(prefix, scalar);
  const bounds = ["gt", "gte", "lt", "lte"] as const;
  if ((copied.length === columns.length && bounds.some((key) => Object.hasOwn(input, key))) ||
      (Object.hasOwn(input, "gt") && Object.hasOwn(input, "gte")) ||
      (Object.hasOwn(input, "lt") && Object.hasOwn(input, "lte"))) throw new TypeError("Invalid range bounds");
  const options: Record<string, unknown> = { prefix: Object.freeze(copied), limit: input.limit };
  for (const bound of bounds) if (Object.hasOwn(input, bound)) options[bound] = scalar(input[bound]);
  if (Object.hasOwn(input, "after")) {
    if (typeof input.after !== "string") throw new TypeError("Range cursor must be a string");
    options.after = input.after;
  }
  if (Object.hasOwn(input, "reverse")) {
    if (typeof input.reverse !== "boolean") throw new TypeError("Range reverse must be boolean");
    options.reverse = input.reverse;
  }
  return Object.freeze({ kind: "range", collection, fields: columns, options: Object.freeze(options) as unknown as RangeOptions });
}

export interface AggregateMetadata {
  readonly collection: string;
  readonly fields: readonly string[];
}
export interface Aggregate<T = Json> extends Derived<Json, T> {
  readonly aggregate: AggregateMetadata;
}
export interface AggregateOptions<Row, Value> {
  source: Collection<Row>;
  index: string;
  initial: (group: Json) => Value;
  add: (value: Value, row: Row, key: string, group: Json) => Value;
  remove: (value: Value, row: Row, key: string, group: Json) => Value;
}
export interface CollectionManifest {
  readonly name: string;
  readonly indexes: Readonly<Record<string, readonly string[]>>;
}

function data(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !property.enumerable || !("value" in property)) {
      throw new TypeError(`${label} requires enumerable data properties`);
    }
  }
  return value as Record<string, unknown>;
}
function name(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value) throw new TypeError(`${label} must be a nonempty string`);
}
function fields(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || [...value].some((field) => typeof field !== "string" || !field) ||
      new Set(value).size !== value.length) {
    throw new TypeError("Index fields must be distinct nonempty strings");
  }
  return Object.freeze([...value]) as readonly string[];
}

/** Validate the serializable metadata attached to an incremental derived value. */
export function normalizeAggregateMetadata(value: unknown): AggregateMetadata {
  const metadata = data(value, "Aggregate metadata");
  if (Object.keys(metadata).some((key) => !["collection", "fields"].includes(key))) {
    throw new TypeError("Aggregate metadata accepts only collection and fields");
  }
  name(metadata.collection, "Aggregate collection");
  return Object.freeze({ collection: metadata.collection, fields: fields(metadata.fields) });
}

/** Snapshot collection declarations into the code-owned deployment manifest. */
export function collectionManifest(value: unknown): readonly CollectionManifest[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError("collections must be an array");
  const seen = new Set<string>();
  return Object.freeze(value.map((reference: Collection<unknown>) => {
    // Collection references deliberately have nonenumerable index/by methods.
    // Inspect their serializable fields without evaluating any getters.
    for (const field of ["kind", "name", "indexes"]) {
      const property = Object.getOwnPropertyDescriptor(reference, field);
      if (!property || !("value" in property)) throw new TypeError("collections requires collection references");
    }
    if (reference.kind !== "collection") throw new TypeError("collections requires collection references");
    name(reference.name, "Collection name");
    if (seen.has(reference.name)) throw new TypeError(`Duplicate collection ${JSON.stringify(reference.name)}`);
    seen.add(reference.name);
    const declared = data(reference.indexes, "Collection indexes");
    const indexes: Record<string, readonly string[]> = Object.create(null);
    for (const [index, columns] of Object.entries(declared)) {
      name(index, "Index name");
      indexes[index] = fields(columns);
    }
    return Object.freeze({ name: reference.name, indexes: Object.freeze(indexes) });
  }));
}

/**
 * Incrementally maintain one accumulator per indexed equality value.
 * add/remove must be deterministic, order-independent inverse operations.
 * Floating point sums can depend on update order; use integer units when exact
 * equality matters. Callbacks receive no database context. Redeploy rebuilds.
 */
export function aggregate<Row, Value>(
  definitionName: string, options: AggregateOptions<Row, Value>,
): Aggregate<Value> {
  name(definitionName, "Aggregate name");
  const settings = data(options, "Aggregate options");
  if (Object.keys(settings).some((key) => !["source", "index", "initial", "add", "remove"].includes(key))) {
    throw new TypeError("Aggregate options accept only source, index, initial, add, and remove");
  }
  const declaration = collectionManifest([options.source])[0];
  name(options.index, "Aggregate index");
  if (!Object.hasOwn(declaration.indexes, options.index)) throw new TypeError(`Unknown aggregate index ${JSON.stringify(options.index)}`);
  for (const callback of ["initial", "add", "remove"] as const) {
    if (typeof options[callback] !== "function") throw new TypeError(`Aggregate ${callback} must be a function`);
  }
  const metadata = normalizeAggregateMetadata({ collection: declaration.name, fields: declaration.indexes[options.index] });
  const { initial, add, remove } = options;
  const compute = (_ctx: Context, raw: Json): Value => {
    const update = raw as unknown as {
      initialize: boolean; group: Json; previous: Value;
      changes: { key: string; old?: Row; new?: Row }[];
    };
    let value = update.initialize ? initial(update.group) : update.previous;
    for (const change of update.changes) {
      if (Object.hasOwn(change, "old")) value = remove(value, change.old!, change.key, update.group);
      if (Object.hasOwn(change, "new")) value = add(value, change.new!, change.key, update.group);
    }
    return value;
  };
  return Object.freeze({ kind: "derived", name: definitionName, compute, aggregate: metadata });
}
