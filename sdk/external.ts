import { canonicalJson, type Json } from "./json.ts";
import { collection, component, derive, fail, mutation, plainObject, query, requireName, trigger } from "./core.ts";
import type { Access, Collection, Component, Context, Derived, MutationContext, MutationMethod, QueryMethod } from "./core.ts";
import { schema as adopt, v, ValidationError, type SchemaLike } from "./schema.ts";

export type ExternalState<R> = { readonly status: "pending" } | { readonly status: "ready"; readonly value: R };
export interface ExternalWork<A, I> { readonly args: A; readonly key: string; readonly input: I }
export interface ExternalNextOptions { readonly limit?: number; readonly shard?: readonly [index: number, count: number] }

export type ExternalHttp<Prefix extends string, A, I, R, Pool extends boolean> = {
  readonly [K in `${Prefix}.pending`]: QueryMethod<A, ExternalWork<A, I> | null>;
} & {
  readonly [K in `${Prefix}.publish`]: MutationMethod<{ args: A; key: string; value: R }, { accepted: boolean }>;
} & (Pool extends true ? { readonly [K in `${Prefix}.next`]: QueryMethod<ExternalNextOptions | null, ExternalWork<A, I>[]> } : {});

/** A reactive value produced outside the database. ctx.get(value, args) reads its current state. */
export interface External<A, I, R, Pool extends boolean = false> extends Derived<A, ExternalState<R> | null> {
  readonly component: Component;
  readonly results: Collection<{ key: string; value: R }>;
  /** The work a worker should do for args, or null when the stored result is current. */
  pending(ctx: Context, args: A): ExternalWork<A, I> | null;
  /** Store a result only if key still names the current input. Racing workers keep the first result. */
  publish(ctx: MutationContext, work: { readonly args: A; readonly key: string; readonly value: R }): { accepted: boolean };
  /** Pending work across the tracked collection, oldest first; optionally one hash shard of it. */
  next(ctx: Context, options?: ExternalNextOptions): ExternalWork<A, I>[];
  http<const Prefix extends string>(prefix: Prefix, options?: { readonly access?: Access }): ExternalHttp<Prefix, A, I, R, Pool>;
}

function shardOf(key: string, count: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193) >>> 0;
  return hash % count;
}

/**
 * Keep a result current for each input, computed by external workers.
 * input() derives everything that affects the result; returning null means no work.
 * With each, writes to that collection's rows mark their keys for worker pools.
 */
