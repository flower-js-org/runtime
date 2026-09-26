# Working in Trinity

Run `npm run check` before committing, and `npm run e2e` after changing `app/`, `gateway/` or worker protocols: it deploys the bundle to a real server with real JWT verification. Trinity lives in Flower's `examples/`; rebuild Flower's SDK (`npm --prefix ../.. run build`) after changing it, since Trinity imports its `dist/`.

## Flower application (`app/`)

- The bundle runs in QuickJS on every replica: synchronous code, no I/O, no `Date` or `Intl` (use `ctx.now()`, `calendar.ts` and `cron.ts`), and no state kept between calls.
- Modules import each other in cycles (the loop, tools, timers, surfaces, sealing, automations, computers). Top-level code may use only the SDK, `model.ts` and `store.ts`; everything else is used inside functions.
- `loop.ts` is the turn and nothing else. Behavior that belongs to a feature (surface replies, sealing, memory snapshots, usage) lives in that feature's module and is called from the loop.
- Every exposed method declares `access`. Roles come from token claims (`access.ts`); organization membership comes from rows, never from the claim alone.
- Load sessions through `Tx` (`tx.ts`) and end with `tx.commit()`. One mutation may change several sessions (a subagent's result, a halt cascading to children, a surface message); `Tx` keeps one copy of each.
- Write to the log only through `append`. The session row carries the next sequence number, so the row and the log commit together.
- Every mutation does work proportional to the event it handles. Never rebuild session state by reading the log inside Flower.
- Decide what happens next in `advance`, from outstanding calls and whether a completion is owed. Never from a provider stop reason (`pause_turn` only marks a continuation as owed).
- Every tool call in the log gets exactly one result, including on halt, error, refusal, truncation and timeout, so every rendered request stays valid. A refusal's output is discarded, not logged.
- Worker methods check the lease they are given. Lease expiry writes nothing, so attempt budgets are enforced when a job is claimed again.
- A tool whose `idempotent` is false never runs twice on its own: a reclaimed call reports an unknown outcome instead.
- The reviewer (`reviews.ts`) only approves. Anything short of a confident verdict, including a failed, lost or slow review, asks the user as if there had been no review.
- Sealed events leave the database only after `sealing.complete` has checked the stored copy's count and checksum against the log. One seal job per session runs at a time.
- Keep watched queries bounded: `session.tail` pages by cursor and lists sealed history as segments.

## Workers and gateway

- `session.prompt` is the request, frozen at the step's log position, so a retry sends the same request and keeps prompt-cache hits. History is append-only: replay thinking and provider blocks verbatim and never edit earlier turns.
- Return provider failures as outcomes with `retryable` set; throw only when the step is gone or the lease is lost. The session owns the retry budget.
- Validate model-produced tool inputs in the app (each tool's `input` schema), not in workers: with eager input streaming the API no longer does.
- Secrets never enter Flower in the clear: MCP headers hold `${secret:NAME}` references that workers resolve, and Slack bot tokens are sealed with a key derived from the signing key, which only workers and the gateway hold.
- The gateway forwards only `/v1` (and `/partitions/*/v1`) to Flower; operator routes stay private.

## Tests

- Test the application through `test/support/harness.ts`, which bundles `test/support/app.ts` (the app with a stand-in authenticator) and runs it in its own context, as the server would. Pass credentials per call to test access.
- Keep one test per observable contract; prefer assertions on the session log (`t.log()`) and prompts (`t.promptLog()`) over internal state.
