import assert from "node:assert/strict";
import { FlowerError, type Json } from "@flower-js/sdk";
import type { Claim } from "@flower-js/sdk/temporal";
import { testDatabase } from "@flower-js/sdk/testing";
import type { Block, Body, CompletionJob, Delta, OrgSettings, ToolJob, Usage } from "../../app/model.ts";
import type app from "./app.ts";

export const alice = { subject: "alice", claims: { role: "user", org: "acme" } };
export const bob = { subject: "bob", claims: { role: "user", org: "acme" } };
export const mallory = { subject: "mallory", claims: { role: "user", org: "evil" } };
export const worker = { subject: "worker-1", claims: { role: "worker" } };
export const gateway = { subject: "gateway", claims: { role: "service" } };
export const laptop = { subject: "laptop", claims: { role: "computer", computer: "laptop", org: "acme" } };

export const usage: Usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 };
export const text = (value: string): Block => ({ type: "text", text: value });
export const call = (id: string, name: string, input: Json): Block => ({ type: "tool_call", id, name, input });
export const lease = (claim: Claim<unknown>) => ({ id: claim.id, owner: claim.owner, token: claim.token });

export function summarize(body: Body): string {
  switch (body.type) {
    case "user": return `user ${body.text}`;
    case "assistant": {
      const parts = body.blocks.map((block) => block.type === "text" ? block.text : block.type === "tool_call" ? `${block.name}#${block.id}` : block.type);
      return `assistant ${parts.join(" ")}${body.interrupted ? " (interrupted)" : ""}`.trimEnd();
    }
    case "tool_result": return `result ${body.call}${body.isError ? " error" : ""}: ${body.content}`;
    case "background_result": return `background ${body.call}${body.isError ? " error" : ""}: ${body.content}`;
    case "tool_awaiting": return `awaiting ${body.call} ${body.kind}`;
    case "tool_resolved": return `resolved ${body.call} ${body.resolution}`;
    case "subagent": return `subagent ${body.call} ${body.session}`;
    case "compact": return `compact ${body.summary}`;
    case "error": return `error ${body.code}${body.retryInMs === null ? "" : ` retry in ${body.retryInMs}`}`;
    case "status": return `status ${body.status}`;
    case "interrupted": return "interrupted";
    case "title": return `title ${body.title}`;
  }
}

export function failure(code: string) {
  return (error: unknown) => error instanceof FlowerError && error.failure?.code === code;
}
export const leaseLost = failure("LEASE_LOST");

export interface SetupOptions {
  settings?: Partial<OrgSettings>;
  /** Extra session.create arguments for session "s". */
  session?: Record<string, Json>;
}

/**
 * An organization "acme" with alice (admin) and bob, alice's computer "laptop", and session "s".
 * The test plays the LLM worker and the computer.
 */
export async function setup(options: SetupOptions = {}) {
  // A module path is bundled and run in its own context, as the server would.
  const db = await testDatabase<typeof app>(new URL("./app.ts", import.meta.url).pathname, { credentials: alice });
  db.mutate("org.create", { id: "acme", name: "Acme" });
  db.mutate("org.setMember", { subject: "bob", role: "member" });
  if (options.settings) db.mutate("org.update", { settings: options.settings });
  db.mutate("computer.register", { id: "laptop", name: "Laptop" });
  db.mutate("session.create", { id: "s", computer: "laptop", ...options.session });
  let messages = 0;
  const seen = new Map<string, number>();
  const asWorker = { credentials: worker };
  const t = {
    db,
    say: (value: string, steer = false, session = "s") => db.mutate("session.send", { session, message: `m${++messages}`, text: value, steer }),
    session: (session = "s") => db.query("session.get", { session })!,
    claim(): Claim<CompletionJob> {
      const claim = db.mutate("completions.claim", { owner: "llm" }, asWorker);
      assert.ok(claim, "a completion should be claimable");
      return claim;
    },
    idle: () => db.mutate("completions.claim", { owner: "llm" }, asWorker) === null,
    reply: (claim: Claim<CompletionJob>, blocks: Block[], stopReason = "end_turn", used: Usage = usage, model = "claude-opus-5") =>
      db.mutate("completions.complete", { ...lease(claim), result: { ok: true, message: { blocks, model, stopReason, usage: used } } }, asWorker),
    fail: (claim: Claim<CompletionJob>, error: { code: string; message: string; retryable: boolean; retryAfterMs?: number }) =>
      db.mutate("completions.complete", { ...lease(claim), result: { ok: false, error } }, asWorker),
    progress: (claim: Claim<CompletionJob>, deltas: Delta[]) => db.mutate("completions.progress", { ...lease(claim), deltas }, asWorker),
    tool(scope = "computer:laptop"): Claim<ToolJob> {
      const claim = db.mutate("tools.claim", { scope, owner: "box" }, asWorker);
      assert.ok(claim, "a tool job should be claimable");
      return claim;
    },
    noTool: (scope = "computer:laptop") => db.mutate("tools.claim", { scope, owner: "box" }, asWorker) === null,
    finishTool: (claim: Claim<ToolJob>, content: string, isError = false, scope = "computer:laptop") =>
      db.mutate("tools.complete", { scope, ...lease(claim), result: { content, isError } }, asWorker),
    prompt: (claim: Claim<CompletionJob>) => db.query("session.prompt", { session: claim.payload.session, step: claim.payload.step }, asWorker),
    promptLog: (claim: Claim<CompletionJob>) => t.prompt(claim)!.events.map((event) => summarize(event.body)),
    /** Events appended to a session since the previous call for it. */
    log(session = "s"): string[] {
      const page = db.query("session.tail", { session, after: seen.get(session) ?? 0, limit: 1_000 })!;
      seen.set(session, page.events.at(-1)?.seq ?? seen.get(session) ?? 0);
      return page.events.map((event) => summarize(event.body));
    },
  };
  return t;
}
