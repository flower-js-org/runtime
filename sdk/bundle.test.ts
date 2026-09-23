import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle, loadBundle, writeBundle } from "./bundle.ts";

const entry = new URL("../examples/orders.ts", import.meta.url).pathname;

test("static initialization opt-in is hashed and preserved by bundle files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flower-bundle-"));
  try {
    const normal = await buildBundle(entry);
    const staticBundle = await writeBundle(entry, join(directory, "app.json"), { initialization: "static" });
    assert.equal(staticBundle.javascript, "/* flower:static-init */\n" + normal.javascript);
    assert.equal(staticBundle.hash, createHash("sha256").update(staticBundle.javascript).digest("hex"));
    assert.notEqual(staticBundle.hash, normal.hash);
    assert.deepEqual(await loadBundle(join(directory, "app.json")), staticBundle);
    await assert.rejects(loadBundle(join(directory, "app.json"), { initialization: "static" }), /already specifies/);
    await assert.rejects(buildBundle(entry, { initialization: "invalid" as any }), /initialization must/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
