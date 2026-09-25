import type { ToolOutcome } from "../app/model.ts";
import type { BlobStore } from "./blobs.ts";

// How tool output is shaped for the model, the same on every computer: bounded text, and
// the whole of anything long kept in blob storage for read_output.

export const MAX_OUTPUT = 200_000;
const MAX_ENTRIES = 1_000;

/** Keep the head and tail of text longer than MAX_OUTPUT. */
export function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  const head = text.slice(0, MAX_OUTPUT * 0.75);
  const tail = text.slice(-MAX_OUTPUT * 0.2);
  return `${head}\n[${text.length - head.length - tail.length} characters omitted]\n${tail}`;
}

/** Directory entries, sorted, directories ending with a slash. */
export function directoryListing(names: readonly string[]): ToolOutcome {
  const sorted = [...names].sort();
  const shown = sorted.slice(0, MAX_ENTRIES).join("\n");
  const more = sorted.length > MAX_ENTRIES ? `\n[${sorted.length - MAX_ENTRIES} more entries]` : "";
  return { content: shown + more || "(empty directory)", isError: false };
}

/** Lines `offset` (from 1) onwards, at most `limit` of them. */
export function lineRange(text: string, offset = 1, limit?: number): ToolOutcome {
  const lines = text.split("\n");
  const start = offset - 1;
  return { content: truncate(lines.slice(start, limit === undefined ? undefined : start + limit).join("\n")), isError: false };
}

/** Outputs longer than this are stored whole and shown to the model as head and tail. */
export const INLINE_OUTPUT = 30_000;

export async function offload(outcome: ToolOutcome, blobs: BlobStore | undefined): Promise<ToolOutcome> {
  if (blobs === undefined || outcome.content.length <= INLINE_OUTPUT) return outcome;
  const key = await blobs.put(outcome.content, "text/plain; charset=utf-8");
  const head = outcome.content.slice(0, 20_000);
  const tail = outcome.content.slice(-5_000);
  const omitted = outcome.content.length - head.length - tail.length;
  return {
    content: `${head}\n[${omitted} characters omitted. The full output (${outcome.content.length} characters) is stored as ${key}; read any part with read_output.]\n${tail}`,
    isError: outcome.isError,
    blob: key,
  };
}

export async function readOutput(blobs: BlobStore, key: string, offset = 0, limit = 50_000): Promise<ToolOutcome> {
  const found = await blobs.get(key);
  if (found === null) return { content: `No stored output ${key}.`, isError: true };
  const text = new TextDecoder().decode(found.body);
  const slice = text.slice(offset, offset + limit);
  const end = offset + slice.length;
  return { content: `${slice}${end < text.length ? `\n[characters ${offset}–${end} of ${text.length}]` : ""}`, isError: false };
}
