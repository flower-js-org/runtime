// A session's live log and composer.
import { createMemo, createProjection, createSignal, flush, For, onSettled, Show, untrack } from "solid-js";
import type { Delta, Event, Segment, Session, Source } from "../../../app/model.ts";
import { blobUrl, client, currentAuth, describe, fetchSegment, isForbidden } from "../api.ts";
import { formatDollars, STATUS_LABELS } from "../format.ts";
import { groupDeltas, mergeEvents, sortedEvents, unsentMessages, viewItems, type Item, type Pending, type StreamBlock } from "../log.ts";
import { busy, confirmAction, documentTitle, field, LockIcon, ModelOptions, openDialog, report, sessionHref, toast, Topbar } from "../ui.tsx";
import { Composer, type Message } from "./Composer.tsx";
import { LogItem, Streaming, UnsentMessages, type ItemContext } from "./Items.tsx";

/** Events per session.tail page; a full page means resubscribing from its newest event. */
const PAGE = 200;
/** How much recent history opening a session shows before "Load earlier messages". */
const INITIAL = 120;

const [unavailable, setUnavailable] = createSignal<string | null>(null);
/** The session that last failed to open as forbidden: switching organizations keeps its link. */
export const unavailableSession = unavailable;

/** Text to restore in a new session's composer after its first message failed to send. */
export const drafts = new Map<string, string>();

interface Banner { message: string; retry: boolean }
interface Tail { session: Session; events: Event[]; partial: { deltas: Delta[] } | null; segments: Segment[] }

