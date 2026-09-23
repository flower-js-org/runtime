import { FlowerClient, FlowerError } from "@flower-js/sdk";
import { randomUUID, webcrypto } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

type Pending = { key: string; input: { recipe: "sha256-v1"; text: string } };

// One process watches one document. Several processes may safely watch the same ID.
export async function runWorker(client: FlowerClient, id: string, signal: AbortSignal) {
  const requestSignal = () => AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const transient = (error: unknown) => !(error instanceof FlowerError) ||
    [408, 425, 429].includes(error.status) || error.status >= 500;
  const pause = (attempt: number) => sleep(
    Math.min(30_000, 250 * 2 ** Math.min(attempt, 7)) * (0.5 + Math.random() / 2),
    undefined, { signal },
  );
  async function retry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try { return await operation(); }
      catch (error) {
        if (signal.aborted || !transient(error)) throw error;
        console.warn("Retrying request:", error);
        await pause(attempt);
      }
    }
  }

  async function waitForPending(): Promise<Pending> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        // Bounded connection lifetime repairs silent transport stalls, too.
        const connection = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
        for await (const { value } of client.watch<string, Pending | null>("worker.pending", id, { signal: connection })) {
          attempt = 0;
          if (value) return value; // Returning closes the watch before work begins.
        }
      } catch (error) {
        if (signal.aborted) throw error;
        if (!transient(error) && !(error instanceof FlowerError && error.code === "WATCH_SCOPE_CHANGED")) throw error;
        console.warn("Reconnecting watch:", error);
      }
      await pause(attempt); // EOF also reconnects, always with a fresh snapshot.
    }
  }

  let failures = 0;
  try {
    while (!signal.aborted) {
      const job = await waitForPending();
      if (job.input.recipe !== "sha256-v1") throw new Error("Unsupported worker recipe");
      let result: string;
      try {
        const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(job.input.text));
        result = Buffer.from(digest).toString("hex");
        failures = 0;
      } catch (error) {
        console.warn("Retrying computation:", error);
        await pause(failures++);
        continue; // Re-arm: unchanged input retries without needing a new event.
      }

      // Keep this exact body AND ID until the response is definitive.
      // An HTTP timeout does not imply rollback; newer input does not cancel intent.
      const body = { id, key: job.key, result }, requestId = randomUUID();
      const receipt = await retry(() => client.mutate<typeof body, { accepted: boolean }>(
        "worker.publish", body, { requestId, signal: requestSignal() },
      ));
      console.log(id, receipt.value.accepted ? "published" : "superseded");
      // Always re-arm a NEW watch after settling. Its initial snapshot repairs
      // coalesced A → B → A changes; stale computation is rejected by publish.
    }
  } catch (error) { if (!signal.aborted) throw error; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const shutdown = new AbortController();
  process.once("SIGINT", () => shutdown.abort());
  process.once("SIGTERM", () => shutdown.abort());
  const client = new FlowerClient(process.env.FLOWER_URL ?? "http://127.0.0.1:7101");
  try { await runWorker(client, process.argv[2] ?? "doc-1", shutdown.signal); }
  catch (error) { console.error(error); process.exitCode = 1; }
}

// Retry intent lives in memory in this demo. After a crash, a new snapshot
// safely recomputes this repeatable digest; there are no external side effects.
