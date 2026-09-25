import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle, loadBundle, writeBundle } from "./bundle.ts";

const entry = new URL("../examples/orders.ts", import.meta.url).pathname;

test("static initialization is the hashed default, per-invocation opts out, and bundle files preserve the mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flower-bundle-"));
  try {
    const perInvocation = await buildBundle(entry, { initialization: "per-invocation" });
    assert.ok(!perInvocation.javascript.includes("flower:static-init"));
    const staticBundle = await writeBundle(entry, join(directory, "app.json"));
    assert.equal(staticBundle.javascript, "/* flower:static-init */\n" + perInvocation.javascript);
    assert.deepEqual(await buildBundle(entry, { initialization: "static" }), staticBundle);
    assert.equal(staticBundle.hash, createHash("sha256").update(staticBundle.javascript).digest("hex"));
    assert.notEqual(staticBundle.hash, perInvocation.hash);
    assert.deepEqual(await loadBundle(join(directory, "app.json")), staticBundle);
    await writeBundle(entry, join(directory, "fresh.json"), { initialization: "per-invocation" });
    assert.deepEqual(await loadBundle(join(directory, "fresh.json")), perInvocation);
    await assert.rejects(loadBundle(join(directory, "app.json"), { initialization: "static" }), /already specifies/);
    await assert.rejects(buildBundle(entry, { initialization: "invalid" as any }), /initialization must/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
