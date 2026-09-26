import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { FlowerClient } from "@flower-js/sdk";
import { runQueueWorker, type QueueWorkerEvent } from "@flower-js/sdk/worker";
import type app from "../app/index.ts";
import type { ToolJob, ToolOutcome } from "../app/model.ts";
import type { BlobStore } from "./blobs.ts";
import { directoryListing, lineRange, offload, truncate } from "./outputs.ts";

export interface LocalWorkerOptions {
  readonly signal: AbortSignal;
  /** Root of every path the tools accept, and the working directory of commands. */
  readonly workspace: string;
  /** The registered computer this process serves; it claims the `computer:<id>` scope. */
  readonly computer: string;
  /** Where long outputs are stored for read_output. */
  readonly blobs?: BlobStore;
  readonly lanes?: number;
  readonly heartbeatMs?: number;
  readonly onEvent?: (event: QueueWorkerEvent) => void;
}

/** Run computer tools on this machine for sessions that use this computer, and report it online meanwhile. */
export async function runLocalWorker(client: FlowerClient<typeof app>, options: LocalWorkerOptions): Promise<void> {
  const root = await realpath(options.workspace);
  const beat = () => client.mutate("computer.heartbeat", { id: options.computer }, { retry: { attempts: 3 } }).catch(() => {});
  await beat();
  const heartbeat = setInterval(beat, options.heartbeatMs ?? 20_000);
  try {
    await runQueueWorker<ToolJob, ToolOutcome>(client, {
      queue: "tools",
      scope: `computer:${options.computer}`,
      signal: options.signal,
      lanes: options.lanes ?? 4,
      leaseMs: 30_000,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      work: async (job, signal) => offload(await execute(root, job.payload, signal), options.blobs),
    });
  } finally {
    clearInterval(heartbeat);
  }
}

/** Tool failures become error results for the model; only an abort propagates. */
export async function execute(root: string, job: Pick<ToolJob, "name" | "input">, signal: AbortSignal): Promise<ToolOutcome> {
  const input = job.input as Record<string, any>;
  try {
    switch (job.name) {
      case "list_files": return await listFiles(root, input.path ?? ".");
      case "read_file": return await readText(root, input.path, input.offset, input.limit);
      case "write_file": {
        const target = await confined(root, input.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, input.content);
        return { content: `Wrote ${input.content.length} characters to ${input.path}.`, isError: false };
      }
      case "bash": return await bash(root, input.command, input.timeoutMs ?? 120_000, signal);
      default: return { content: `This computer cannot run ${job.name}.`, isError: true };
    }
  } catch (error) {
    if (signal.aborted) throw error;
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
}

/** Resolve a workspace path, following symlinks as far as the path exists, and refuse anything outside the root. */
async function confined(root: string, path: string): Promise<string> {
  const target = resolve(root, path);
  let existing = target;
  let rest = "";
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) break;
      rest = relative(parent, target);
      existing = parent;
    }
  }
  const real = resolve(existing, rest);
  const inside = relative(root, real);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`${path} is outside the workspace`);
  return real;
}

async function listFiles(root: string, path: string): Promise<ToolOutcome> {
  const entries = await readdir(await confined(root, path), { withFileTypes: true });
  return directoryListing(entries.map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name));
}

async function readText(root: string, path: string, offset?: number, limit?: number): Promise<ToolOutcome> {
  return lineRange(await readFile(await confined(root, path), "utf8"), offset, limit);
}

function bash(root: string, command: string, timeoutMs: number, signal: AbortSignal): Promise<ToolOutcome> {
  return new Promise((done, reject) => {
    const child = spawn("bash", ["-c", command], { cwd: root, signal, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => { output += chunk.toString("utf8"); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => signal.aborted ? reject(error) : done({ content: error.message, isError: true }));
    child.on("close", (code, killed) => {
      if (signal.aborted) return reject(signal.reason);
      const status = killed === "SIGTERM" && code === null ? `timed out after ${timeoutMs} ms` : killed ? `killed by ${killed}` : `exit ${code}`;
      done({ content: `${status}\n${truncate(output)}`.trimEnd(), isError: code !== 0 });
    });
  });
}
