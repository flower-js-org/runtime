// How each item of a session's log looks. Text reaches the DOM as text; only markdown() output is set as HTML.
import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Attachment, Block } from "../../../app/model.ts";
import { clockTime, formatBytes, inputText, isoTime, toolSummary } from "../format.ts";
import {
  errorDetail, resolvedLabel, reviewedLabel, reviewedTitle, reviewNote, TOOL_LABELS, toolStatus, usageLine,
  type CallInfo, type Item, type ResultBody, type StreamBlock, type Unsent,
} from "../log.ts";
import { SAFE_URL } from "../markdown.ts";
import { sessionHref } from "../ui.tsx";
import { Markdown } from "./Markdown.tsx";

export interface ItemContext {
  me: string;
  blobUrl: (key: string) => string;
  /** Answer a prompt; resolves true once the answer is in. */
  resolve: (call: string, answer: { approve: boolean; always?: boolean } | { answer: string }) => Promise<boolean>;
}

type Of<K extends Item["kind"]> = Extract<Item, { kind: K }>;

const Marker = (props: { text: string; class?: string; title?: string }) => <div class={["marker", props.class]} title={props.title}><span>{props.text}</span></div>;

const Time = (props: { at: number }) => <time datetime={isoTime(props.at)}>{clockTime(props.at)}</time>;

export function LogItem(props: { item: Item; context: ItemContext }) {
  return (
    <Switch>
      <Match when={props.item.kind === "user" && props.item}>{(item) => <UserMessage item={item()} context={props.context} />}</Match>
      <Match when={props.item.kind === "assistant" && props.item}>{(item) => <AssistantMessage item={item()} context={props.context} />}</Match>
      <Match when={props.item.kind === "result" && props.item}>
        {(item) => <div class="msg assistant"><ToolCall call={{ id: item().event.body.call, name: "Tool result", input: null }} result={{ ...item().event.body, seq: item().event.seq }} state={null} context={props.context} /></div>}
      </Match>
      <Match when={props.item.kind === "awaiting" && props.item}>{(item) => <Prompt item={item()} context={props.context} />}</Match>
      <Match when={props.item.kind === "reviewed" && props.item}>
        {(item) => <Marker class="resolved" text={reviewedLabel(item())} title={reviewedTitle(item().event.body)} />}
      </Match>
      <Match when={props.item.kind === "background" && props.item}>{(item) => <Background item={item()} context={props.context} />}</Match>
      <Match when={props.item.kind === "subagent" && props.item}>
        {(item) => (
          <div class="msg assistant">
            <a class="subagent" href={sessionHref(item().event.body.session)}>
              <span class="subagent-label">Subagent</span>
              <span>{description(item().call)}</span>
              <span aria-hidden="true">→</span>
            </a>
          </div>
        )}
      </Match>
      <Match when={props.item.kind === "compact" && props.item}>
        {(item) => <details class="compact"><summary>Earlier conversation summarized</summary><Markdown text={item().event.body.summary} /></details>}
      </Match>
      <Match when={props.item.kind === "error" && props.item}>
        {(item) => <div class="error-card"><strong>{item().event.body.message}</strong><span class="error-code">{errorDetail(item().event.body)}</span></div>}
      </Match>
      <Match when={props.item.kind === "interrupted"}><Marker class="warn" text="Interrupted" /></Match>
      <Match when={props.item.kind === "title" && props.item}>{(item) => <Marker text={`Titled “${item().event.body.title}”`} />}</Match>
      <Match when={props.item.kind === "status" && props.item}>{(item) => <Marker text={`Done · ${clockTime(item().event.at)}`} />}</Match>
    </Switch>
  );
}

const description = (call: CallInfo | null) => {
  const input = call?.input as { description?: unknown } | null | undefined;
  return typeof input?.description === "string" ? input.description : "Subagent";
};

function UserMessage(props: { item: Of<"user">; context: ItemContext }) {
  const body = () => props.item.event.body;
  return (
    <div class="msg user">
      <div class="bubble">
        <div class="plain">{body().text}</div>
        <Attachments list={body().attachments} context={props.context} />
      </div>
      <div class="meta">
        <Show when={body().author && body().author !== props.context.me}><span>{body().author}</span> · </Show>
        <Time at={props.item.event.at} />
      </div>
    </div>
  );
}