export function SessionView(props: { id: string }) {
  const id = untrack(() => props.id);
  const me = currentAuth()!.claims.sub;
  const draft = drafts.get(id);
  drafts.delete(id);
  const abort = new AbortController();

  // Plain state for the loops below, which must see their own writes at once; signals for the view.
  const known = new Map<number, Event>();
  const segments = new Map<number, Segment>();
  const seen = new Set<string>();
  let latest: Session | null = null;
  let loadingEarlierNow = false;
  const [events, setEvents] = createSignal<Event[]>([]);
  const [session, setSession] = createSignal<Session | null>(null);
  const [streaming, setStreaming] = createSignal<StreamBlock[]>([]);
  const [pending, setPending] = createSignal<Pending[]>([]);
  const [banner, setBanner] = createSignal<Banner | null>(null);
  const [loadingEarlier, setLoadingEarlier] = createSignal(false);

  // Only the live calls matter to items; every other session change leaves them alone.
  const calls = createMemo(() => session()?.turn?.calls ?? {}, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  // Reconciled by key, so an item's DOM (and its open details) survives updates to the log.
  const items = createProjection<Item[]>(() => viewItems(events(), calls()), [], { key: "key" });
  const oldest = () => events()[0]?.seq ?? (session()?.seq ?? 0) + 1;
  const unsent = createMemo(() => unsentMessages(session()?.queued, pending()));

  let log!: HTMLDivElement;
  let stuck = true;
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const scrollToBottom = () => { log.scrollTop = log.scrollHeight; };

  function absorb(page: readonly Event[]) {
    mergeEvents(known, page);
    for (const event of page) if (event.body.type === "user") seen.add(event.body.message);
    setEvents(sortedEvents(known));
  }

  function apply(value: Tail) {
    absorb(value.events);
    latest = value.session;
    setSession(value.session);
    for (const segment of value.segments) segments.set(segment.from, segment);
    setStreaming(groupDeltas(value.partial?.deltas));
    // IDs are fresh UUIDs, so one in the log or the queue means the send landed, even before its reply.
    const queued = new Set(value.session.queued.map((each) => each.id));
    setPending((list) => list.filter((each) => !seen.has(each.id) && !queued.has(each.id)));
  }

  const oldestKnown = () => {
    let first = Infinity;
    for (const seq of known.keys()) first = Math.min(first, seq);
    return first === Infinity ? (latest?.seq ?? 0) + 1 : first;
  };

  async function start() {
    try {
      const { value } = await client().query("session.get", { session: id }, { signal: abort.signal, retry: true });
      if (value === null) return setBanner({ message: "This session does not exist.", retry: false });
      latest = value;
      setSession(value);
      void follow(Math.max(value.sealedThrough, value.seq - INITIAL));
    } catch (error) {
      if (abort.signal.aborted) return;
      if (isForbidden(error)) {
        setUnavailable(id);
        return setBanner({ message: "This session is not available here. It may be private or belong to another organization; switch organizations from the menu.", retry: false });
      }
      report(error, "Opening the session");
      setBanner({ message: `Could not open this session: ${describe(error)}`, retry: true });
    }
  }

  /** Watch the log from `after`, moving the cursor forward whenever a page fills. */
  async function follow(after: number) {
    setBanner(null);
    let first = true;
    while (!abort.signal.aborted) {
      let full = false;
      try {
        for await (const { value } of client().subscribe("session.tail", { session: id, after, limit: PAGE }, { signal: abort.signal })) {
          if (value === null) return setBanner({ message: "This session no longer exists.", retry: false });
          apply(value);
          if (first) {
            first = false;
            flush();
            scrollToBottom();
            if (known.size === 0 && oldestKnown() > 1) void loadEarlier();
          }
          if (value.events.length >= PAGE) {
            after = value.events.at(-1)!.seq;
            full = true;
            break;
          }
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        report(error, "Live updates");
        return setBanner({ message: `Live updates stopped: ${describe(error)}`, retry: true });
      }
      if (!full) return;
    }
  }

  function reconnect() {
    setBanner(null);
    let newest = 0;
    for (const seq of known.keys()) newest = Math.max(newest, seq);
    if (latest === null) void start();
    else void follow(newest || Math.max(latest.sealedThrough, latest.seq - INITIAL));
  }

  /** Page back through the live log, then through sealed segments in blob storage. */
  async function loadEarlier() {
    const first = oldestKnown();
    if (loadingEarlierNow || first <= 1 || latest === null) return;
    loadingEarlierNow = true;
    setLoadingEarlier(true);
    try {
      let earlier: Event[];
      const sealed = latest.sealedThrough;
      if (first - 1 > sealed) {
        const after = Math.max(sealed, first - 1 - PAGE);
        const { value } = await client().query("session.tail", { session: id, after, limit: first - 1 - after }, { signal: abort.signal, retry: true });
        earlier = (value?.events ?? []).filter((event) => event.seq < first);
        for (const segment of value?.segments ?? []) segments.set(segment.from, segment);
      } else {
        const covering = () => [...segments.values()].find((segment) => segment.from <= first - 1 && first - 1 <= segment.to);
        if (!covering()) {
          const { value } = await client().query("session.tail", { session: id, after: 0, limit: 1 }, { signal: abort.signal, retry: true });
          for (const segment of value?.segments ?? []) segments.set(segment.from, segment);
        }
        const segment = covering();
        if (!segment) throw new Error("Earlier messages are unavailable");
        earlier = await fetchSegment(id, segment.key);
      }
      const fromBottom = log.scrollHeight - log.scrollTop;
      absorb(earlier);
      flush();
      log.scrollTop = log.scrollHeight - fromBottom;
    } catch (error) {
      if (!abort.signal.aborted) report(error, "Loading earlier messages");
    } finally {
      loadingEarlierNow = false;
      setLoadingEarlier(false);
    }
  }

  async function send(message: Message): Promise<boolean> {
    const messageId = crypto.randomUUID();
    setPending((list) => [...list, { id: messageId, text: message.text, attachments: message.attachments }]);
    flush();
    scrollToBottom();
    try {
      await client().mutate("session.send", {
        session: id, message: messageId, text: message.text, ...(message.steer ? { steer: true } : {}), ...(message.attachments.length ? { attachments: message.attachments } : {}),
      }, { requestId: messageId, retry: true });
      return true;
    } catch (error) {
      setPending((list) => list.filter((each) => each.id !== messageId));
      report(error, "Sending");
      return false;
    }
  }

  const context: ItemContext = {
    me,
    blobUrl: (key) => blobUrl(id, key),
    resolve: async (call, answer) => {
      const done = await busy(null, () => client().mutate("session.resolve", { session: id, call, ...answer }, { retry: true }), "Answering");
      return done !== undefined;
    },
  };

  onSettled(() => {
    // Follow the bottom while the reader is there, including when images load or sections expand.
    const resize = new ResizeObserver(() => { if (stuck) scrollToBottom(); });
    resize.observe(log.firstElementChild!);
    void start();
    return () => {
      abort.abort();
      resize.disconnect();
    };
  });

  const title = () => session()?.title ?? (session() ? "Untitled session" : "Session");
  documentTitle(title);
  const copy = (event: MouseEvent) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-action=copy]");
    if (!button) return;
    const code = button.closest(".codeblock")?.querySelector("code")?.textContent ?? "";
    navigator.clipboard.writeText(code).then(() => {
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = "Copy"; }, 1500);
    }, () => toast("Copying needs clipboard permission."));
  };

  return (
    <div class="view session-view">
      <Topbar
        title={title()}
        subtitle={<Show when={session()}>{(s) => <SessionDetails session={s()} />}</Show>}
        actions={<Show when={session()}>{(s) => <SessionActions session={s()} id={id} onConfigure={() => configure(id, me, s(), setSession)} />}</Show>}
      />
      <Show when={banner()}>
        {(shown) => (
          <div class="banner">
            <span>{shown().message}</span>
            <Show when={shown().retry}><button type="button" onClick={reconnect}>Retry</button></Show>
          </div>
        )}
      </Show>
      <div ref={log} class="log" onScroll={() => { stuck = nearBottom(); }}>
        <div class="log-inner">
          <Show when={oldest() > 1}>
            <div class="earlier">
              <button type="button" disabled={loadingEarlier()} onClick={() => void loadEarlier()}>{loadingEarlier() ? "Loading…" : "Load earlier messages"}</button>
            </div>
          </Show>
          <div class="items" role="log" aria-label="Conversation" aria-relevant="additions" onClick={copy}>
            <For each={items}>{(item) => <div class="item"><LogItem item={item} context={context} /></div>}</For>
          </div>
          <div class="partial" aria-live="polite" aria-busy={streaming().length > 0 ? "true" : "false"} onClick={copy}><Streaming blocks={streaming()} /></div>
          <div class="queued"><UnsentMessages messages={unsent()} /></div>
          <Show when={session()?.seq === 0 && pending().length === 0}><div class="empty-log"><p>No messages yet.</p></div></Show>
        </div>
      </div>
      <Show when={session()}>
        {(s) => (
          <Show
            when={s().parent}
            fallback={
              <Composer
                onSend={send}
                onHalt={() => client().mutate("session.halt", { session: id }, { retry: true })}
                working={s().turn !== null}
                turn={s().turn !== null}
                draft={draft}
              />
            }
          >
            {(parent) => (
              <div class="readonly-note">
                A subagent works in this session; it takes work only from its parent. <a href={sessionHref(parent().session)}>Back to the parent session</a>
              </div>
            )}
          </Show>
        )}
      </Show>
    </div>
  );
}

