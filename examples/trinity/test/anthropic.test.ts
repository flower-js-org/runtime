import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import type { Attachment, Body, Event } from "../app/model.ts";
import { classify, modelOptions, normalize, render } from "../workers/anthropic.ts";

const log = (...bodies: Body[]): Event[] => bodies.map((body, index) => ({ session: "s", seq: index + 1, at: 0, body }));
const user = (text: string, attachments: Attachment[] = []): Body => ({ type: "user", message: text, text, attachments, author: null });
const assistant = (blocks: Extract<Body, { type: "assistant" }>["blocks"], interrupted = false): Body =>
  ({ type: "assistant", blocks, model: "m", stopReason: null, usage: null, costNanos: 0, interrupted });
const result = (call: string, content: string, isError = false): Body => ({ type: "tool_result", call, content, isError, blob: null });

test("results follow their calls' order in one user message, before what the user said meanwhile", () => {
  const messages = render(log(
    user("go"),
    assistant([{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_call", id: "a", name: "read_file", input: { path: "x" } }, { type: "tool_call", id: "b", name: "bash", input: { command: "ls" } }]),
    result("b", "", true),
    result("a", "X"),
    user("also check y"),
  ));
  assert.deepEqual(messages, [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant", content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "tool_use", id: "a", name: "read_file", input: { path: "x" } },
        { type: "tool_use", id: "b", name: "bash", input: { command: "ls" } },
      ],
    },
    {
      role: "user", content: [
        { type: "tool_result", tool_use_id: "a", content: "X" },
        { type: "tool_result", tool_use_id: "b", content: "(no output)", is_error: true },
        { type: "text", text: "also check y" },
      ],
    },
  ]);
});

test("an interrupted response is kept and the interruption is said to the model", () => {
  const messages = render(log(user("poem"), assistant([{ type: "text", text: "Roses" }], true), { type: "interrupted" }, user("shorter")));
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user"]);
  assert.deepEqual(messages[2]!.content, [
    { type: "text", text: "The user interrupted your previous turn." },
    { type: "text", text: "shorter" },
  ]);
});

test("empty assistant messages, such as refusals, are left out", () => {
  const messages = render(log(user("x"), assistant([]), user("y")));
  assert.deepEqual(messages, [{ role: "user", content: [{ type: "text", text: "x" }, { type: "text", text: "y" }] }]);
});

function message(content: unknown[], stop_reason: Anthropic.Beta.BetaStopReason = "end_turn"): Anthropic.Beta.BetaMessage {
  return {
    id: "msg", type: "message", role: "assistant", model: "claude-opus-4-8", stop_reason, stop_sequence: null, content,
    usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: null },
  } as unknown as Anthropic.Beta.BetaMessage;
}

test("normalize keeps replayable blocks and reports the served model and usage", () => {
  assert.deepEqual(normalize(message([
    { type: "thinking", thinking: "", signature: "s" },
    { type: "text", text: "" },
    { type: "text", text: "Reading" },
    { type: "tool_use", id: "t", name: "read_file", input: { path: "a" } },
  ], "tool_use")), {
    blocks: [
      { type: "thinking", thinking: "", signature: "s" },
      { type: "text", text: "Reading" },
      { type: "tool_call", id: "t", name: "read_file", input: { path: "a" } },
    ],
    model: "claude-opus-4-8",
    stopReason: "tool_use",
    usage: { input: 7, output: 3, cacheRead: 100, cacheWrite: 0 },
  });
});

test("after a fallback, only the declined partial's text survives", () => {
  const { blocks } = normalize(message([
    { type: "thinking", thinking: "", signature: "declined" },
    { type: "text", text: "Let me" },
    { type: "tool_use", id: "early", name: "bash", input: { command: "x" } },
    { type: "fallback", from: { model: "claude-opus-5" }, to: { model: "claude-opus-4-8" } },
    { type: "thinking", thinking: "", signature: "kept" },
    { type: "tool_use", id: "late", name: "read_file", input: { path: "a" } },
  ], "tool_use"));
  assert.deepEqual(blocks.map((block) => block.type === "thinking" ? block.signature : block.type === "tool_call" ? block.id : block.type), ["text", "kept", "late"]);
});

