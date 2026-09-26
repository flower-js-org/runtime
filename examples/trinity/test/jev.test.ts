import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewRequest } from "../app/model.ts";
import { reviewCalls } from "../workers/jev.ts";

const signal = new AbortController().signal;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const answer = (scores: Record<string, number>, model = "jev-2026-09-20") =>
  json({ answers: Object.fromEntries(Object.entries(scores).map(([key, noul]) => [key, { type: "noul", noul }])), model, usage: { input_tokens: 900, output_tokens: 4 } });

function fakeJev(reply: (state: Record<string, any>, attempt: number) => Response | Error) {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, any> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    requests.push({ url: String(url), headers: new Headers(init!.headers), body });
    const replied = reply(body.state, requests.filter((each) => each.body.state.call.id === body.state.call.id).length);
    if (replied instanceof Error) throw replied;
    return replied;
  }) as typeof fetch;
  return { requests, fetchImpl };
}

const request: ReviewRequest = {
  calls: [
    { id: "c1", name: "bash", description: "Run a bash command.", input: { command: "npm test" }, prompt: "Run: npm test", runsOn: "computer", server: null },
    { id: "c2", name: "mcp__linear__delete_issue", description: "Delete an issue.", input: { id: "ENG-1" }, prompt: "linear: delete_issue", runsOn: "service", server: "linear" },
  ],
  computer: "docker",
  surface: "slack",
  events: [
    { session: "s", seq: 3, at: 1, body: { type: "user", message: "m1", text: "Run the tests", attachments: [], author: "alice" } },
    { session: "s", seq: 5, at: 2, body: {
      type: "assistant", model: "claude-opus-5", stopReason: "tool_use", usage: null, costNanos: 0, interrupted: false,
      blocks: [{ type: "text", text: "Running them." }, { type: "tool_call", id: "c1", name: "bash", input: { command: "npm test" } }, { type: "tool_call", id: "c2", name: "mcp__linear__delete_issue", input: { id: "ENG-1" } }],
    } },
  ],
  omitted: 0,
};

test("Jev reviews each call in the conversation that led to it, and approves only confident answers", async () => {
  const jev = fakeJev((state) => state.call.id === "c1" ? answer({ requested: 0.97, safe: 0.9512 }) : answer({ requested: 0.4, safe: 0.03 }));
  const outcome = await reviewCalls(request, { apiKey: "ts_key", fetch: jev.fetchImpl }, signal);
  assert.deepEqual(outcome.verdicts, {
    c1: { approved: true, reviewer: "jev-2026-09-20", scores: { requested: 0.97, safe: 0.951 }, note: null },
    c2: { approved: false, reviewer: "jev-2026-09-20", scores: { requested: 0.4, safe: 0.03 }, note: null },
  });

  const [first] = jev.requests.filter((each) => each.body.state.call.id === "c1");
  assert.equal(first!.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(first!.headers.get("authorization"), "Bearer ts_key");
  assert.equal(first!.body.model, "jev-latest");
  assert.deepEqual(Object.keys(first!.body.questions), ["requested", "safe"]);
  assert.equal(first!.body.questions.safe.type, "noul");
  assert.deepEqual(first!.body.state, {
    call: { id: "c1", tool: "bash", description: "Run a bash command.", input: { command: "npm test" }, summary: "Run: npm test", runs: "in a disposable sandbox container" },
    conversation: [
      { role: "user", author: "alice", text: "Run the tests", attachments: [] },
      { role: "agent", text: "Running them.", calls: [{ id: "c1", tool: "bash", input: { command: "npm test" } }, { id: "c2", tool: "mcp__linear__delete_issue", input: { id: "ENG-1" } }] },
    ],
    omittedEvents: 0,
    surface: "slack",
  });
  const second = jev.requests.find((each) => each.body.state.call.id === "c2")!;
  assert.equal(second.body.state.call.runs, "on the linear MCP server, a service outside the agent");
});

test("without a key, or when Jev fails, calls are left to the user; overloads are retried", async () => {
  const one = { ...request, calls: [request.calls[0]!] };
  assert.deepEqual((await reviewCalls(one, undefined, signal)).verdicts.c1, { approved: false, reviewer: null, scores: {}, note: "No reviewer is configured." });

  const refused = fakeJev(() => json({ error: { message: "invalid key" } }, 401));
  assert.equal((await reviewCalls(one, { apiKey: "bad", fetch: refused.fetchImpl }, signal)).verdicts.c1!.note, "Jev responded 401: invalid key");
  assert.equal(refused.requests.length, 1, "a refusal is not retried");

  const overloaded = fakeJev((_, attempt) => attempt === 1 ? json({ error: { message: "overloaded" } }, 529) : answer({ requested: 0.99, safe: 0.99 }));
  assert.equal((await reviewCalls(one, { apiKey: "k", fetch: overloaded.fetchImpl }, signal)).verdicts.c1!.approved, true);
  assert.equal(overloaded.requests.length, 2);

  const garbled = fakeJev(() => answer({ requested: 0.99 }));
  const verdict = (await reviewCalls(one, { apiKey: "k", fetch: garbled.fetchImpl }, signal)).verdicts.c1!;
  assert.deepEqual([verdict.approved, verdict.note], [false, "Jev did not answer safe"]);
});