/** Where a surface session's conversation lives, so people can switch between it and the web. */
function SourceLink(props: { source: Source }) {
  const label = () => {
    const name = props.source.surface === "slack" ? "Slack" : props.source.surface === "github" ? "GitHub" : props.source.surface;
    return props.source.label ? `${name}, ${props.source.label}` : name;
  };
  return (
    <Show when={props.source.url} fallback={<span class="tag">{label()}</span>}>
      {(url) => <a href={url()} target="_blank" rel="noopener">Continue in {label()}</a>}
    </Show>
  );
}

function SessionDetails(props: { session: Session }) {
  const s = () => props.session;
  return (
    <div class="subtitle">
      <span class={["badge", `status-${s().status}`]}>{STATUS_LABELS[s().status] ?? s().status}</span>
      <Show when={s().archived}><span class="badge">Archived</span></Show>
      <Show when={s().private}><span class="tag" title="Only its creator sees this session"><LockIcon /> Private</span></Show>
      <span class="muted">{s().model}</span>
      <span class="muted">{s().computer ? `on ${s().computer}` : "no computer"}</span>
      <span class="muted" title="Spent in this session">{formatDollars(s().costNanos)}</span>
      <Show when={s().parent}>{(parent) => <a href={sessionHref(parent().session)}>Parent session</a>}</Show>
      <Show when={s().source}>{(source) => <SourceLink source={source()} />}</Show>
    </div>
  );
}

