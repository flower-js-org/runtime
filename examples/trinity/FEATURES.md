# What Trinity does

Trinity's features as of September 2026.

## Sessions and the agent loop

- Create, send, halt, archive and configure sessions. The settings are:
  - model and system prompt;
  - computer;
  - private or not;
  - tools allowed without asking;
  - autoapproval by Jev, on unless turned off;
  - web tools on or off;
  - halt grace window;
  - context budget.
- A new message can steer the running turn at its next step, or wait as a follow-up for the next turn.
- Halting keeps the text streamed so far, cancels prompts at once and cancels running tools after the grace window.
- Streamed text, thinking and tool input are stored every 250 ms, so any viewer can follow live.
- Tool calls run in parallel once the whole response has arrived.
  - Tools can ask for permission first (approve, deny or always allow) or ask the user a question.
  - Jev reviews permission requests first, with the conversation that led to them. Calls it is confident the user asked for and that are safe run without asking; the rest ask, saying why. A failed or slow review asks too.
  - Tools have timeouts, and `bash` can run in the background, its result arriving later as a message.
- Model calls and tool jobs retry within attempt budgets. A tool that isn't safe to repeat never re-runs after a crash; it reports an unknown outcome instead.
- Refusals, output-limit cutoffs, paused turns, Anthropic's automatic fallback model and adaptive thinking are all handled.
- Prompt caching, with a frozen request per step so retries reuse the cache.
- When the context estimate exceeds its budget, the model writes a summary, and older history moves to blob storage after a count and checksum check.
- Subagents run as child sessions, and titles are generated automatically.
- Usage and cost are recorded per completion.

## Tools

- Computer: `bash`, `read_file`, `write_file`, `list_files`.
- Conversation: `read_output` (long outputs stored as blobs), `ask_user`, `set_title`, `subagent`.
- Memory: `memory_list`, `memory_read`, `memory_write`.
- Automations: `create_automation`, `list_automations`, `delete_automation`.
- Web: `web_search`, `web_fetch`.
- MCP: every tool of the organization's MCP servers. Trusted servers run without asking; others ask first, unless Jev approves the call.

## Models

Anthropic only. Claude Opus 5 by default, chosen per session or per organization.

## Memory and automations

- Memory documents are scoped to the organization or to one user. Each scope's `index.md` goes into every turn, and the web client has an editor.
- Automations run on cron schedules (5 fields or @macros, at a fixed UTC offset), each run starting a new session. They can be edited, deleted, turned on or off, or run immediately.

## Computers

- Your own machine as a computer: it's registered, runs a worker on its own token, stays online while it heartbeats, and works in a workspace directory.
- Docker sandboxes start when a tool needs them and stop after 30 idle minutes.
- Organizations have a default computer.
- Simulated computers exist for load tests.

## Slack

Over Socket Mode, so no public address is needed.

- Mentions and direct messages start a session bound to the thread; later mentions steer it.
- Replies without a mention are ignored, and their author is nudged once.
- 👀 marks the messages being worked on, ✅ moves to the answered one, 🛑 halts the session.
- Approvals are Approve/Deny buttons and questions an Answer form. The cards update wherever the prompt is settled.
- Answers are markdown with an "Open in Trinity" link. Turns started on the web answer on the web.
- Direct messages start private sessions.
- Slack people link to a Trinity member through a signed link to the web client.
- Attachments go to blob storage.
- An App Home tab.
- An edit that adds a mention counts as a new message.
- Several workspaces can connect.
- `trinity slack setup` creates the app from its manifest; workspaces can also be installed through OAuth when the deployment has an https address.

## GitHub

Issue and PR comments that mention the bot start a session bound to that thread, with answers and prompts posted back as comments.

## Organizations, access and usage

- Organizations with admins and members; admins control settings, members and MCP servers.
- Private sessions are visible to their creator only.
- A monthly budget is checked before every model call.
- Monthly spend totals and per-session cost.
- Usage is reported to Stripe as meter events.
- The gateway signs Ed25519 tokens for users (development sign-in only), computers, workers and the Slack service. Flower verifies them natively.
- Organization switching.
- Secrets never reach Flower in the clear: MCP headers hold references resolved by workers, and Slack bot tokens are stored encrypted.

## Clients

- **Web**: a live session list and session view with approvals (and why Jev left them to you), attachments, halt and steer, session settings and archive. Pages for computers, automations, memory, usage and settings (members, MCP servers, Slack), a page to connect a Slack account, and links between sessions and their Slack threads.
- **CLI**:
  - `login`, `org`, `new`, `list`, `send`, `watch`;
  - `approve`, `deny`, `answer`, `halt`;
  - `computer`, `local`, `mcp`, `token`;
  - the workers: `llm`, `service`, `sandboxes`, `slack`, `sim`.

## Platform

- The session state machine runs inside Flower. Every step is one atomic mutation, and every model call or tool call is a leased job that stale workers can't report on after losing it. Nothing replays after a crash.
- Blob storage on S3-compatible stores or a directory.
- Organizations can live in separate Flower partitions.
- `dev` starts the whole local stack, and `dev --sim` runs without credentials.
- `npm run bench` drives thousands of simulated users.
- 136 tests plus an end-to-end run on a real server that includes a Slack thread.
