import { collection, define, mutation, query } from "../sdk/index.ts";
import { scheduler } from "../sdk/scheduler.ts";

interface Document {
  text: string;
  status: "draft" | "published";
  version: number;
  updatedAt: number;
  publishedAt: number | null;
}

export const documents = collection<Document>("scheduledDocuments");

// Ordinary private TypeScript business logic runs later in a Raft transaction.
export const publishDocument = mutation("internal.documents.publish", (ctx, args: { id: string; version: number }) => {
  const document = ctx.get(documents, args.id);
  if (document === null || document.version !== args.version) return null;
  ctx.set(documents, args.id, { ...document, status: "published", publishedAt: ctx.now() });
  return null;
});

export const timers = scheduler("publicationTimers", { publish: publishDocument }, {
  maxAttempts: 3, retryDelayMs: 1_000, maxRetryDelayMs: 10_000,
});

export const updateDocument = mutation("internal.documents.update", (ctx, args: { id: string; text: string; publishAfterMs: number }) => {
  if (!args || typeof args.id !== "string" || !args.id || typeof args.text !== "string") {
    throw new TypeError("Document id and text are required");
  }
  const previous = ctx.get(documents, args.id);
  const version = (previous?.version ?? 0) + 1;
  if (!Number.isSafeInteger(version)) throw new RangeError("Document version is exhausted");
  const document: Document = { text: args.text, status: "draft", version, updatedAt: ctx.now(), publishedAt: null };
  ctx.set(documents, args.id, document);
  // Reusing this ID replaces the previous timer, so each edit restarts the delay.
  const timer = timers.after(ctx, `publish:${args.id}`, args.publishAfterMs, "publish", { id: args.id, version });
  return { document, timer };
});

export const getDocument = query("internal.documents.get", (ctx, id: string) => ctx.get(documents, id));
export const cancelPublication = mutation("internal.documents.cancelPublication", (ctx, id: string) => timers.cancel(ctx, `publish:${id}`));
export const publicationStatus = query("internal.documents.publication", (ctx, id: string) => timers.get(ctx, `publish:${id}`));
export const retryPublication = mutation("internal.documents.retryPublication", (ctx, args: { id: string; delayMs?: number }) =>
  timers.retry(ctx, `publish:${args.id}`, args.delayMs),
);

export default define({
  collections: [timers.records],
  maintenance: timers.maintenance,
  http: {
    "documents.update": updateDocument,
    "documents.get": getDocument,
    "documents.cancelPublication": cancelPublication,
    "documents.publication": publicationStatus,
    "documents.retryPublication": retryPublication,
  },
});
