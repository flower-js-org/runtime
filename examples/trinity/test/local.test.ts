import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execute } from "../workers/local.ts";

async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "trinity-")));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.txt"), "one\ntwo\nthree\nfour");
  return root;
}

const signal = new AbortController().signal;

test("reads, lists and writes stay inside the workspace", async () => {
  const root = await workspace();
  assert.deepEqual(await execute(root, { name: "list_files", input: {} }, signal), { content: "src/", isError: false });
  assert.deepEqual(await execute(root, { name: "read_file", input: { path: "src/a.txt", offset: 2, limit: 2 } }, signal), { content: "two\nthree", isError: false });
  assert.equal((await execute(root, { name: "write_file", input: { path: "new/b.txt", content: "hi" } }, signal)).isError, false);
  assert.equal(await readFile(join(root, "new", "b.txt"), "utf8"), "hi");
  const outside = await execute(root, { name: "read_file", input: { path: "../etc/passwd" } }, signal);
  assert.deepEqual(outside, { content: "../etc/passwd is outside the workspace", isError: true });
});

test("symlinks cannot lead outside the workspace", async () => {
  const root = await workspace();
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "trinity-outside-")));
  await symlink(elsewhere, join(root, "link"));
  const result = await execute(root, { name: "write_file", input: { path: "link/escape.txt", content: "x" } }, signal);
  assert.deepEqual(result, { content: "link/escape.txt is outside the workspace", isError: true });
});

test("bash reports exit codes, output and timeouts", async () => {
  const root = await workspace();
  assert.deepEqual(await execute(root, { name: "bash", input: { command: "head -n 1 src/a.txt; exit 3" } }, signal),
    { content: "exit 3\none", isError: true });
  assert.deepEqual(await execute(root, { name: "bash", input: { command: "echo err >&2" } }, signal), { content: "exit 0\nerr", isError: false });
  assert.deepEqual(await execute(root, { name: "bash", input: { command: "sleep 5", timeoutMs: 1_000 } }, signal),
    { content: "timed out after 1000 ms", isError: true });
});

test("an aborted command rejects so the worker never reports it", async () => {
  const root = await workspace();
  const stop = new AbortController();
  const running = execute(root, { name: "bash", input: { command: "sleep 5" } }, stop.signal);
  setTimeout(() => stop.abort(new Error("lease lost")), 100);
  await assert.rejects(running);
});
