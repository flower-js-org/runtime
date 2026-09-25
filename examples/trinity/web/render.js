// Pure rendering: Markdown, formatting and log grouping. No DOM here, so Node tests import it.
// Every string of model, user or tool text reaches HTML only through escapeHtml.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

class Raw {
  constructor(html) {
    this.html = html;
  }
  toString() {
    return this.html;
  }
}

/** Mark trusted markup so html`` interpolates it unescaped. */
export const raw = (markup) => new Raw(markup);

/** Escapes every interpolation except raw() values; arrays are joined. Returns raw() so templates nest. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let index = 0; index < values.length; index++) out += fragment(values[index]) + strings[index + 1];
  return new Raw(out);
}

function fragment(value) {
  if (value instanceof Raw) return value.html;
  if (Array.isArray(value)) return value.map(fragment).join("");
  if (value === null || value === undefined || value === false) return "";
  return escapeHtml(value);
}

// ---- Markdown

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TABLE_RULE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;

const indentOf = (line) => /^[ \t]*/.exec(line)[0].replace(/\t/g, "    ").length;

function dedent(line, width) {
  let removed = 0;
  let index = 0;
  while (index < line.length && removed < width && (line[index] === " " || line[index] === "\t")) {
    removed += line[index] === "\t" ? 4 : 1;
    index++;
  }
  return line.slice(index);
}

/** Render Markdown to HTML. Raw HTML in the source is shown as text, and only http(s) and mailto links are live. */
export function markdown(source) {
  const text = String(source ?? "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "�");
  return blocks(text.split("\n"));
}

function startsBlock(lines, index) {
  const line = lines[index];
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  const item = ITEM.exec(line);
  if (item && item[3]) return true;
  return isTable(lines, index);
}

function isTable(lines, index) {
  const next = lines[index + 1];
  return lines[index].includes("|") && next !== undefined && next.includes("-") && TABLE_RULE.test(next)
    && cells(next).length === cells(lines[index]).length;
}

function blocks(lines) {
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index++;
      continue;
    }
    let match = FENCE.exec(line);
    if (match) {
      const fence = match[1];
      const closing = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
      const code = [];
      index++;
      // An unclosed fence runs to the end, which is what a streaming response looks like.
      while (index < lines.length && !closing.test(lines[index])) code.push(lines[index++]);
      index++;
      out.push(codeBlock(code.join("\n"), match[2]));
      continue;
    }
    match = HEADING.exec(line);
    if (match) {
      const level = Math.min(6, match[1].length + 2);
      out.push(`<h${level}>${inline((match[2] ?? "").replace(/[ \t]+#+$/, ""))}</h${level}>`);
      index++;
      continue;
    }
    if (RULE.test(line)) {
      out.push("<hr>");
      index++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner = [];
      while (index < lines.length && (match = QUOTE.exec(lines[index]))) {
        inner.push(match[1]);
        index++;
      }
      out.push(`<blockquote>${blocks(inner)}</blockquote>`);
      continue;
    }
    if (ITEM.test(line)) {
      const [markup, next] = list(lines, index);
      out.push(markup);
      index = next;
      continue;
    }
    if (isTable(lines, index)) {
      const [markup, next] = table(lines, index);
      out.push(markup);
      index = next;
      continue;
    }
    const paragraph = [line.trim()];
    index++;
    while (index < lines.length && lines[index].trim() !== "" && !startsBlock(lines, index)) paragraph.push(lines[index++].trim());
    out.push(`<p>${inline(paragraph.join("\n"))}</p>`);
  }
  return out.join("");
}