test("classify separates retryable failures and honours retry-after", () => {
  const limited = classify(new Anthropic.RateLimitError(429, undefined, "slow down", new Headers({ "retry-after": "3" })));
  assert.deepEqual(limited, { code: "RATE_LIMITED", message: limited.message, retryable: true, retryAfterMs: 3_000 });
  const overloaded = classify(Anthropic.APIError.generate(529, undefined, "overloaded", new Headers()));
  assert.equal(overloaded.code, "OVERLOADED");
  assert.equal(overloaded.retryable, true);
  const bad = classify(new Anthropic.BadRequestError(400, undefined, "bad", new Headers()));
  assert.equal(bad.code, "INVALID_REQUEST");
  assert.equal(bad.retryable, false);
  assert.equal(classify(new Anthropic.APIConnectionError({ message: "reset" })).retryable, true);
  assert.deepEqual(classify(new SyntaxError("Unexpected end of JSON input")), { code: "STREAM_ERROR", message: "Unexpected end of JSON input", retryable: true });
});

test("attachments render as images, documents or text; missing ones say so", () => {
  const png = { blob: "sha256/aa", name: "shot.png", mediaType: "image/png", size: 3 };
  const pdf = { blob: "sha256/bb", name: "spec.pdf", mediaType: "application/pdf", size: 3 };
  const notes = { blob: "sha256/cc", name: "notes.txt", mediaType: "text/plain", size: 2 };
  const gone = { blob: "sha256/dd", name: "gone.zip", mediaType: "application/zip", size: 9 };
  const bodies = new Map([["sha256/aa", new Uint8Array([1, 2, 3])], ["sha256/bb", new Uint8Array([4, 5, 6])], ["sha256/cc", new TextEncoder().encode("hi")]]);
  const [message] = render(log(user("look", [png, pdf, notes, gone])), bodies);
  assert.deepEqual(message!.content, [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    { type: "document", title: "spec.pdf", source: { type: "base64", media_type: "application/pdf", data: "BAUG" } },
    { type: "text", text: '<attachment name="notes.txt">\nhi\n</attachment>' },
    { type: "text", text: "[Attachment gone.zip is no longer available.]" },
    { type: "text", text: "look" },
  ]);
});

test("summaries, background results and provider blocks render for the model", () => {
  const search = { type: "server_tool_use", id: "srv", name: "web_search", input: { query: "x" } };
  const messages = render(log(
    { type: "compact", summary: "Earlier we did X." },
    assistant([{ type: "provider", provider: "anthropic", block: search }, { type: "text", text: "Found it." }]),
    { type: "background_result", call: "b1", content: "exit 0", isError: false, blob: null },
  ));
  assert.match((messages[0]!.content as Array<{ text: string }>)[0]!.text, /summarized[\s\S]*Earlier we did X\./);
  assert.deepEqual((messages[1]!.content as unknown[])[0], search);
  assert.deepEqual(messages[2]!.content, [{ type: "text", text: '<background-result call="b1">\nexit 0\n</background-result>' }]);
});

test("server tool traffic is kept as provider blocks; unanswered calls before a fallback are dropped", () => {
  const { blocks } = normalize(message([
    { type: "server_tool_use", id: "lost", name: "web_search", input: {} },
    { type: "server_tool_use", id: "kept", name: "web_search", input: {} },
    { type: "web_search_tool_result", tool_use_id: "kept", content: [] },
    { type: "fallback", from: { model: "claude-opus-5" }, to: { model: "claude-opus-4-8" } },
    { type: "text", text: "Done" },
  ]));
  assert.deepEqual(blocks.map((block) => block.type === "provider" ? (block.block as { id?: string; tool_use_id?: string }).id ?? `result:${(block.block as { tool_use_id: string }).tool_use_id}` : block.type), ["kept", "result:kept", "text"]);
});

test("thinking and fallbacks are requested only from models that accept them", () => {
  assert.deepEqual(modelOptions("claude-opus-5"), { thinking: true, fallbacks: true });
  assert.deepEqual(modelOptions("claude-opus-5-5"), { thinking: true, fallbacks: true });
  assert.deepEqual(modelOptions("claude-fable-5-1"), { thinking: true, fallbacks: true });
  assert.deepEqual(modelOptions("claude-sonnet-5"), { thinking: true, fallbacks: false });
  assert.deepEqual(modelOptions("claude-opus-4-8"), { thinking: true, fallbacks: false });
  assert.deepEqual(modelOptions("claude-haiku-4-5"), { thinking: false, fallbacks: false });
});
