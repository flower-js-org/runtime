# Trinity

Trinity rebuilds a tiny subset of Indent's agent product on [Flower](../../README.md). In Indent, a worker process leases each session, runs the loop in memory and must replay its event chain after a crash. In Trinity no process owns a session: the loop is a state machine of Flower mutations, and every I/O step is a leased queue job run by a stateless worker.

- Each transition appends to the session's log and updates the session's state in the same commit, so there is nothing to replay.
- Completions, computer tools, MCP calls, surface replies, billing events, sandbox provisioning and log sealing are Flower queue jobs with fenced leases. Cancelling a job is the handoff; a stale worker's reports are refused.
- Prompts, halts, steering, subagents, retries, budgets and timers are decided inside mutations, so each is atomic.
- The product's data lives in Flower too: organizations, members, settings, sessions, memory, automations, computers, MCP servers and usage.

## Architecture

| Part | Runs | Does |
| --- | --- | --- |
| `app/` | Inside Flower (QuickJS, every replica) | The session state machine (`loop.ts`), tools (`tools.ts`), organizations, memory, automations, computers, surfaces, MCP catalog, usage, access control |
| `workers/llm.ts` | Worker | Claims completions, renders the log for Claude, streams, stores deltas, reports the response |
| `workers/service.ts` | Worker | Service-scope tools (MCP calls, `read_output`), log sealing, titles, MCP catalogs, GitHub replies, Stripe meter events |
| `workers/slack.ts` | Worker | Holds the Slack app's Socket Mode connection: messages, reactions and buttons in, replies, cards and marks out |
| `workers/sim.ts` | Worker | A simulated model and simulated computers, for load tests and working without credentials |
| `workers/sandbox.ts` | Worker | Starts and stops Docker sandboxes on demand and runs tools inside the running ones |
| `workers/local.ts` | The user's machine | Runs a registered computer's tools in a workspace directory, on the computer's own token |
| `gateway/` | Edge | Web client, token issuance, the public path to Flower's `/v1` API, uploads and access-checked downloads, connecting Slack workspaces and accounts, GitHub webhooks |
| `web/` | Browser | Sessions with live streaming, approvals, attachments, settings, computers, automations, memory, usage |

Blobs (attachments, long tool outputs, sealed log segments) live in object storage (S3, R2, Garage, MinIO) or a directory; the database keeps references.

### A turn

1. `session.send` appends the user's message, opens a turn and enqueues completion job `session:step`, whose payload pins the log position the request may see.
2. An LLM worker claims it, reads `session.prompt` (events since the latest compaction, plus sealed segments when needed), and streams from Claude. Every 250 ms it stores deltas with `completions.progress`, which answers `stop` once the step is no longer wanted.
3. `completions.complete` records usage and cost, appends the assistant message and dispatches its tool calls in the same commit: unknown or invalid calls get error results, inline tools run, tools needing approval park the turn (and ask in the thread for Slack or GitHub sessions), and the rest are enqueued on the session's computer scope or the service scope. Background calls return at once.
4. Workers report through `tools.complete`. When no call is outstanding and a completion is owed, the next one is enqueued. A turn ends when a completion makes no calls and no steer is waiting; a surface session then posts its reply, a subagent resolves its parent's call.

Steers wait for the next completion boundary and preempt open prompts; follow-ups wait for the next turn. When the estimated request exceeds the session's context budget, the next step is a compaction: the model summarizes, requests start at the summary, and the log before it moves to blob storage. A halt keeps streamed text as an interrupted message, cancels prompts at once and running tools after the session's grace window, answers every call and appends an `interrupted` boundary.

### Tools

`bash` (optionally in the background), `read_file`, `write_file`, `list_files`, `read_output`, `ask_user`, `set_title`, `subagent`, `memory_list`/`memory_read`/`memory_write`, `create_automation`/`list_automations`/`delete_automation`, every tool of the organization's MCP servers (`mcp__<server>__<tool>`), and Anthropic's server-side `web_search` and `web_fetch`. `bash`, `write_file`, automation changes and untrusted MCP tools ask first unless the session allows them.

### Access

The gateway signs Ed25519 JWTs; the deployed bundle verifies them with Flower's native `jwtBearer`. Tokens carry a role: users act in one organization (membership rows decide what they may do there), workers run queues, computers claim only their own tool scope, and the gateway's service role delivers surface messages. Private sessions are visible to their creator only.

## Run it

Trinity lives in Flower's `examples/`: it imports the repository's SDK and builds its server, in Flower's own dev shell. With [Nix](https://determinate.systems/nix) and [direnv](https://direnv.net):

