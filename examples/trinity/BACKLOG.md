# Backlog

What [Moo](https://moo.pcarrier.com), the local agent workbench, does that Trinity doesn't, as of September 2026, leaving out what only matters when running on your own machine.

## Code as the tool

- The model has one tool, `runTS`: it writes TypeScript against a typed `moo.*` API, so one call can read, patch, run, query memory and call MCP tools together.
- Code is type-checked (strict, ES2025 plus the API's declarations) before it runs, and diagnostics point at the model's own lines.
- Results come back in a compact HJSON style, cut to 4,000 characters.
- The model can have a call move to the background after a delay it chooses, not only at once.
- The user can send a running call to the background, or cancel that one call, without halting the turn.
- A panel lists background calls, each with jump-to-step and cancel.
- Every API call is a trace span, exported over OTLP/HTTP. The agent can read its own traces: `moo.traces.diagnose` groups recent failures by cause (compile error, patch mismatch, missing file, non-zero exit, timeout…).

## Files, commands and HTTP

- `moo.fs.patch` applies unified or context-anchored patches with fuzzy matching: whitespace and Unicode punctuation are normalized, the search widens from the hinted line, stale context is tolerated, CRLF endings and a missing final newline are kept.
- Partial reads take several line ranges at once, merge overlaps and can number lines.
- Also glob, stat, exists, delete (recursive only when asked) and canonical paths.
- Every write and delete is recorded as a diff step in the timeline.
- Commands take argv without a shell, stdin, environment overrides, an output cap, and an option to throw on a non-zero exit. Timeouts kill the whole process group.
- HTTP requests with any method, headers and body, plus streamed reads, without a computer. Loopback, private, link-local and metadata addresses are blocked, including after redirects and DNS rebinding.
- A content-addressed object store and compare-and-swap pointers, usable by the agent.

## Repositories

- A session starts on a chosen git branch or jj revision. The picker lists local and remote branches with current, default and upstream marked, and jj bookmarks, `trunk()` and recent changes; it can fetch first.
- Extra named scratch directories per session, optionally copied from the current one, which subagents can work in.
- File listings show each file's uncommitted line changes; reads can include the diff against HEAD.
- Fuzzy path search over tracked and untracked files.
- The system prompt names the repository kind (git, jj or none) and which of 18 common CLI tools are installed, and includes the project's `AGENTS.md`.

## Sessions and the loop

- Fork a session at any step. The fork copies the session's memory graph as it was at that point, and keeps the model, effort and branch.
- Hide a user message from future requests, and restore it.
- Resume a failed or interrupted turn without sending a new message.
- Compact on demand. A request refused for exceeding the context window forces a compaction and retries. Automatic compaction stops after two in a row, and says so.
- Queued messages can be:
  - edited in place, including adding or removing their images;
  - promoted to a steer that interrupts the turn;
  - removed.
- Delete a session and everything it stored.
- A title set by hand is kept; the agent can't overwrite it.
- The agent records milestone summaries, shown with title changes, task changes and subagents as the session's trail.
- `moo.agent.start` opens another visible session. It inherits the repository, branch, model and effort unless told otherwise.
- Subagents take a step limit, a timeout, a reasoning effort, seeded tasks, an expected output and a named scratch. They report done, failed, cancelled or timed out.
- `moo.judge.check` and `assert` ask a one-step subagent to score a claim against evidence and criteria.

## Tasks

- A per-session task list: todo, doing, done, blocked and dropped, with notes. Changes appear as diff steps.
- A task can carry a validation function that runs when it is marked done. If the validation fails, the task stays open.
- If the model answers while tasks are outstanding, it is reminded and the turn goes on.
- Active tasks go into every request, and are carried across compactions. The UI shows them in a strip above the composer.

## Asking the user

- Forms with typed fields: text, textarea, number, URL, checkbox, select and secret, with required fields, defaults, a submit label and cancel.
- Choices, shown as buttons with descriptions.
- Answered and cancelled forms stay in the timeline, summarized.

## Memory as facts

- Memory is RDF quads: global, per project and per session. Terms are typed: IRIs, language-tagged and typed literals, integers, decimals, booleans and dates.
- Assert and retract only write facts that change. Every change is logged with its time, and shown in the timeline as a Turtle diff.
- Pattern matching with variables, multi-pattern joins, counts, atomic swaps and transactional updates.
- SPARQL SELECT, ASK and CONSTRUCT, supporting:
  - OPTIONAL, UNION, MINUS, VALUES, BIND and GROUP BY with aggregates;
  - ORDER BY, DISTINCT and LIMIT/OFFSET;
  - string and numeric functions;
  - inverse and sequence property paths.
- Fact history, and point-in-time copies of a graph.
- A vocabulary: the agent defines predicates with descriptions and examples, listed with usage counts.
- Schema summaries (predicates, classes, graphs) and TriG export.
- A facts browser:
  - a graph index with counts, and search inside a graph;
  - a filter to hide, include or show only removed facts, with paging;
  - Turtle per subject, with added and removed times;
  - delete a graph, a subject or a triple, and undelete a triple;
  - deep links to a subject.
- A pointers browser: a tree with search, previews of objects and JSON, and deletion of a pointer or a whole subtree.

## Apps

- The agent registers iframe apps (a manifest, a bundle and an optional server-side handler) and opens them beside the session, or as its primary surface.
- An app keeps state per instance, calls its handler, and queries or changes memory through `window.moo`. The iframe is sandboxed to scripts only.
- An apps page lists, opens and deletes them.
- A code explorer shows each app's files, with Prettier formatting and Mermaid rendering.

## Skills

- Skills are Markdown with frontmatter, from three sources that take precedence in this order: saved by the user, found in the repository under `.skills/`, or built in.
- Only enabled skills' metadata goes into the prompt; the model loads a skill's full text when it needs it.
- Saved skills can be fetched from a URL and refreshed from it later; private and metadata addresses are refused.
- Skills can be enabled and disabled, and a skills page edits them. Built-in and repository skills are read-only there.

## MCP

- OAuth for MCP servers:
  - endpoint discovery from protected-resource and authorization-server metadata;
  - dynamic client registration;
  - PKCE;
  - automatic token refresh;
  - log in and out from the web client, which returns to the session that asked.
- A server's session ID is kept. A lost session is initialized again once.
- Raw JSON-RPC requests to a server, besides tool calls.
- A tool browser with each tool's title, Markdown description and call signature.
- Per-server timeouts, and endpoint overrides for OAuth.

## Models

- Seven hosted providers: OpenAI, Anthropic, Qwen, Z.AI/GLM, xAI, DeepSeek and Kimi.
- A catalog records each model's context window, output limit, vision and tool support, availability and prices.
- OpenAI through the Responses API over pooled WebSocket connections, or through a ChatGPT subscription signed in with OAuth (browser or device code).
- Subscription endpoints for GLM's Coding Plan and Kimi Code, and a base URL override per provider.
- Reasoning effort per session, mapped to each provider's controls, from none to max.
- OpenAI's priority tier offered as a separate "fast" model option.
- The model picker lists recently used models first; new sessions start with the last model and effort used.
- Provider credentials are set from the web client and shown redacted.
- Pricing covers long-context tiers, DeepSeek's off-peak hours, thinking-mode output rates and fast-mode rates, with overrides. Models without a price are flagged rather than estimated.
- The retry policy (attempts, delays, jitter, the longest Retry-After to honor) is a setting. Retry hints are also read from error bodies and rate-limit reset headers.

## Web client

- Sessions:
  - the list shows each session's repository, branch, turns, steps and cost;
  - the cost tooltip breaks tokens down by model and includes subagents.
- A context meter in the session header shows use against the compaction threshold, next to a compact button.
- A side panel beside the session has these tabs, resizable and remembered per session:
  - the trail;
  - the session's total diff;
  - a file browser;
  - tabs for files, diffs, objects, JSON and apps.
- Diffs:
  - the net changeset of the whole session per file, as patience line diffs;
  - collapsed unchanged runs and syntax highlighting;
  - a fuzzy "jump to file";
  - memory changes as Turtle.
- Files:
  - Markdown and HTML previews, where relative links and assets resolve;
  - source views;
  - open files refresh when they change.
- Syntax highlighting for 18 languages. JSON shows as collapsible HJSON with nested JSON expanded.
- Mermaid diagrams render in messages, with a zoom and pan lightbox.
- Images and long code or results open in lightboxes; results copy with one click.
- Each step shows its time, duration, thinking time, model and effort. A reply can be copied as Markdown.
- The composer:
  - suggests `@path` completions from the workspace;
  - suggests earlier messages from every session;
  - keeps a draft per session;
  - shrinks images before upload.
- Esc stops the agent and sends what is queued.
- A terminal per session that starts in its workspace, with several tabs, restart on exit and theme-aware colors.
- Settings pages for providers, retries, compaction threshold, image size, highlighting limits and tracing.
- A light, dark or system theme switch, and installation as a PWA.