function SessionActions(props: { session: Session; id: string; onConfigure: () => void }) {
  const background = () => Object.keys(props.session.background).length;
  return (
    <>
      <Show when={background()}>
        <span class="tag working">
          {background()} in background{" "}
          <button type="button" class="link" onClick={(event) => void busy(event.currentTarget, () => client().mutate("session.halt", { session: props.id, background: true }, { retry: true }), "Stopping")}>Stop</button>
        </span>
      </Show>
      <button type="button" onClick={() => props.onConfigure()}>Settings</button>
      <Show when={props.session.parent === null && !props.session.archived}>
        <button
          type="button"
          disabled={props.session.turn !== null}
          title={props.session.turn !== null ? "Halt the running turn first" : undefined}
          onClick={() => confirmAction("Archive this session?", "Its log moves to long-term storage. Sending a new message resumes it.", "Archive",
            () => client().mutate("session.archive", { session: props.id }, { retry: true }))}
        >Archive</button>
      </Show>
    </>
  );
}

async function configure(id: string, me: string, s: Session, setSession: (value: Session) => void) {
  let computers: { id: string; name: string; online: boolean }[] = [];
  try {
    computers = (await client().query("computer.list", null, { retry: true })).value;
  } catch (error) {
    report(error, "Listing computers");
  }
  const creator = s.createdBy === me;
  openDialog({
    title: "Session settings",
    body: () => (
      <>
        <label>Title<input name="title" value={s.title ?? ""} maxlength="200" placeholder="Generated from the first message" /></label>
        <label>Model<input name="model" value={s.model} list="models" required /></label>
        <ModelOptions />
        <label>Computer
          <select name="computer">
            <option value="">None</option>
            <For each={computers}>{(each) => <option value={each.id} selected={each.id === s.computer}>{each.name} ({each.online ? "online" : "offline"})</option>}</For>
            <Show when={s.computer && !computers.some((each) => each.id === s.computer)}><option value={s.computer!} selected>{s.computer}</option></Show>
          </select>
        </label>
        <label>Tools that run without asking<input name="allow" value={s.allow.join(", ")} placeholder="bash, write_file" /></label>
        <label class="check"><input type="checkbox" name="autoApprove" checked={s.autoApprove} /> Auto-approve tool calls that Jev judges safe</label>
        <label>Auto-approval threshold<input name="autoApproveAt" type="number" min="0" max="1" step="0.01" value={s.autoApproveAt} required /></label>
        <label class="check"><input type="checkbox" name="webTools" checked={s.webTools} /> Web search and fetch</label>
        <label class="check"><input type="checkbox" name="private" checked={s.private} disabled={!creator} /> Private{creator ? "" : " (only the creator can change this)"}</label>
      </>
    ),
    submit: async (form) => {
      const title = field(form, "title").value.trim();
      const { value } = await client().mutate("session.configure", {
        session: id,
        title: title === "" ? null : title,
        model: field(form, "model").value.trim(),
        computer: field(form, "computer").value || null,
        allow: field(form, "allow").value.split(/[\s,]+/).filter(Boolean),
        autoApprove: field(form, "autoApprove").checked,
        autoApproveAt: Number(field(form, "autoApproveAt").value),
        webTools: field(form, "webTools").checked,
        ...(creator ? { private: field(form, "private").checked } : {}),
      }, { retry: true });
      setSession({ ...s, ...value });
    },
  });
}