export function external<A extends Json, I extends Json = Json, R extends Json = Json>(name: string, options: {
  readonly input: (ctx: Context, args: A) => I | null;
  readonly result?: SchemaLike<R>;
  readonly each: Collection<any, A, any>;
}): External<A, I, R, true>;
export function external<A = string, I extends Json = Json, R extends Json = Json>(name: string, options: {
  readonly input: (ctx: Context, args: A) => I | null;
  readonly result?: SchemaLike<R>;
}): External<A, I, R, false>;
export function external<A, I extends Json, R extends Json>(name: string, options: {
  readonly input: (ctx: Context, args: A) => I | null;
  readonly result?: SchemaLike<R>;
  readonly each?: Collection<any, any, any>;
}): External<A, I, R, boolean> {
  requireName(name, "External value name");
  const settings = plainObject(options, "External options", ["input", "result", "each"]);
  if (typeof settings.input !== "function") throw new TypeError("An external value requires an input function");
  const describe = settings.input as (ctx: Context, args: A) => I | null;
  const resultSchema = settings.result === undefined ? null : adopt(settings.result as SchemaLike<R>);
  const each = settings.each as Collection<any, A & Json, any> | undefined;
  const results = collection<{ key: string; value: R }>(`${name}.results`);
  const stale = collection<{ args: Json; since: number }>(`${name}.stale`).index("since", ["since"]);
  const rowKey = (args: A) => canonicalJson(args as Json);
  const desired = derive(`${name}.input`, (ctx, args: A) => {
    const input = describe(ctx, args);
    return input === null ? null : { key: canonicalJson([args as Json, input]), input };
  });
  const state = (ctx: Context, args: A): ExternalState<R> | null => {
    const wanted = ctx.get(desired, args);
    if (!wanted) return null;
    const stored = ctx.get(results, rowKey(args));
    return stored?.key === wanted.key ? { status: "ready", value: stored.value } : { status: "pending" };
  };
  function pending(ctx: Context, args: A): ExternalWork<A, I> | null {
    const wanted = ctx.get(desired, args);
    if (!wanted || ctx.get(results, rowKey(args))?.key === wanted.key) return null;
    return { args, key: wanted.key, input: wanted.input };
  }
  function publish(ctx: MutationContext, work: { readonly args: A; readonly key: string; readonly value: R }) {
    const { args, key, value } = plainObject(work, "External result", ["args", "key", "value"]) as { args: A; key: string; value: R };
    if (resultSchema) {
      try { resultSchema.parse(value); }
      catch (error) {
        if (error instanceof ValidationError) fail("INVALID_ARGUMENT", `value ${error.message}`, { path: [...error.path] });
        throw error;
      }
    } else canonicalJson(value);
    const wanted = ctx.get(desired, args);
    if (!wanted || wanted.key !== key) return { accepted: false };
    if (ctx.get(results, rowKey(args))?.key !== key) ctx.set(results, rowKey(args), { key, value });
    if (each) ctx.delete(stale, rowKey(args));
    return { accepted: true };
  }
  function next(ctx: Context, nextOptions: ExternalNextOptions = {}): ExternalWork<A, I>[] {
    if (!each) throw new TypeError(`External value ${name} does not track a collection`);
    const choice = plainObject(nextOptions, "Next options", ["limit", "shard"]);
    const limit = choice.limit ?? 16;
    if (!Number.isSafeInteger(limit) || (limit as number) < 1) fail("INVALID_ARGUMENT", "limit must be a positive safe integer");
    const shard = choice.shard as readonly [number, number] | undefined;
    if (shard !== undefined && (!Array.isArray(shard) || shard.length !== 2 || !Number.isSafeInteger(shard[1]) || shard[1] < 1 ||
        !Number.isSafeInteger(shard[0]) || shard[0] < 0 || shard[0] >= shard[1])) fail("INVALID_ARGUMENT", "shard must be [index, count] with index < count");
    const work: ExternalWork<A, I>[] = [];
    let after: string | undefined;
    do {
      const page = ctx.range(stale.by("since").range({ limit: 64, ...(after === undefined ? {} : { after }) }));
      for (const row of page.rows) {
        if (shard && shardOf(row.key, shard[1]) !== shard[0]) continue;
        const found = pending(ctx, row.value.args as A);
        if (found) work.push(found);
        if (work.length === limit) return work;
      }
      after = page.cursor ?? undefined;
    } while (after !== undefined);
    return work;
  }
  const value = derive(name, state);
  const tracking = each ? [trigger(`external:${name}`, each, (ctx, change) => {
    const args = change.key as A;
    const key = rowKey(args);
    if (!ctx.get(desired, args) && ctx.get(results, key) !== null) ctx.delete(results, key);
    if (pending(ctx, args)) {
      if (ctx.get(stale, key) === null) ctx.set(stale, key, { args: args as Json, since: ctx.now() });
    } else if (ctx.get(stale, key) !== null) ctx.delete(stale, key);
  })] : [];
  const parts = component({ collections: [results, ...(each ? [stale] : [])], definitions: [desired, value], triggers: tracking });
  const generated = new Map<string, { access: Access | undefined; methods: Record<string, QueryMethod<any, any> | MutationMethod<any, any>> }>();
  return Object.freeze({
    ...value,
    component: parts,
    results,
    pending,
    publish,
    next,
    http(prefix: string, httpOptions: { readonly access?: Access } = {}) {
      requireName(prefix, "HTTP prefix");
      const { access } = plainObject(httpOptions, "External HTTP options", ["access"]) as { access?: Access };
      const cached = generated.get(prefix);
      if (cached) {
        if (cached.access !== access) throw new TypeError(`External methods for ${JSON.stringify(prefix)} were already generated differently`);
        return cached.methods;
      }
      const spec = <S>(args: SchemaLike<S>) => ({ args, ...(access === undefined ? {} : { access }) });
      const methods: Record<string, QueryMethod<any, any> | MutationMethod<any, any>> = {
        [`${prefix}.pending`]: query(`${prefix}.pending`, access === undefined ? {} : { access }, (ctx, args: A) => pending(ctx, args)),
        [`${prefix}.publish`]: mutation(`${prefix}.publish`, spec(v.object({ args: v.json(), key: v.string(), value: v.json() })),
          (ctx, work) => publish(ctx, work as { args: A; key: string; value: R })),
        ...(each ? { [`${prefix}.next`]: query(`${prefix}.next`,
          spec(v.nullable(v.object({ limit: v.optional(v.int({ min: 1, max: 1024 })), shard: v.optional(v.tuple([v.int({ min: 0 }), v.int({ min: 1 })])) }))),
          (ctx, args) => next(ctx, args ?? {})) } : {}),
      };
      generated.set(prefix, { access, methods: Object.freeze(methods) });
      return methods;
    },
  }) as unknown as External<A, I, R, boolean>;
}
