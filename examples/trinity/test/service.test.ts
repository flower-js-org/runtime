import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalJson } from "@flower-js/sdk";
import { checksum, type Event } from "../app/model.ts";
import { FileBlobStore } from "../workers/blobs.ts";
import { INLINE_OUTPUT, offload, readOutput } from "../workers/outputs.ts";
import { readSegment, writeSegment } from "../workers/segments.ts";
import { runServiceTool } from "../workers/service.ts";

const store = async () => new FileBlobStore(await mkdtemp(join(tmpdir(), "trinity-service-")));
const signal = new AbortController().signal;

test("long outputs are stored whole and readable in parts", async () => {
  const blobs = await store();
  const long = "x".repeat(INLINE_OUTPUT) + "TAIL";
  const shown = await offload({ content: long, isError: false }, blobs);
  assert.ok(shown.blob);
  assert.ok(shown.content.length < long.length);
  assert.match(shown.content, /read any part with read_output/);
  assert.ok(shown.content.endsWith("TAIL"));
  assert.deepEqual(await offload({ content: "short", isError: true }, blobs), { content: "short", isError: true });
  const part = await runServiceTool({ session: "s", call: "c", name: "read_output", input: { key: shown.blob, offset: INLINE_OUTPUT, limit: 10 }, background: false, mcp: null }, { secrets: () => undefined, blobs }, signal);
  assert.deepEqual(part, { content: "TAIL", isError: false });
  assert.equal((await readOutput(blobs, `sha256/${"f".repeat(64)}`)).isError, true);
});

test("segments round-trip and carry the checksum the database verifies", async () => {
  const blobs = await store();
  const events: Event[] = [
    { session: "s", seq: 1, at: 1, body: { type: "status", status: "working" } },
    { session: "s", seq: 2, at: 2, body: { type: "user", message: "m", text: "hi", attachments: [], author: "alice" } },
  ];
  const written = await writeSegment(blobs, events);
  assert.deepEqual({ count: written.count, checksum: written.checksum }, { count: 2, checksum: checksum(canonicalJson(events)) });
  assert.deepEqual(await readSegment(blobs, written.key), events);
});

test("service jobs for unknown tools and MCP failures become error results", async () => {
  const unknown = await runServiceTool({ session: "s", call: "c", name: "teleport", input: {}, background: false, mcp: null }, { secrets: () => undefined }, signal);
  assert.equal(unknown.isError, true);
  const unreachable = await runServiceTool({
    session: "s", call: "c", name: "mcp__x__y", input: {}, background: false,
    mcp: { server: "x", tool: "y", url: "http://127.0.0.1:9/mcp", headers: {} },
  }, { secrets: () => undefined }, signal);
  assert.equal(unreachable.isError, true);
  assert.match(unreachable.content, /^The x MCP server failed/);
});
