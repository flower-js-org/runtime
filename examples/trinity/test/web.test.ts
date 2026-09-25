import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// The web client is plain JavaScript without declarations; importing it by a computed URL keeps tsc out of it.
const web = new URL("../web/", import.meta.url);
const render = await import(new URL("render.js", web).href);

/** Every tag the renderer may emit, with the only attributes it may carry. */
const ALLOWED = new RegExp([
  "</?(?:p|strong|em|del|ul|li|blockquote|table|thead|tbody|tr|span|pre|code|h[3-6])>",
  "<br>", "<hr>",
  "<ol(?: start=\"\\d+\")?>", "</ol>",
  "<li class=\"task\">", "<input type=\"checkbox\" disabled(?: checked)?>",
  "<code class=\"language-[\\w+#.-]+\">",
  "<(?:th|td)(?: class=\"align-(?:left|right|center)\")?>", "</(?:th|td)>",
  "<div class=\"(?:codeblock|codeblock-bar|table-wrap)\">", "</div>",
  "<button type=\"button\" class=\"copy\" data-action=\"copy\">", "</button>",
  "<a href=\"(?:https?://|mailto:)[^\"<>]*\" target=\"_blank\" rel=\"noopener noreferrer\">", "</a>",
].join("|"), "g");

function assertSafe(markup: string, source: string) {
  const leftover = markup.replace(ALLOWED, "");
  assert.ok(!leftover.includes("<"), `unexpected markup ${JSON.stringify(leftover)} from ${JSON.stringify(source)}`);
  assert.ok(!leftover.includes(">"), `stray > in ${JSON.stringify(leftover)} from ${JSON.stringify(source)}`);
}

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
];

test("model text never becomes markup", () => {
  for (const source of HOSTILE) {
    const markup = render.markdown(source);
    assertSafe(markup, source);
  }
  assert.equal(render.markdown("<b>hi</b> & 'you'"), "<p>&lt;b&gt;hi&lt;/b&gt; &amp; &#39;you&#39;</p>");
  assert.equal(render.markdown("&lt;"), "<p>&amp;lt;</p>");
  assert.ok(!render.markdown("[x](javascript:alert(1))").includes("href"));
  assert.ok(!render.markdown("[x](data:text/html,hi)").includes("href"));
});

