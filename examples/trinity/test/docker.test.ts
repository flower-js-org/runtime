import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Json } from "@flower-js/sdk";
import { DockerProvider, executeInContainer } from "../workers/docker.ts";

const IMAGE = "debian:bookworm-slim";
const available = spawnSync("docker", ["version"], { stdio: "ignore", timeout: 10_000 }).status === 0;
const skip = available ? false : "Docker is not running";

const provider = new DockerProvider();
const signal = new AbortController().signal;
const ids: string[] = [];

async function computer() {
  const id = `test-${randomUUID().slice(0, 8)}`;
  ids.push(id);
  const { container } = await provider.start({ id, image: IMAGE });
  return container;
}

/** Whether a process in the container has `marker` as one of its arguments. */
async function running(container: string, marker: string) {
  const { content } = await executeInContainer(container, { name: "bash", input: { command: "cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' '\\n'" } }, signal);
  return content.split("\n").includes(marker);
}

after(async () => {
  if (available) await Promise.all(ids.map((id) => provider.stop(id)));
});

test("starting, stopping and status are idempotent", { skip }, async () => {
  const id = `test-${randomUUID().slice(0, 8)}`;
  ids.push(id);
  assert.equal(await provider.status(id), "missing");
  const { container } = await provider.start({ id, image: IMAGE });
  assert.equal(container, `trinity-${id}`);
  assert.equal(await provider.status(id), "running");
  assert.deepEqual(await provider.start({ id, image: IMAGE }), { container });
  await executeInContainer(container, { name: "write_file", input: { path: "kept.txt", content: "kept" } }, signal);
  assert.equal(spawnSync("docker", ["stop", "-t", "0", container]).status, 0);
  assert.equal(await provider.status(id), "stopped");
  await provider.start({ id, image: IMAGE });
  assert.equal(await provider.status(id), "running");
  assert.deepEqual(await executeInContainer(container, { name: "read_file", input: { path: "kept.txt" } }, signal), { content: "kept", isError: false });
  await provider.stop(id);
  assert.equal(await provider.status(id), "missing");
  await provider.stop(id);
});

test("tools list, read, write and run inside the workspace", { skip }, async () => {
  const container = await computer();
  const run = (name: string, input: Json) => executeInContainer(container, { name, input }, signal);
  assert.deepEqual(await run("list_files", {}), { content: "(empty directory)", isError: false });
  assert.deepEqual(await run("write_file", { path: "src/a.txt", content: "one\ntwo\nthree\nfour" }),
    { content: "Wrote 18 characters to src/a.txt.", isError: false });
  assert.deepEqual(await run("write_file", { path: "quoted.txt", content: "$(id) '\"`" }), { content: "Wrote 9 characters to quoted.txt.", isError: false });
  assert.deepEqual(await run("list_files", {}), { content: "quoted.txt\nsrc/", isError: false });
  assert.deepEqual(await run("read_file", { path: "src/a.txt", offset: 2, limit: 2 }), { content: "two\nthree", isError: false });
  assert.deepEqual(await run("read_file", { path: "quoted.txt" }), { content: "$(id) '\"`", isError: false });
  assert.deepEqual(await run("read_file", { path: "missing.txt" }), { content: "missing.txt does not exist", isError: true });
  assert.deepEqual(await run("bash", { command: "head -n 1 src/a.txt; exit 3" }), { content: "exit 3\none", isError: true });
  assert.deepEqual(await run("bash", { command: "echo err >&2; pwd" }), { content: "exit 0\nerr\n/workspace", isError: false });
  assert.deepEqual(await run("screenshot", {}), { content: "This computer cannot run screenshot.", isError: true });
});

test("paths cannot lead outside the workspace", { skip }, async () => {
  const container = await computer();
  const run = (name: string, input: Json) => executeInContainer(container, { name, input }, signal);
  assert.deepEqual(await run("read_file", { path: "../etc/passwd" }), { content: "../etc/passwd is outside the workspace", isError: true });
  assert.deepEqual(await run("list_files", { path: "/etc" }), { content: "/etc is outside the workspace", isError: true });
  await run("bash", { command: "ln -s /etc link" });
  assert.deepEqual(await run("write_file", { path: "link/escape.txt", content: "x" }), { content: "link/escape.txt is outside the workspace", isError: true });
  assert.deepEqual(await run("read_file", { path: "link/passwd" }), { content: "link/passwd is outside the workspace", isError: true });
});

test("timeouts and aborts kill the command inside the container", { skip }, async () => {
  const container = await computer();
  assert.deepEqual(await executeInContainer(container, { name: "bash", input: { command: "echo started; sleep 1234", timeoutMs: 1_000 } }, signal),
    { content: "timed out after 1000 ms\nstarted", isError: true });
  assert.equal(await running(container, "1234"), false);
  const stop = new AbortController();
  const aborted = executeInContainer(container, { name: "bash", input: { command: "sleep 1235" } }, stop.signal);
  setTimeout(() => stop.abort(new Error("lease lost")), 500);
  await assert.rejects(aborted, /lease lost/);
  assert.equal(await running(container, "1235"), false);
});