function codeBlock(code, language) {
  const lang = /^[\w+#.-]{1,32}$/.test(language) ? language : "";
  return `<div class="codeblock"><div class="codeblock-bar"><span>${escapeHtml(lang)}</span>`
    + `<button type="button" class="copy" data-action="copy">Copy</button></div>`
    + `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(code)}</code></pre></div>`;
}

function list(lines, start) {
  const first = ITEM.exec(lines[start]);
  const indent = indentOf(lines[start]);
  const ordered = /\d/.test(first[2]);
  const items = [];
  let loose = false;
  let index = start;
  while (index < lines.length) {
    const match = ITEM.exec(lines[index]);
    if (!match || indentOf(lines[index]) !== indent || /\d/.test(match[2]) !== ordered) break;
    const width = indent + match[2].length + 1;
    const body = [match[3] ?? ""];
    index++;
    while (index < lines.length) {
      const line = lines[index];
      if (line.trim() === "") {
        let next = index + 1;
        while (next < lines.length && lines[next].trim() === "") next++;
        if (next < lines.length && indentOf(lines[next]) > indent) {
          for (; index < next; index++) body.push("");
          loose = true;
          continue;
        }
        const sibling = next < lines.length ? ITEM.exec(lines[next]) : null;
        if (sibling && indentOf(lines[next]) === indent && /\d/.test(sibling[2]) === ordered) loose = true;
        index = next;
        break;
      }
      const depth = indentOf(line);
      if (depth > indent) {
        body.push(dedent(line, Math.min(depth, width)));
        index++;
        continue;
      }
      if (ITEM.test(line) || startsBlock(lines, index)) break;
      body.push(line.trim());
      index++;
    }
    items.push(body);
  }
  const markup = items.map((body) => {
    const task = /^\[([ xX])\][ \t]+/.exec(body[0]);
    const content = task ? [body[0].slice(task[0].length), ...body.slice(1)] : body;
    let inner = blocks(content);
    if (!loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, "$1");
    if (!task) return `<li>${inner}</li>`;
    return `<li class="task"><input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> ${inner}</li>`;
  }).join("");
  const number = parseInt(first[2], 10);
  const tag = ordered ? "ol" : "ul";
  return [`<${tag}${ordered && number !== 1 ? ` start="${number}"` : ""}>${markup}</${tag}>`, index];
}

function cells(row) {
  let text = row.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function table(lines, start) {
  const head = cells(lines[start]);
  const aligns = cells(lines[start + 1]).map((cell) =>
    cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : "");
  const rows = [];
  let index = start + 2;
  while (index < lines.length && lines[index].trim() !== "" && lines[index].includes("|")) rows.push(cells(lines[index++]));
  const cell = (tag, text, column) => `<${tag}${aligns[column] ? ` class="align-${aligns[column]}"` : ""}>${inline(text ?? "")}</${tag}>`;
  const body = rows.map((row) => `<tr>${head.map((_, column) => cell("td", row[column], column)).join("")}</tr>`).join("");
  return [`<div class="table-wrap"><table><thead><tr>${head.map((text, column) => cell("th", text, column)).join("")}</tr></thead><tbody>${body}</tbody></table></div>`, index];
}

function emphasis(text) {
  return text
    .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
    .replace(/(^|[^*\w])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>");
}

const link = (href, label) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;

/**
 * Inline Markdown. Code spans are cut out first, the rest is escaped, and links and emphasis are
 * matched on the escaped text, so a pattern can only ever wrap escaped text in fixed tags.
 */
function inline(source) {
  const slots = [];
  const hold = (markup) => `\u0000${slots.push(markup) - 1}\u0000`;
  let text = source.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, ticks, code) => {
    const trimmed = /^ [\s\S]* $/.test(code) && code.trim() !== "" ? code.slice(1, -1) : code;
    return hold(`<code>${escapeHtml(trimmed)}</code>`);
  });
  text = escapeHtml(text);
  text = text.replace(/\[([^\]\n]+)\]\(\s*((?:[^()\s]|\([^()\s]*\))+)(?:\s+&quot;[^\n]*?&quot;)?\s*\)/g, (whole, label, url) =>
    SAFE_URL.test(url) ? hold(link(url, emphasis(label))) : whole);
  text = text.replace(/\bhttps?:\/\/(?:(?!&(?:quot|#39|lt|gt);)[^\s\u0000])+/g, (url) => {
    let tail = "";
    const unbalanced = (value) => value.endsWith(")") && value.split("(").length < value.split(")").length;
    while (/[.,:;!?*_~\]]$/.test(url) || unbalanced(url)) {
      tail = url.slice(-1) + tail;
      url = url.slice(0, -1);
    }
    return hold(link(url, url)) + tail;
  });
  text = emphasis(text).replace(/\n/g, "<br>");
  // Link labels may hold code spans, so restore until no placeholder remains.
  for (let depth = 0; depth < 4 && text.includes("\u0000"); depth++) text = text.replace(/\u0000(\d+)\u0000/g, (_, slot) => slots[Number(slot)]);
  return text;
}

// ---- Formatting

export function formatDollars(nanos) {
  if (nanos === null || nanos === undefined) return "—";
  const dollars = nanos / 1e9;
  if (dollars !== 0 && Math.abs(dollars) < 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A dollar amount typed by a user, as nanodollars; empty means no limit. */
export function dollarsToNanos(text) {
  const trimmed = String(text ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (trimmed === "") return null;
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars) || dollars < 0) throw new RangeError(`Invalid dollar amount ${JSON.stringify(text)}`);
  return Math.round(dollars * 1e9);
}

export function nanosToDollars(nanos) {
  return nanos === null || nanos === undefined ? "" : String(Math.round(nanos / 1e7) / 100);
}

export function formatTokens(count) {
  const value = Number(count ?? 0);
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}k`;
  return String(value);
}

export function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function relativeTime(at, now = Date.now()) {
  if (!at) return "";
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: now - at > 300 * 86_400_000 ? "numeric" : undefined });
}

export function clockTime(at) {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function dateTime(at) {
  return at ? new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function oneLine(text, max) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A short description of a tool call from its input, for collapsed views. */
export function toolSummary(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "";
  const preferred = ["command", "path", "description", "question", "query", "url", "title", "name", "id", "key"];
  const value = preferred.map((field) => input[field]).find((each) => typeof each === "string")
    ?? Object.values(input).find((each) => typeof each === "string");
  return value === undefined ? "" : oneLine(value, 140);
}

export const STATUS_LABELS = { idle: "Idle", working: "Working", waiting_on_user: "Needs you", halted: "Halted", error: "Error" };

// ---- The log

/** Add events not seen yet; returns how many were new. */
export function mergeEvents(known, events) {
  let added = 0;
  for (const event of events ?? []) {
    if (known.has(event.seq)) continue;
    known.set(event.seq, event);
    added++;
  }
  return added;
}

export function sortedEvents(known) {
  return [...known.values()].sort((a, b) => a.seq - b.seq);
}

/** A sealed log segment: JSON lines of events, oldest first. */
export function parseSegment(text) {
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

/** Streamed deltas grouped into blocks by index, in order. */
export function groupDeltas(deltas) {
  const blocks = new Map();
  for (const delta of deltas ?? []) {
    const block = blocks.get(delta.index) ?? { index: delta.index, type: delta.type, name: null, text: "" };
    block.text += delta.text;
    if (delta.name) block.name = delta.name;
    blocks.set(delta.index, block);
  }
  return [...blocks.values()].sort((a, b) => a.index - b.index);
}

/**
 * Group the log into rendered items. Tool results and resolutions fold into the call they answer;
 * `sig` changes whenever an item's markup would, so callers re-render only changed items.
 */
export function viewItems(events, session) {
  const calls = new Map();
  const results = new Map();
  const resolutions = new Map();
  for (const event of events) {
    const body = event.body;
    if (body.type === "assistant") {
      for (const block of body.blocks) if (block.type === "tool_call") calls.set(block.id, block);
    } else if (body.type === "tool_result") results.set(body.call, { ...body, seq: event.seq });
    else if (body.type === "tool_resolved") resolutions.set(body.call, body.resolution);
  }
  const live = session?.turn?.calls ?? {};
  const prompted = new Set();
  const items = [];
  const push = (event, kind, sig = "", extra = {}) => items.push({ key: `e${event.seq}`, sig: `${kind}:${sig}`, kind, event, ...extra });
  for (const event of events) {
    const body = event.body;
    switch (body.type) {
      case "user":
        push(event, "user");
        break;
      case "assistant": {
        const shown = body.blocks.some((block) => block.type !== "redacted_thinking" && (block.type !== "thinking" || block.thinking.trim() !== ""));
        if (!shown && !body.interrupted) break;
        const state = {};
        const answered = {};
        for (const block of body.blocks) {
          if (block.type !== "tool_call") continue;
          answered[block.id] = results.get(block.id) ?? null;
          state[block.id] = live[block.id]?.state ?? null;
        }
        const sig = Object.keys(state).map((id) => `${answered[id]?.seq ?? ""}${state[id] ?? ""}`).join(",");
        push(event, "assistant", sig, { results: answered, states: state });
        break;
      }
      case "tool_result":
        if (!calls.has(body.call)) push(event, "result");
        break;
      case "tool_awaiting": {
        prompted.add(body.call);
        const awaiting = live[body.call]?.state === "awaiting";
        const resolution = resolutions.get(body.call) ?? null;
        push(event, "awaiting", `${awaiting}:${resolution}`, { awaiting, resolution, call: calls.get(body.call) ?? null });
        break;
      }
      case "background_result":
      case "subagent":
        push(event, body.type === "subagent" ? "subagent" : "background", "", { call: calls.get(body.call) ?? null });
        break;
      case "compact":
      case "error":
      case "interrupted":
      case "title":
        push(event, body.type);
        break;
      case "status":
        // The header shows the live status; the log marks where turns ended.
        if (body.status === "idle") push(event, "status");
        break;
    }
  }
  // An awaiting call whose prompt is outside the loaded window still needs an answer.
  for (const call of Object.values(live)) {
    if (call.state !== "awaiting" || prompted.has(call.id)) continue;
    items.push({
      key: `await:${call.id}`, sig: "awaiting:live", kind: "awaiting", awaiting: true, resolution: null, call,
      event: { seq: 0, at: 0, body: { type: "tool_awaiting", call: call.id, kind: call.approval ?? "permission", prompt: call.name } },
    });
  }
  return items;
}

function inputText(input) {
  if (input && typeof input === "object" && typeof input.command === "string" && Object.keys(input).length === 1) return input.command;
  return JSON.stringify(input, null, 2);
}

function outputLink(blob, opts) {
  return blob ? html`<a class="output-link" href="${opts.blobUrl(blob)}" target="_blank" rel="noopener">Full output</a>` : "";
}

function toolCall(call, result, state, opts) {
  const status = result ? (result.isError ? "error" : "done") : state ?? "pending";
  const label = { done: "Done", error: "Failed", awaiting: "Waiting for you", running: "Running" }[status] ?? "";
  return html`<details class="tool ${status}" data-k="call:${call.id}">
<summary><span class="tool-dot" aria-hidden="true"></span><span class="tool-name">${call.name}</span><span class="tool-summary">${toolSummary(call.input)}</span>${label ? html`<span class="tool-state">${label}</span>` : ""}</summary>
<div class="tool-body">${call.input === null ? "" : html`<div class="tool-label">Input</div><pre class="code">${inputText(call.input)}</pre>`}${result ? html`<div class="tool-label">${result.isError ? "Error" : "Result"}</div><pre class="code result">${result.content}</pre>${outputLink(result.blob, opts)}` : ""}</div>
</details>`;
}

function providerBlock(block, key) {
  const inner = block.block ?? {};
  const name = typeof inner.name === "string" ? inner.name : String(inner.type ?? "provider").replace(/_/g, " ");
  const found = Array.isArray(inner.content) ? inner.content.filter((each) => each && typeof each.url === "string") : [];
  const body = found.length > 0
    ? html`<ul class="links">${found.slice(0, 20).map((each) => html`<li>${SAFE_URL.test(each.url) ? html`<a href="${each.url}" target="_blank" rel="noopener noreferrer">${each.title || each.url}</a>` : each.url}</li>`)}</ul>`
    : html`<pre class="code">${JSON.stringify(inner.input ?? inner.content ?? inner, null, 2)}</pre>`;
  const summary = inner.input ? toolSummary(inner.input) : found.length > 0 ? `${found.length} results` : "";
  return html`<details class="tool done provider" data-k="${key}"><summary><span class="tool-dot" aria-hidden="true"></span><span class="tool-name">${name}</span><span class="tool-summary">${summary}</span></summary><div class="tool-body">${body}</div></details>`;
}

function attachments(list, opts) {
  if (!list?.length) return "";
  return html`<div class="attachments">${list.map((each) => {
    const url = opts.blobUrl(each.blob);
    return each.mediaType.startsWith("image/")
      ? html`<a class="attachment image" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${each.name}" loading="lazy"></a>`
      : html`<a class="attachment" href="${url}" target="_blank" rel="noopener"><span class="attachment-name">${each.name}</span><span class="attachment-size">${formatBytes(each.size)}</span></a>`;
  })}</div>`;
}

const marker = (text, extra = "") => html`<div class="marker ${extra}"><span>${text}</span></div>`;

const RESOLUTIONS = { approved: "approved", denied: "denied", answered: "answered", preempted: "skipped for a new message", cancelled: "cancelled", timed_out: "timed out" };

function awaitingCard(item) {
  const { call: callId, kind, prompt } = item.event.body;
  const name = item.call?.name ?? "";
  if (!item.awaiting) {
    const what = kind === "elicitation" ? "Question" : `Permission for ${name || "a tool"}`;
    return marker(`${what}: ${RESOLUTIONS[item.resolution] ?? "resolved"}`, "resolved");
  }
  if (kind === "elicitation") {
    return html`<div class="card prompt" role="group" aria-label="Question from the agent">
<div class="card-title">Question</div><div class="md">${raw(markdown(prompt))}</div>
<form class="answer" data-action="answer" data-call="${callId}"><label class="sr-only" for="answer-${callId}">Your answer</label>
<textarea id="answer-${callId}" name="answer" rows="2" required placeholder="Your answer"></textarea>
<div class="actions"><button type="submit" class="primary">Send answer</button></div></form></div>`;
  }
  return html`<div class="card prompt" role="group" aria-label="Permission request">
<div class="card-title">Allow <code>${name || prompt}</code>?</div>
${prompt && prompt !== name ? html`<div class="prompt-text">${prompt}</div>` : ""}
${item.call ? html`<details class="prompt-input" data-k="await:${callId}"><summary>Input</summary><pre class="code">${inputText(item.call.input)}</pre></details>` : ""}
<div class="actions"><button type="button" class="primary" data-action="approve" data-call="${callId}">Approve</button><button type="button" data-action="always" data-call="${callId}">Always allow</button><button type="button" class="danger" data-action="deny" data-call="${callId}">Deny</button></div></div>`;
}

/** Markup for one item of viewItems. `opts.blobUrl(key)` links stored blobs; `opts.me` is the viewer's subject. */
export function itemHtml(item, opts) {
  const { event } = item;
  const body = event.body;
  switch (item.kind) {
    case "user":
      return html`<div class="msg user"><div class="bubble"><div class="plain">${body.text}</div>${attachments(body.attachments, opts)}</div>
<div class="meta">${body.author && body.author !== opts.me ? html`<span>${body.author}</span> · ` : ""}<time datetime="${new Date(event.at).toISOString()}">${clockTime(event.at)}</time></div></div>`.html;
    case "assistant": {
      const parts = body.blocks.map((block, index) => {
        switch (block.type) {
          case "text": return html`<div class="md">${raw(markdown(block.text))}</div>`;
          case "thinking":
            return block.thinking.trim() === "" ? "" : html`<details class="thinking" data-k="think:${event.seq}:${index}"><summary>Thinking</summary><div class="md">${raw(markdown(block.thinking))}</div></details>`;
          case "tool_call": return toolCall(block, item.results[block.id], item.states[block.id], opts);
          case "provider": return providerBlock(block, `prov:${event.seq}:${index}`);
          default: return "";
        }
      });
      // Interrupted responses are followed by an "Interrupted" marker, so only truncation needs a note.
      const notes = body.stopReason === "max_tokens" ? "Stopped at the output limit" : "";
      const usage = body.usage ? `${body.model} · ${formatTokens(body.usage.input + body.usage.cacheRead + body.usage.cacheWrite)} in · ${formatTokens(body.usage.output)} out · ${formatDollars(body.costNanos)}` : body.model;
      return html`<div class="msg assistant">${parts}${notes ? html`<div class="meta note">${notes}</div>` : ""}<div class="meta usage" title="${usage}"><time datetime="${new Date(event.at).toISOString()}">${clockTime(event.at)}</time></div></div>`.html;
    }
    case "result":
      return html`<div class="msg assistant">${toolCall({ id: body.call, name: "Tool result", input: null }, body, null, opts)}</div>`.html;
    case "awaiting":
      return awaitingCard(item).html;
    case "background": {
      const name = item.call ? `${item.call.name} ${toolSummary(item.call.input)}` : body.call;
      return html`<div class="msg assistant"><details class="tool ${body.isError ? "error" : "done"} background" data-k="bg:${event.seq}">
<summary><span class="tool-dot" aria-hidden="true"></span><span class="tool-name">Background result</span><span class="tool-summary">${name}</span></summary>
<div class="tool-body"><pre class="code result">${body.content}</pre>${outputLink(body.blob, opts)}</div></details></div>`.html;
    }
    case "subagent": {
      const description = item.call?.input?.description ?? "Subagent";
      return html`<div class="msg assistant"><a class="subagent" href="#/sessions/${encodeURIComponent(body.session)}"><span class="subagent-label">Subagent</span><span>${description}</span><span aria-hidden="true">→</span></a></div>`.html;
    }
    case "compact":
      return html`<details class="compact" data-k="compact:${event.seq}"><summary>Earlier conversation summarized</summary><div class="md">${raw(markdown(body.summary))}</div></details>`.html;
    case "error":
      return html`<div class="error-card"><strong>${body.message}</strong><span class="error-code">${body.code}${body.retryInMs === null ? "" : ` · retrying in ${Math.ceil(body.retryInMs / 1000)}s`}</span></div>`.html;
    case "interrupted":
      return marker("Interrupted", "warn").html;
    case "title":
      return marker(`Titled “${body.title}”`).html;
    case "status":
      return marker(`Done · ${clockTime(event.at)}`).html;
    default:
      return "";
  }
}

/** The completion streaming now: text as Markdown, thinking dimmed, tool inputs as they arrive. */
export function partialHtml(blocks) {
  return blocks.map((block) => {
    if (block.type === "text") return `<div class="md">${markdown(block.text)}</div>`;
    if (block.type === "thinking") {
      const text = block.text.length > 1200 ? `…${block.text.slice(-1200)}` : block.text;
      return html`<div class="thinking-live"><span class="thinking-label">Thinking</span><div class="plain">${text}</div></div>`.html;
    }
    return html`<div class="tool running live"><div class="tool-live-head"><span class="tool-dot" aria-hidden="true"></span><span class="tool-name">${block.name ?? "tool"}</span></div><pre class="code">${block.text.slice(-2000)}</pre></div>`.html;
  }).join("");
}

/** Messages accepted but not yet in the log (queued follow-ups and steers), then ones still being sent. */
export function queuedHtml(queued, pending) {
  const shown = [
    ...(queued ?? []).filter((each) => each.result === null).map((each) => ({ text: each.text, tag: each.steer ? "Steer · next step" : "Queued · next turn", files: each.attachments.length })),
    ...pending.map((each) => ({ text: each.text, tag: "Sending…", files: each.attachments?.length ?? 0 })),
  ];
  return shown.map((each) => html`<div class="msg user unsent"><div class="bubble"><div class="plain">${each.text}</div>${each.files ? html`<div class="meta">${each.files} attachment${each.files === 1 ? "" : "s"}</div>` : ""}</div><div class="meta">${each.tag}</div></div>`.html).join("");
}
