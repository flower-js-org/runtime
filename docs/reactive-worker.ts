import { canonicalJson, collection, define, derive, mutation, query } from "@flower-js/sdk";

const documents = collection<{ text: string }>("documents");
const results = collection<{ key: string; result: string }>("results");

function documentId(id: string): string {
  if (typeof id !== "string" || !id || id.length > 256) {
    throw new Error("Document id must contain 1–256 characters.");
  }
  return id;
}

const desired = derive("desired", (ctx, id: string) => {
  const document = ctx.get(documents, id);
  if (!document) return null;
  const input = { recipe: "sha256-v1" as const, text: document.text };
  return { key: canonicalJson([id, input]), input };
});

// Every reader, including other derives, uses this freshness check.
const currentResult = derive("currentResult", (ctx, id: string) => {
  const work = ctx.get(desired, id);
  const stored = ctx.get(results, id);
  return work && stored?.key === work.key ? stored.result : null;
});

export const pending = query("worker.pending", (ctx, id: string) => {
  documentId(id);
  const work = ctx.get(desired, id);
  return ctx.get(currentResult, id) === null ? work : null;
});

export const publish = mutation("worker.publish", (ctx, output: { id: string; key: string; result: string }) => {
  if (!output) throw new Error("An output is required.");
  documentId(output.id);
  if (typeof output.key !== "string" || typeof output.result !== "string" ||
      !/^[0-9a-f]{64}$/.test(output.result)) {
    throw new Error("An output needs a key and a lowercase SHA-256 digest.");
  }
  const work = ctx.get(desired, output.id);
  if (!work || work.key !== output.key) return { accepted: false };
  // The guard and write commit together. Repeated work keeps the first result.
  if (ctx.get(results, output.id)?.key !== output.key) {
    ctx.set(results, output.id, { key: output.key, result: output.result });
  }
  return { accepted: true };
});

export const put = mutation("document.put", (ctx, input: { id: string; text: string }) => {
  if (!input) throw new Error("A document is required.");
  documentId(input.id);
  if (typeof input.text !== "string" || input.text.length > 100_000) {
    throw new Error("Document text must be a string of at most 100,000 characters.");
  }
  ctx.set(documents, input.id, { text: input.text });
  return null;
});

export const remove = mutation("document.delete", (ctx, id: string) => {
  documentId(id);
  ctx.delete(documents, id);
  ctx.delete(results, id);
  return null;
});

export const get = query("document.get", (ctx, id: string) => {
  const document = ctx.get(documents, documentId(id));
  return document ? { text: document.text, result: ctx.get(currentResult, id) } : null;
});

export default define({
  collections: [documents, results],
  definitions: [desired, currentResult],
  http: { "document.put": put, "document.delete": remove, "document.get": get,
    "worker.pending": pending, "worker.publish": publish },
});