function Attachments(props: { list: Attachment[]; context: ItemContext }) {
  return (
    <Show when={props.list.length > 0}>
      <div class="attachments">
        <For each={props.list}>
          {(each) => (
            <Show
              when={each.mediaType.startsWith("image/")}
              fallback={
                <a class="attachment" href={props.context.blobUrl(each.blob)} target="_blank" rel="noopener">
                  <span class="attachment-name">{each.name}</span><span class="attachment-size">{formatBytes(each.size)}</span>
                </a>
              }
            >
              <a class="attachment image" href={props.context.blobUrl(each.blob)} target="_blank" rel="noopener">
                <img src={props.context.blobUrl(each.blob)} alt={each.name} loading="lazy" />
              </a>
            </Show>
          )}
        </For>
      </div>
    </Show>
  );
}

function AssistantMessage(props: { item: Of<"assistant">; context: ItemContext }) {
  const body = () => props.item.event.body;
  return (
    <div class="msg assistant">
      <For each={body().blocks}>{(block) => <AssistantBlock block={block} item={props.item} context={props.context} />}</For>
      {/* Interrupted responses are followed by an "Interrupted" marker, so only truncation needs a note. */}
      <Show when={body().stopReason === "max_tokens"}><div class="meta note">Stopped at the output limit</div></Show>
      <div class="meta usage" title={usageLine(body())}><Time at={props.item.event.at} /></div>
    </div>
  );
}

function AssistantBlock(props: { block: Block; item: Of<"assistant">; context: ItemContext }): JSX.Element {
  return (
    <Switch>
      <Match when={props.block.type === "text" && props.block}>{(block) => <Markdown text={block().text} />}</Match>
      <Match when={props.block.type === "thinking" && props.block.thinking.trim() !== "" && props.block}>
        {(block) => <details class="thinking"><summary>Thinking</summary><Markdown text={block().thinking} /></details>}
      </Match>
      <Match when={props.block.type === "tool_call" && props.block}>
        {(block) => <ToolCall call={block()} result={props.item.results[block().id] ?? null} state={props.item.states[block().id] ?? null} context={props.context} />}
      </Match>
      <Match when={props.block.type === "provider" && props.block}>{(block) => <ProviderBlock block={block().block} />}</Match>
    </Switch>
  );
}

function ToolCall(props: { call: CallInfo; result: ResultBody | null; state: Of<"assistant">["states"][string]; context: ItemContext }) {
  const status = () => toolStatus(props.result, props.state);
  return (
    <details class={["tool", status()]}>
      <summary>
        <span class="tool-dot" aria-hidden="true" />
        <span class="tool-name">{props.call.name}</span>
        <span class="tool-summary">{toolSummary(props.call.input)}</span>
        <Show when={TOOL_LABELS[status()]}>{(label) => <span class="tool-state">{label()}</span>}</Show>
      </summary>
      <div class="tool-body">
        <Show when={props.call.input !== null}>
          <div class="tool-label">Input</div>
          <pre class="code">{inputText(props.call.input)}</pre>
        </Show>
        <Show when={props.result}>
          {(result) => (
            <>
              <div class="tool-label">{result().isError ? "Error" : "Result"}</div>
              <pre class="code result">{result().content}</pre>
              <OutputLink blob={result().blob} context={props.context} />
            </>
          )}
        </Show>
      </div>
    </details>
  );
}

const OutputLink = (props: { blob: string | null; context: ItemContext }) => (
  <Show when={props.blob}>{(blob) => <a class="output-link" href={props.context.blobUrl(blob())} target="_blank" rel="noopener">Full output</a>}</Show>
);

/** Server-side tool traffic (web search and fetch): found links when there are any, else the raw block. */
function ProviderBlock(props: { block: unknown }) {
  const inner = () => (props.block ?? {}) as { name?: unknown; type?: unknown; input?: unknown; content?: unknown };
  const name = () => typeof inner().name === "string" ? inner().name as string : String(inner().type ?? "provider").replace(/_/g, " ");
  const found = () => Array.isArray(inner().content)
    ? (inner().content as { url?: unknown; title?: unknown }[]).filter((each): each is { url: string; title?: string } => typeof each?.url === "string")
    : [];
  const summary = () => inner().input ? toolSummary(inner().input) : found().length > 0 ? `${found().length} results` : "";
  return (
    <details class="tool done provider">
      <summary><span class="tool-dot" aria-hidden="true" /><span class="tool-name">{name()}</span><span class="tool-summary">{summary()}</span></summary>
      <div class="tool-body">
        <Show when={found().length > 0} fallback={<pre class="code">{JSON.stringify(inner().input ?? inner().content ?? inner(), null, 2)}</pre>}>
          <ul class="links">
            <For each={found().slice(0, 20)}>
              {(each) => <li><Show when={SAFE_URL.test(each.url)} fallback={each.url}><a href={each.url} target="_blank" rel="noopener noreferrer">{each.title || each.url}</a></Show></li>}
            </For>
          </ul>
        </Show>
      </div>
    </details>
  );
}

