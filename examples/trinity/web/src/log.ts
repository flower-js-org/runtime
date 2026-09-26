// A session's log as the client shows it: merging pages, grouping into items and the words on them.
// No DOM here, so Node tests import it.
import type { Json } from "@flower-js/sdk";
import type { Attachment, Body, Call, Delta, Event, Queued, Resolution } from "../../app/model.ts";
import { formatDollars, formatTokens, oneLine, toolSummary } from "./format.ts";

export type EventOf<T extends Body["type"]> = Event & { body: Extract<Body, { type: T }> };
export type ResultBody = Extract<Body, { type: "tool_result" }> & { seq: number };
export type ReviewBody = Extract<Body, { type: "tool_reviewed" }>;
/** What a view needs of a call: from the assistant's tool_call block, or from the live turn. */
export interface CallInfo { id: string; name: string; input: Json }

export type Item =
  | { key: string; kind: "user"; event: EventOf<"user"> }
  | { key: string; kind: "assistant"; event: EventOf<"assistant">; results: Record<string, ResultBody | null>; states: Record<string, Call["state"] | null> }
  | { key: string; kind: "result"; event: EventOf<"tool_result"> }
  | { key: string; kind: "awaiting"; event: EventOf<"tool_awaiting">; awaiting: boolean; resolution: Resolution | null; call: CallInfo | null; review: ReviewBody | null }
  | { key: string; kind: "reviewed"; event: EventOf<"tool_reviewed">; call: CallInfo | null }
  | { key: string; kind: "background"; event: EventOf<"background_result">; call: CallInfo | null }
  | { key: string; kind: "subagent"; event: EventOf<"subagent">; call: CallInfo | null }
  | { key: string; kind: "compact"; event: EventOf<"compact"> }
  | { key: string; kind: "error"; event: EventOf<"error"> }
  | { key: string; kind: "interrupted"; event: EventOf<"interrupted"> }
  | { key: string; kind: "title"; event: EventOf<"title"> }
  | { key: string; kind: "status"; event: EventOf<"status"> };

/** Add events not seen yet; returns how many were new. */
export function mergeEvents(known: Map<number, Event>, events: readonly Event[] | null | undefined): number {
  let added = 0;
  for (const event of events ?? []) {
    if (known.has(event.seq)) continue;
    known.set(event.seq, event);
    added++;
  }
  return added;
}

export function sortedEvents(known: Map<number, Event>): Event[] {
  return [...known.values()].sort((a, b) => a.seq - b.seq);
}

/** A sealed log segment: JSON lines of events, oldest first. */
export function parseSegment(text: string): Event[] {
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Event);
}

export interface StreamBlock { index: number; type: Delta["type"]; name: string | null; text: string }

/** Streamed deltas grouped into blocks by index, in order. */
export function groupDeltas(deltas: readonly Delta[] | null | undefined): StreamBlock[] {
  const blocks = new Map<number, StreamBlock>();
  for (const delta of deltas ?? []) {
    const block = blocks.get(delta.index) ?? { index: delta.index, type: delta.type, name: null, text: "" };
    block.text += delta.text;
    if (delta.name) block.name = delta.name;
    blocks.set(delta.index, block);
  }
  return [...blocks.values()].sort((a, b) => a.index - b.index);
}

const is = <T extends Body["type"]>(event: Event, type: T): event is EventOf<T> => event.body.type === type;

/**
 * Group the log into items. Tool results and resolutions fold into the call they answer; the live
 * turn's calls say which are still running, reviewing or waiting for an answer.
 */
export function viewItems(events: readonly Event[], live: Readonly<Record<string, Call>> = {}): Item[] {
  const calls = new Map<string, CallInfo>();
  const results = new Map<string, ResultBody>();
  const resolutions = new Map<string, Resolution>();
  const reviews = new Map<string, ReviewBody>();
  for (const event of events) {
    const body = event.body;
    if (body.type === "assistant") {
      for (const block of body.blocks) if (block.type === "tool_call") calls.set(block.id, block);
    } else if (body.type === "tool_result") results.set(body.call, { ...body, seq: event.seq });
    else if (body.type === "tool_resolved") resolutions.set(body.call, body.resolution);
    else if (body.type === "tool_reviewed") reviews.set(body.call, body);
  }
  const prompted = new Set<string>();
  const items: Item[] = [];
  const key = (event: Event) => `e${event.seq}`;
  for (const event of events) {
    if (is(event, "user")) items.push({ key: key(event), kind: "user", event });
    else if (is(event, "assistant")) {
      const body = event.body;
      const shown = body.blocks.some((block) => block.type !== "redacted_thinking" && (block.type !== "thinking" || block.thinking.trim() !== ""));
      if (!shown && !body.interrupted) continue;
      const states: Record<string, Call["state"] | null> = {};
      const answered: Record<string, ResultBody | null> = {};
      for (const block of body.blocks) {
        if (block.type !== "tool_call") continue;
        answered[block.id] = results.get(block.id) ?? null;
        states[block.id] = live[block.id]?.state ?? null;
      }
      items.push({ key: key(event), kind: "assistant", event, results: answered, states });
    } else if (is(event, "tool_result")) {
      if (!calls.has(event.body.call)) items.push({ key: key(event), kind: "result", event });
    } else if (is(event, "tool_awaiting")) {
      const call = event.body.call;
      prompted.add(call);
      items.push({
        key: key(event), kind: "awaiting", event, awaiting: live[call]?.state === "awaiting",
        resolution: resolutions.get(call) ?? null, call: calls.get(call) ?? null, review: reviews.get(call) ?? null,
      });
    } else if (is(event, "tool_reviewed")) {
      // A call the reviewer left to the user shows why on its prompt.
      if (event.body.approved) items.push({ key: key(event), kind: "reviewed", event, call: calls.get(event.body.call) ?? null });
    } else if (is(event, "background_result")) items.push({ key: key(event), kind: "background", event, call: calls.get(event.body.call) ?? null });
    else if (is(event, "subagent")) items.push({ key: key(event), kind: "subagent", event, call: calls.get(event.body.call) ?? null });
    else if (is(event, "compact")) items.push({ key: key(event), kind: "compact", event });
    else if (is(event, "error")) items.push({ key: key(event), kind: "error", event });
    else if (is(event, "interrupted")) items.push({ key: key(event), kind: "interrupted", event });
    else if (is(event, "title")) items.push({ key: key(event), kind: "title", event });
    // The header shows the live status; the log marks where turns ended.
    else if (is(event, "status") && event.body.status === "idle") items.push({ key: key(event), kind: "status", event });
  }
  // An awaiting call whose prompt is outside the loaded window still needs an answer.
  for (const call of Object.values(live)) {
    if (call.state !== "awaiting" || prompted.has(call.id)) continue;
    items.push({
      key: `await:${call.id}`, kind: "awaiting", awaiting: true, resolution: null, call, review: reviews.get(call.id) ?? null,
      event: { session: "", seq: 0, at: 0, body: { type: "tool_awaiting", call: call.id, kind: call.approval ?? "permission", prompt: call.name } },
    });
  }
  return items;
}

