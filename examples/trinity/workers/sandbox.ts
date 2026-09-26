import type { FlowerClient, Json } from "@flower-js/sdk";
import { runQueueWorker, type QueueWorkerEvent } from "@flower-js/sdk/worker";
import type app from "../app/index.ts";
import type { ToolJob, ToolOutcome } from "../app/model.ts";
import type { ProvisionJob } from "../app/store.ts";
import type { BlobStore } from "./blobs.ts";
import { DockerProvider, executeInContainer } from "./docker.ts";
import { offload } from "./outputs.ts";

export interface SandboxOptions {
  readonly signal: AbortSignal;
  readonly provider?: DockerProvider;
  readonly blobs?: BlobStore;
  /** Tool jobs each running sandbox serves at once. Default 4. */
  readonly lanes?: number;
  readonly onEvent?: (event: QueueWorkerEvent & { computer?: string }) => void;
}

/**
 * Start and stop sandboxes on request, and run tool jobs inside each running one.
 * Executors follow the database's list of running sandboxes rather than local state,
 * so any number of these processes can share the work.
 */
export async function runSandboxes(client: FlowerClient<typeof app>, options: SandboxOptions): Promise<void> {
  const provider = options.provider ?? new DockerProvider();
  const onEvent = options.onEvent ?? (() => {});
  const provisioner = runQueueWorker<ProvisionJob, Json>(client, {
    queue: "provision",
    signal: options.signal,
    lanes: 2,
    leaseMs: 120_000,
    onEvent,
    async work(job, signal) {
      if (job.payload.action === "stop") {
        await provider.stop(job.payload.computer, signal);
        return null;
      }
      if (job.payload.image === null) throw new Error(`Sandbox ${job.payload.computer} has no image`);
      return provider.start({ id: job.payload.computer, image: job.payload.image }, signal);
    },
  });

  const executors = new Map<string, { stop: AbortController; done: Promise<void> }>();
  const serve = (computer: string, scope: string) => {
    const stop = new AbortController();
    const done = runQueueWorker<ToolJob, ToolOutcome>(client, {
      queue: "tools",
      scope,
      signal: AbortSignal.any([options.signal, stop.signal]),
      lanes: options.lanes ?? 4,
      leaseMs: 30_000,
      onEvent: (event) => onEvent({ ...event, computer }),
      work: async (job, signal) => offload(await executeInContainer(`trinity-${computer}`, job.payload, signal), options.blobs),
    }).catch((error) => onEvent({ type: "waiting", lane: 0, error: String(error), computer }));
    executors.set(computer, { stop, done });
  };
  try {
    for await (const { value } of client.subscribe("computer.running", null, { signal: options.signal })) {
      const running = new Set(value.map((computer) => computer.id));
      for (const computer of value) if (!executors.has(computer.id)) serve(computer.id, computer.scope);
      for (const [computer, executor] of executors) {
        if (running.has(computer)) continue;
        executor.stop.abort();
        executors.delete(computer);
      }
    }
  } catch (error) {
    if (!options.signal.aborted) throw error;
  } finally {
    for (const executor of executors.values()) executor.stop.abort();
    await Promise.all([provisioner, ...[...executors.values()].map((executor) => executor.done)]);
  }
}
