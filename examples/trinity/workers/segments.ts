import { canonicalJson } from "@flower-js/sdk";
import { checksum, type Event } from "../app/model.ts";
import type { BlobStore } from "./blobs.ts";

/** A sealed log segment is its events as JSON lines, oldest first. */
export async function writeSegment(blobs: BlobStore, events: readonly Event[]): Promise<{ key: string; count: number; checksum: string }> {
  const key = await blobs.put(events.map((event) => JSON.stringify(event)).join("\n"), "application/x-ndjson");
  return { key, count: events.length, checksum: checksum(canonicalJson(events)) };
}

export async function readSegment(blobs: BlobStore, key: string): Promise<Event[]> {
  const found = await blobs.get(key);
  if (found === null) throw new Error(`Log segment ${key} is missing from blob storage`);
  const text = new TextDecoder().decode(found.body);
  return text === "" ? [] : text.split("\n").map((line) => JSON.parse(line) as Event);
}