```sh
direnv allow
dev
```

`dev` (`bin/dev`) starts the whole stack under process-compose: Flower's SDK and a release server built from this repository, a single-node cluster in `.dev/flower`, the application (deployed again whenever `app/` changes), the gateway, and the LLM, service and sandbox workers. Open http://127.0.0.1:8301 and sign in as `dev`: organization `dev` already exists, with this machine as its computer, working in `.dev/workspace`.

- **Credentials.** Put `ANTHROPIC_API_KEY=…` (and any `TRINITY_SECRET_*`) in `.env.local`, then restart `llm` and `service` from the process-compose view.
- **No credentials?** `dev --sim` runs a simulated model in their place: each turn makes a random number of tool calls before it answers, with latencies shaped like a real model's and machine's but 20 times faster. It also serves the simulated computers `sim-0`…`sim-15` that load tests use.
- **Slack** connects once you run `trinity slack setup` (see [Slack](#slack)); the `slack` process waits for it.
- **Sandboxes** start once Docker is running (restart `sandboxes`).
- **Ports** are 7301 for Flower and 8301 for the gateway, clear of Flower's own dev node; override `TRINITY_FLOWER_PORT` and `TRINITY_PORT` in `.env.local`. `FLOWER_BIN` skips building the server.
- **Everything local** lives in `.dev/`: data, blobs, logs (`.dev/logs/<process>.log`), the signing key and the CLI's tokens. `rm -rf .dev` starts over.
- `process-compose attach --use-uds` reconnects to a running stack; `process-compose down --use-uds` stops it.

`npm run check` runs the typecheck and tests. The CLI talks to the gateway:

```sh
trinity login alice
trinity org create acme "Acme"
trinity computer register laptop
trinity local --computer laptop --workspace ~/src/some-project   # in another terminal
trinity new --computer laptop                                     # prints a session ID
trinity watch SESSION
trinity send SESSION "What does this project do?"
trinity mcp add linear https://mcp.linear.app/mcp --header 'Authorization=Bearer ${secret:LINEAR}'
```

### Slack

Trinity joins Slack like Indent does, over a Socket Mode connection instead of webhooks, so it needs no public address:

- **Mentions and direct messages.** Mention the bot in a channel, or message it directly. Each thread is a session; later mentions in the thread steer it. Replies that don't mention the bot are left alone, and their author is reminded once.
- **Reactions.** 👀 marks the messages a turn is working on; ✅ moves to the latest one when it answers. 🛑 on any message of the thread halts its session.
- **Prompts.** Approvals become Approve and Deny buttons, and questions an Answer form, updated in place however they are settled.
- **Slack and the web.** Every answer links to its session, which shows a link back to its thread. Turns started on the web answer on the web; the thread hears about the turns its own messages started or joined. Direct messages start private sessions.
- **People.** Each person acts as a Trinity member. Someone the bot doesn't know yet gets a "Connect your account" link to the web client, once.

`trinity slack setup` registers the app, while you are signed in to the organization as an admin (`trinity login`):

1. It asks for an app configuration token (api.slack.com/apps → *Your App Configuration Tokens*), creates the app from its manifest (`workers/slack-setup.ts`: scopes, events, Socket Mode, the App Home) and saves its credentials in `.env.local`. Running it again updates the app from the manifest.
2. It asks for an app-level token, which only the app's settings page issues, and links there.
3. It connects a workspace. Locally, you install the app from its settings page (Slack only redirects OAuth to https) and paste the bot token. With an https `TRINITY_PUBLIC_URL` and the app's client credentials on the gateway, it gives you Slack's install page instead, and admins can also add workspaces from Settings.

The gateway seals each workspace's bot token with a key derived from the signing key before storing it, so Flower holds ciphertext only. `trinity slack status` lists connected workspaces and your linked accounts.

### Deploying to a cluster

Run Flower as documented in its README, then:

```sh
FLOWER_ADMIN_TOKEN=… FLOWER_URL=http://flower-1:7101 TRINITY_AUTH_KEY=/secure/auth.pem npm run deploy
TRINITY_AUTH_KEY=/secure/auth.pem FLOWER_URL=… TRINITY_BLOBS=s3://bucket/trinity npm run gateway
TRINITY_AUTH_KEY=/secure/auth.pem FLOWER_URL=… TRINITY_BLOBS=s3://bucket/trinity bin/trinity llm        # and service, sandboxes, slack
```

| Setting | Used by | Meaning |
| --- | --- | --- |
| `FLOWER_URL`, `FLOWER_ADMIN_TOKEN` | deploy, gateway, workers | The cluster; the admin token only for deployment |
| `TRINITY_AUTH_KEY` | deploy, gateway, workers | Ed25519 private key (PKCS#8 PEM); deploy compiles its public half into the bundle. Workers without it take `TRINITY_TOKEN` |
| `TRINITY_BLOBS` | gateway, workers | `s3://bucket/prefix` (with `AWS_*`, and `TRINITY_S3_ENDPOINT` for R2/Garage/MinIO) or `file:///dir` |
| `TRINITY_SECRET_<NAME>` | service | Secrets named in MCP headers (`${secret:NAME}`), `github_token[_<org>]`, `stripe_key` |
| `SLACK_APP_TOKEN` | slack | The Slack app's app-level token (`xapp-…`, `connections:write`) for Socket Mode |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | gateway | Installing the Slack app from the web with OAuth (needs an https `TRINITY_PUBLIC_URL`) |
| `GITHUB_WEBHOOK_SECRET`, `GITHUB_BOT_LOGIN`, `TRINITY_GITHUB_OWNERS` | gateway | GitHub webhooks; owner or repository → organization |
| `TRINITY_PUBLIC_URL` | gateway, service, slack | Where browsers reach the gateway: links from Slack and GitHub, OAuth redirects |
| `TRINITY_CELLS`, `FLOWER_PARTITION` | gateway, workers | Organizations in named partitions, and the partition a worker serves |
| `TRINITY_DEV_LOGIN=1` | gateway | Anyone signs in as anyone: development only |

### Operating notes

- **Retention.** Completed jobs are deleted when their result reaches the log. Flower's request receipts (one per mutation, including every streaming flush) grow until you initialize Flower's retry retention; see [RETENTION.md](../../RETENTION.md).
- **Memory.** Flower keeps live state in RAM. Idle history leaves it when compaction seals the log before the summary, and `session.archive` seals a whole session; attachments and long outputs never enter it.
- **Sharding.** Deploy the bundle to each named partition, map organizations to partitions with `TRINITY_CELLS`, and run workers per partition with `FLOWER_PARTITION`. Organizations do not span partitions; nothing on the hot path is a cross-partition transaction.
- **Keys.** Rotating the signing key means deploying the new public key and reissuing tokens.

## Load tests

`bench/drive.ts` plays many people at once: each owns a session, sends a message, watches the session until the turn ends, pauses, and sends the next. Against the simulated model, which reports how long each turn spent in the model and tools, the rest of a turn's latency is Trinity's and Flower's own.

```sh
dev --sim                                      # or `trinity sim` next to any deployment
npm run bench -- --sessions 2000 --turns 3     # --help lists the options
```

It creates the organization `bench` (`--org`) with the simulated computers, then reports sessions created per second, turns and completions per second, and the percentiles of turn latency, simulated time and overhead (`--json` saves them). `trinity sim` claims through a pool with one readiness watch per queue scope (`workers/pool.ts`), so thousands of jobs can be in flight on a few HTTP/2 connections.

Today Flower does work for every open watch on every commit, so throughput falls as sessions watched at once grow; 10,000 watched sessions saturate a node. [FLOWER.md](FLOWER.md) has the measurements and what Trinity needs from Flower.

## Tests

`npm run check` typechecks and runs the unit and scenario tests: the application on Flower's in-process engine (bundled, with a stand-in authenticator, since that engine has no native crypto), the simulated model, rendering, the gateway against a fake upstream, blob storage signatures, MCP against an in-process server, the Slack worker against a stand-in Slack, the GitHub and Stripe clients, and the local tools. Docker tests run when Docker is available. `npm run e2e` runs the whole stack on a temporary real server with a scripted model: gateway sign-in, a computer on its own token, a permission prompt, compaction and sealing to blob storage, and a Slack thread from connecting the workspace to an approval button.

## Deliberate differences from Indent

- **Tool calls run once the response is complete**, not while it streams. A refusal can end a response after a complete call, and a server-side fallback drops the declining model's calls, so a call is only final with the whole message.
- **Streamed deltas live in Flower**, one row per worker flush, instead of Redis. A halt keeps them as an interrupted message in the same commit.
- **Computers claim their own tool jobs** from Flower instead of receiving RPCs over a WebSocket bridge; the interactive terminal and browser relay stay outside Trinity.
- **Memory is documents in Flower** instead of git repositories, and only Anthropic models are wired in (`workers/anthropic.ts` is the provider boundary).
- **Slack connects over Socket Mode** instead of webhooks, and answers are single markdown messages rather than Block Kit rewrites of the text.