test("Markdown covers what models write", () => {
  const md = render.markdown;
  assert.equal(md("# Title\n\nSome **bold**, *italic*, `code` and snake_case_name."),
    "<h3>Title</h3><p>Some <strong>bold</strong>, <em>italic</em>, <code>code</code> and snake_case_name.</p>");
  assert.equal(md("#hashtag"), "<p>#hashtag</p>");
  assert.equal(md("line one\nline two"), "<p>line one<br>line two</p>");
  assert.equal(md("- a\n- b\n  - c\n\n1. one\n2. two"),
    "<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul><ol><li>one</li><li>two</li></ol>");
  assert.equal(md("3. three\n4. four"), '<ol start="3"><li>three</li><li>four</li></ol>');
  assert.equal(md("- [x] done\n- [ ] todo"),
    '<ul><li class="task"><input type="checkbox" disabled checked> done</li><li class="task"><input type="checkbox" disabled> todo</li></ul>');
  assert.match(md("```ts\nconst a = 1 < 2;\n```"), /<pre><code class="language-ts">const a = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(md("```\nstill streaming"), /<pre><code>still streaming<\/code><\/pre>/);
  assert.equal(md("See [docs](https://example.com/a_(b)) now"),
    '<p>See <a href="https://example.com/a_(b)" target="_blank" rel="noopener noreferrer">docs</a> now</p>');
  assert.equal(md("Visit https://example.com/x."),
    '<p>Visit <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>.</p>');
  assert.equal(md("| a | b |\n|:--|--:|\n| 1 | 2 |"),
    '<div class="table-wrap"><table><thead><tr><th class="align-left">a</th><th class="align-right">b</th></tr></thead>'
    + '<tbody><tr><td class="align-left">1</td><td class="align-right">2</td></tr></tbody></table></div>');
  assert.equal(md("> quoted\n> more"), "<blockquote><p>quoted<br>more</p></blockquote>");
  assert.equal(md("a\n\n---\n\nb"), "<p>a</p><hr><p>b</p>");
  assert.equal(md("``a `tick` b``"), "<p><code>a `tick` b</code></p>");
});

test("the html tag escapes interpolations unless marked raw", () => {
  const value = render.html`<p title="${'"x"'}">${"<b>"}${render.raw("<i>ok</i>")}${["<", render.raw("&")]}${null}${false}</p>`;
  assert.equal(value.html, '<p title="&quot;x&quot;">&lt;b&gt;<i>ok</i>&lt;&</p>');
});

const at = 1_700_000_000_000;
const event = (seq: number, body: unknown) => ({ session: "s1", seq, at: at + seq, body });

test("tool results fold into their calls and prompts show only while awaiting", () => {
  const events = [
    event(1, { type: "user", message: "m1", text: "hi <there>", attachments: [{ blob: "sha256/" + "a".repeat(64), name: "cat.png", mediaType: "image/png", size: 10 }], author: "ann" }),
    event(2, { type: "status", status: "working" }),
    event(3, { type: "assistant", blocks: [
      { type: "thinking", thinking: "hmm", signature: "sig" },
      { type: "text", text: "Running **it**" },
      { type: "tool_call", id: "c1", name: "bash", input: { command: "rm -rf <dir>" } },
      { type: "tool_call", id: "c2", name: "read_file", input: { path: "a.txt" } },
    ], model: "claude-opus-5", stopReason: "tool_use", usage: null, costNanos: 0, interrupted: false }),
    event(4, { type: "tool_awaiting", call: "c1", kind: "permission", prompt: "rm -rf <dir>" }),
    event(5, { type: "tool_result", call: "c2", content: "<secret>", isError: true, blob: null }),
    event(6, { type: "status", status: "waiting_on_user" }),
  ];
  const session = { turn: { calls: { c1: { id: "c1", name: "bash", input: {}, state: "awaiting", approval: "permission" }, c2: { id: "c2", state: "done" } } } };
  const items = render.viewItems(events, session);
  assert.deepEqual(items.map((item: { kind: string }) => item.kind), ["user", "assistant", "awaiting"]);
  const opts = { blobUrl: (key: string) => `/blobs/s1/${key}?token=t`, me: "bob" };
  const [user, assistant, prompt] = items.map((item: unknown) => render.itemHtml(item, opts));
  assert.match(user, /hi &lt;there&gt;/);
  assert.match(user, /<span>ann<\/span>/);
  assert.match(user, /<img src="\/blobs\/s1\/sha256\/a{64}\?token=t" alt="cat.png"/);
  assert.match(assistant, /<strong>it<\/strong>/);
  assert.match(assistant, /<details class="thinking"/);
  assert.match(assistant, /class="tool awaiting"[\s\S]*rm -rf &lt;dir&gt;/);
  assert.match(assistant, /class="tool error"[\s\S]*&lt;secret&gt;/);
  assert.match(prompt, /data-action="approve" data-call="c1"/);
  assert.match(prompt, /data-action="always"/);

  const resolved = [...events, event(7, { type: "tool_resolved", call: "c1", resolution: "denied" }), event(8, { type: "tool_result", call: "c1", content: "denied", isError: true, blob: null }), event(9, { type: "status", status: "idle" })];
  const after = render.viewItems(resolved, { turn: null });
  assert.deepEqual(after.map((item: { kind: string }) => item.kind), ["user", "assistant", "awaiting", "status"]);
  assert.notEqual(after[1].sig, items[1].sig);
  const card = render.itemHtml(after[2], opts);
  assert.doesNotMatch(card, /data-action/);
  assert.match(card, /Permission for bash: denied/);
});

test("an awaiting call outside the loaded window still gets a prompt", () => {
  const session = { turn: { calls: { q: { id: "q", name: "ask_user", input: { question: "Which?" }, state: "awaiting", approval: "elicitation" } } } };
  const [item] = render.viewItems([], session);
  const markup = render.itemHtml(item, { blobUrl: () => "", me: "x" });
  assert.match(markup, /<form class="answer" data-action="answer" data-call="q">/);
});

test("subagents link to their session and other events render", () => {
  const events = [
    event(1, { type: "assistant", blocks: [{ type: "tool_call", id: "t1", name: "subagent", input: { description: "Scan <repo>", prompt: "p" } }], model: "m", stopReason: "tool_use", usage: null, costNanos: 0, interrupted: false }),
    event(2, { type: "subagent", call: "t1", session: "s1.t1" }),
    event(3, { type: "compact", summary: "We did *things*" }),
    event(4, { type: "error", code: "OVERLOADED", message: "Busy <now>", retryInMs: 2000 }),
    event(5, { type: "interrupted" }),
    event(6, { type: "background_result", call: "t1", content: "done", isError: false, blob: "sha256/" + "b".repeat(64) }),
    event(7, { type: "assistant", blocks: [], model: "m", stopReason: "refusal", usage: null, costNanos: 0, interrupted: false }),
  ];
  const items = render.viewItems(events, null);
  assert.deepEqual(items.map((item: { kind: string }) => item.kind), ["assistant", "subagent", "compact", "error", "interrupted", "background"]);
  const html = items.map((item: unknown) => render.itemHtml(item, { blobUrl: (key: string) => `/b/${key}`, me: "x" }));
  assert.match(html[1], /href="#\/sessions\/s1\.t1"[\s\S]*Scan &lt;repo&gt;/);
  assert.match(html[2], /<em>things<\/em>/);
  assert.match(html[3], /Busy &lt;now&gt;[\s\S]*retrying in 2s/);
  assert.match(html[5], /href="\/b\/sha256\/b{64}"/);
});

test("streamed deltas group by block and render dimmed thinking", () => {
  const blocks = render.groupDeltas([
    { index: 1, type: "text", text: "Hel" },
    { index: 0, type: "thinking", text: "consider" },
    { index: 1, type: "text", text: "lo <b>" },
    { index: 2, type: "tool_call", name: "bash", text: "{\"command\":" },
  ]);
  assert.deepEqual(blocks.map((block: { type: string; text: string }) => [block.type, block.text]), [["thinking", "consider"], ["text", "Hello <b>"], ["tool_call", "{\"command\":"]]);
  const markup = render.partialHtml(blocks);
  assert.match(markup, /thinking-live[\s\S]*consider/);
  assert.match(markup, /Hello &lt;b&gt;/);
  assert.match(markup, /<span class="tool-name">bash<\/span>/);
});

test("queued and pending messages render escaped", () => {
  const markup = render.queuedHtml([{ id: "q", text: "<next>", steer: true, at, attachments: [], author: null, result: null }], [{ text: "sending <x>" }]);
  assert.match(markup, /&lt;next&gt;[\s\S]*Steer/);
  assert.match(markup, /sending &lt;x&gt;[\s\S]*Sending…/);
});

test("money and segments", () => {
  assert.equal(render.formatDollars(12_345_000_000), "$12.35");
  assert.equal(render.formatDollars(1_000_000), "$0.0010");
  assert.equal(render.dollarsToNanos("$1,250.50"), 1_250_500_000_000);
  assert.equal(render.dollarsToNanos(" "), null);
  assert.throws(() => render.dollarsToNanos("-3"));
  assert.equal(render.nanosToDollars(render.dollarsToNanos("19.99")), "19.99");
  assert.equal(render.formatTokens(1_234_567), "1.2M");
  const known = new Map();
  assert.equal(render.mergeEvents(known, render.parseSegment(`${JSON.stringify(event(2, { type: "interrupted" }))}\n${JSON.stringify(event(1, { type: "interrupted" }))}\n`)), 2);
  assert.equal(render.mergeEvents(known, [event(2, { type: "interrupted" })]), 0);
  assert.deepEqual(render.sortedEvents(known).map((each: { seq: number }) => each.seq), [1, 2]);
});

test("the browser modules import only what exists", () => {
  const sdk = new URL("../node_modules/@flower-js/sdk/dist/", import.meta.url);
  const files = readdirSync(web).filter((name) => name.endsWith(".js"));
  const source = (name: string) => readFileSync(new URL(name, web), "utf8");
  const exported = (text: string) => new Set([
    ...[...text.matchAll(/export (?:async )?(?:function|class|const|let) (\w+)/g)].map((match) => match[1]),
    ...[...text.matchAll(/export \{([^}]+)\}/g)].flatMap((match) => match[1]!.split(",").map((name) => name.trim().split(/\s+as\s+/).pop()!)),
  ]);
  assert.ok(existsSync(new URL("index.html", web)) && existsSync(new URL("style.css", web)));
  for (const file of files) {
    for (const match of source(file).matchAll(/import \{([^}]+)\} from "([^"]+)"/g)) {
      const names = match[1]!.split(",").map((name) => name.trim()).filter(Boolean);
      const target = match[2]!;
      const text = target.startsWith("/sdk/") ? readFileSync(new URL(target.slice(5), sdk), "utf8") : source(target.replace(/^\.\//, ""));
      const available = exported(text);
      for (const name of names) assert.ok(available.has(name), `${file} imports ${name} from ${target}, which does not export it`);
    }
  }
});