function Prompt(props: { item: Of<"awaiting">; context: ItemContext }) {
  const body = () => props.item.event.body;
  // Answered prompts re-render from the log; a failed answer leaves the card to try again.
  const [answering, setAnswering] = createSignal(false);
  const answer = async (value: Parameters<ItemContext["resolve"]>[1]) => {
    setAnswering(true);
    if (!await props.context.resolve(body().call, value)) setAnswering(false);
  };
  return (
    <Switch>
      <Match when={!props.item.awaiting}><Marker class="resolved" text={resolvedLabel(props.item)} /></Match>
      <Match when={body().kind === "elicitation"}>
        <div class="card prompt" role="group" aria-label="Question from the agent">
          <div class="card-title">Question</div>
          <Markdown text={body().prompt} />
          <form class="answer" onSubmit={(event) => {
            event.preventDefault();
            const text = (event.currentTarget.elements.namedItem("answer") as HTMLTextAreaElement).value.trim();
            if (text !== "") void answer({ answer: text });
          }}>
            <label class="sr-only" for={`answer-${body().call}`}>Your answer</label>
            <textarea id={`answer-${body().call}`} name="answer" rows="2" required placeholder="Your answer" />
            <div class="actions"><button type="submit" class="primary" disabled={answering()}>Send answer</button></div>
          </form>
        </div>
      </Match>
      <Match when={true}>
        <div class="card prompt" role="group" aria-label="Permission request">
          <div class="card-title">Allow <code>{props.item.call?.name || body().prompt}</code>?</div>
          <Show when={body().prompt && body().prompt !== props.item.call?.name}><div class="prompt-text">{body().prompt}</div></Show>
          <Show when={reviewNote(props.item.review)}>{(note) => <div class="hint">{note()}</div>}</Show>
          <Show when={props.item.call}>{(call) => <details class="prompt-input"><summary>Input</summary><pre class="code">{inputText(call().input)}</pre></details>}</Show>
          <div class="actions">
            <button type="button" class="primary" disabled={answering()} onClick={() => void answer({ approve: true })}>Approve</button>
            <button type="button" disabled={answering()} onClick={() => void answer({ approve: true, always: true })}>Always allow</button>
            <button type="button" class="danger" disabled={answering()} onClick={() => void answer({ approve: false })}>Deny</button>
          </div>
        </div>
      </Match>
    </Switch>
  );
}

function Background(props: { item: Of<"background">; context: ItemContext }) {
  const body = () => props.item.event.body;
  const name = () => props.item.call ? `${props.item.call.name} ${toolSummary(props.item.call.input)}` : body().call;
  return (
    <div class="msg assistant">
      <details class={["tool", "background", body().isError ? "error" : "done"]}>
        <summary><span class="tool-dot" aria-hidden="true" /><span class="tool-name">Background result</span><span class="tool-summary">{name()}</span></summary>
        <div class="tool-body"><pre class="code result">{body().content}</pre><OutputLink blob={body().blob} context={props.context} /></div>
      </details>
    </div>
  );
}

/** The completion streaming now: text as Markdown, thinking dimmed, tool inputs as they arrive. */
export function Streaming(props: { blocks: StreamBlock[] }) {
  return (
    <For each={props.blocks} keyed={(block) => block.index}>
      {(block) => (
        <Switch>
          <Match when={block().type === "text"}><Markdown text={block().text} live /></Match>
          <Match when={block().type === "thinking"}>
            <div class="thinking-live">
              <span class="thinking-label">Thinking</span>
              <div class="plain">{block().text.length > 1200 ? `…${block().text.slice(-1200)}` : block().text}</div>
            </div>
          </Match>
          <Match when={true}>
            <div class="tool running live">
              <div class="tool-live-head"><span class="tool-dot" aria-hidden="true" /><span class="tool-name">{block().name ?? "tool"}</span></div>
              <pre class="code">{block().text.slice(-2000)}</pre>
            </div>
          </Match>
        </Switch>
      )}
    </For>
  );
}

export function UnsentMessages(props: { messages: Unsent[] }) {
  return (
    <For each={props.messages}>
      {(each) => (
        <div class="msg user unsent">
          <div class="bubble">
            <div class="plain">{each.text}</div>
            <Show when={each.files}><div class="meta">{each.files} attachment{each.files === 1 ? "" : "s"}</div></Show>
          </div>
          <div class="meta">{each.tag}</div>
        </div>
      )}
    </For>
  );
}