// The words on items

const RESOLUTIONS: Record<Resolution, string> = {
  approved: "approved", denied: "denied", answered: "answered", preempted: "skipped for a new message", cancelled: "cancelled", timed_out: "timed out",
};

/** A prompt that was answered: "Permission for bash: denied". */
export function resolvedLabel(item: Extract<Item, { kind: "awaiting" }>): string {
  const what = item.event.body.kind === "elicitation" ? "Question" : `Permission for ${item.call?.name || "a tool"}`;
  return `${what}: ${item.resolution === null ? "resolved" : RESOLUTIONS[item.resolution]}`;
}

/** A score with all its digits, and at least two: 0.75, 0.749, 1.00. Rounding could make a score that missed the threshold look like it met it. */
export function scoreDigits(score: number): string {
  for (let digits = 2; digits < 20; digits++) if (Number(score.toFixed(digits)) === score) return score.toFixed(digits);
  return String(score);
}

/** A reviewer's answers, like "safe 0.425". */
export const scoreText = (scores: Record<string, number>) => Object.entries(scores).map(([question, score]) => `${question} ${scoreDigits(score)}`).join(" · ");

/** Why the reviewer left a call to the user, or null when it did not look at it. */
export function reviewNote(review: ReviewBody | null): string | null {
  if (review === null || review.approved) return null;
  const needed = review.threshold === undefined ? "" : `, needs ${scoreDigits(review.threshold)}`;
  return `Not auto-approved: ${review.note ?? `${review.reviewer} was not confident enough (${scoreText(review.scores)}${needed})`}`;
}

export function reviewedLabel(item: Extract<Item, { kind: "reviewed" }>): string {
  const what = item.call ? `${item.call.name} ${oneLine(toolSummary(item.call.input), 60)}`.trim() : "a tool call";
  return `Auto-approved ${what}`;
}

export function reviewedTitle(body: ReviewBody): string {
  const scores = scoreText(body.scores);
  return `Reviewed by ${body.reviewer}${scores ? `: ${scores}` : ""}`;
}

export function errorDetail(body: Extract<Body, { type: "error" }>): string {
  return `${body.code}${body.retryInMs === null ? "" : ` · retrying in ${Math.ceil(body.retryInMs / 1000)}s`}`;
}

export function usageLine(body: Extract<Body, { type: "assistant" }>): string {
  if (!body.usage) return body.model;
  const input = body.usage.input + body.usage.cacheRead + body.usage.cacheWrite;
  return `${body.model} · ${formatTokens(input)} in · ${formatTokens(body.usage.output)} out · ${formatDollars(body.costNanos)}`;
}

export type ToolStatus = "done" | "error" | Call["state"] | "pending";

export function toolStatus(result: { isError: boolean } | null | undefined, state: Call["state"] | null | undefined): ToolStatus {
  return result ? (result.isError ? "error" : "done") : state ?? "pending";
}

export const TOOL_LABELS: Partial<Record<ToolStatus, string>> = { done: "Done", error: "Failed", awaiting: "Waiting for you", reviewing: "Reviewing", running: "Running" };

export interface Unsent { text: string; tag: string; files: number }
export interface Pending { id: string; text: string; attachments: Attachment[] }

/** Messages accepted but not yet in the log (queued follow-ups and steers), then ones still being sent. */
export function unsentMessages(queued: readonly Queued[] | null | undefined, pending: readonly Pending[]): Unsent[] {
  return [
    ...(queued ?? []).filter((each) => each.result === null).map((each) => ({ text: each.text, tag: each.steer ? "Steer · next step" : "Queued · next turn", files: each.attachments.length })),
    ...pending.map((each) => ({ text: each.text, tag: "Sending…", files: each.attachments.length })),
  ];
}
