import Anthropic from "@anthropic-ai/sdk";
import type { Json } from "@flower-js/sdk";
import type { Attachment, Block, CompletionMessage, CompletionOutcome, Event } from "../app/model.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentParam = Anthropic.Beta.BetaContentBlockParam;
type Failure = Extract<CompletionOutcome, { ok: false }>["error"];

const INTERRUPTED = "The user interrupted your previous turn.";
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const COMPACTION_PROMPT = `Your context is nearly full. Write a summary that will replace this whole conversation for your next turn, so include everything needed to continue without it:
- the user's requests, preferences and constraints, in their own words where it matters;
- what has been done, with the files, commands, identifiers and results involved;
- decisions made and why, and anything that was tried and failed;
- the current state of the task and the next steps;
- open questions for the user.
Reply with the summary only, as plain text, and do not call any tools.`;

/**
 * Request options a model accepts. Adaptive thinking exists from Opus/Sonnet 4.6 on; server-side
 * refusal fallbacks apply to the models whose safety classifiers can decline a request.
 */
export function modelOptions(model: string): { thinking: boolean; fallbacks: boolean } {
  const adaptive = /^claude-(opus-(4-[6-9]|[5-9])|sonnet-(4-[6-9]|[5-9])|fable|mythos)/.test(model);
  const fallbacks = /^claude-(opus-[5-9]|fable-5|mythos-5)/.test(model);
  return { thinking: adaptive, fallbacks };
}

/** Attachment bytes fetched from blob storage, by blob key. */
export type AttachmentBodies = ReadonlyMap<string, Uint8Array>;

/**
 * Render a session log as Messages API turns. A call's results form one user message,
 * in the order the calls were made, followed by whatever the user said meanwhile.
 */
export function render(events: readonly Event[], attachments: AttachmentBodies = new Map()): MessageParam[] {
  const messages: MessageParam[] = [];
  let calls: string[] = [];
  const results = new Map<string, Anthropic.Beta.BetaToolResultBlockParam>();
  let texts: ContentParam[] = [];
  const flush = () => {
    const content = [...calls.flatMap((id) => results.get(id) ?? []), ...texts];
    if (content.length > 0) messages.push({ role: "user", content });
    calls = [];
    results.clear();
    texts = [];
  };
  for (const { body } of events) {
    switch (body.type) {
      case "user":
        texts.push(...body.attachments.flatMap((attachment) => attachmentContent(attachment, attachments.get(attachment.blob))));
        texts.push({ type: "text", text: body.text });
        break;
      case "interrupted":
        texts.push({ type: "text", text: INTERRUPTED });
        break;
      case "compact":
        texts.push({ type: "text", text: `This session continues an earlier conversation that was summarized to save context. The summary:\n\n${body.summary}` });
        break;
      case "background_result":
        texts.push({ type: "text", text: `<background-result call="${body.call}"${body.isError ? ` error="true"` : ""}>\n${body.content}\n</background-result>` });
        break;
      case "tool_result":
        results.set(body.call, {
          type: "tool_result", tool_use_id: body.call, content: body.content === "" ? "(no output)" : body.content,
          ...(body.isError ? { is_error: true } : {}),
        });
        break;
      case "assistant": {
        const content = body.blocks.flatMap(assistantContent);
        if (content.length === 0) break;
        flush();
        messages.push({ role: "assistant", content });
        calls = body.blocks.flatMap((block) => block.type === "tool_call" ? [block.id] : []);
        break;
      }
    }
  }
  flush();
  return messages;
}

function attachmentContent(attachment: Attachment, body: Uint8Array | undefined): ContentParam[] {
  if (body === undefined) return [{ type: "text", text: `[Attachment ${attachment.name} is no longer available.]` }];
  const data = Buffer.from(body).toString("base64");
  if (IMAGE_TYPES.has(attachment.mediaType)) {
    return [{ type: "image", source: { type: "base64", media_type: attachment.mediaType as "image/png", data } }];
  }
  if (attachment.mediaType === "application/pdf") {
    return [{ type: "document", title: attachment.name, source: { type: "base64", media_type: "application/pdf", data } }];
  }
  if (attachment.mediaType.startsWith("text/") || /json|xml|yaml|javascript|typescript/.test(attachment.mediaType)) {
    return [{ type: "text", text: `<attachment name="${attachment.name}">\n${Buffer.from(body).toString("utf8")}\n</attachment>` }];
  }
  return [{ type: "text", text: `[Attachment ${attachment.name} (${attachment.mediaType}, ${attachment.size} bytes) cannot be shown to the model.]` }];
}

function assistantContent(block: Block): ContentParam[] {
  switch (block.type) {
    case "text": return block.text === "" ? [] : [{ type: "text", text: block.text }];
    case "thinking": return [{ type: "thinking", thinking: block.thinking, signature: block.signature }];
    case "redacted_thinking": return [{ type: "redacted_thinking", data: block.data }];
    case "tool_call": return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
    case "provider": return [block.block as unknown as ContentParam];
  }
}

const SERVER_RESULTS = new Set(["web_search_tool_result", "web_fetch_tool_result", "code_execution_tool_result", "bash_code_execution_tool_result", "text_editor_code_execution_tool_result"]);

/**
 * Keep what the log can replay. After a server-side fallback, the declining model's
 * thinking, tool calls and unanswered server tool calls before the last fallback marker
 * are not part of the response; its text and answered server calls are.
 */
export function normalize(message: Anthropic.Beta.BetaMessage): CompletionMessage {
  const boundary = message.content.findLastIndex((block) => block.type === "fallback");
  const answered = new Set(message.content.flatMap((block) => SERVER_RESULTS.has(block.type) ? [(block as { tool_use_id: string }).tool_use_id] : []));
  const blocks = message.content.flatMap((block, index): Block[] => {
    const declined = index < boundary;
    switch (block.type) {
      case "text": return block.text === "" ? [] : [{ type: "text", text: block.text }];
      case "thinking": return declined ? [] : [{ type: "thinking", thinking: block.thinking, signature: block.signature }];
      case "redacted_thinking": return declined ? [] : [{ type: "redacted_thinking", data: block.data }];
      case "tool_use": return declined ? [] : [{ type: "tool_call", id: block.id, name: block.name, input: block.input as Json }];
      case "server_tool_use":
        return declined && !answered.has(block.id) ? [] : [{ type: "provider", provider: "anthropic", block: block as unknown as Json }];
      default:
        return SERVER_RESULTS.has(block.type) ? [{ type: "provider", provider: "anthropic", block: block as unknown as Json }] : [];
    }
  });
  return {
    blocks,
    model: message.model,
    stopReason: message.stop_reason,
    usage: {
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
      cacheRead: message.usage.cache_read_input_tokens ?? 0,
      cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

/** Whether asking again can succeed, and when. The session decides how many times. */
export function classify(error: unknown): Failure {
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    const retryable = error instanceof Anthropic.APIConnectionError || status === undefined ||
      status === 408 || status === 409 || status === 429 || status >= 500;
    const retryAfterMs = retryAfter(error.headers);
    return { code: code(error), message: error.message, retryable, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }
  // The SDK rejects a streamed tool input it cannot parse at all; asking again usually succeeds.
  return { code: "STREAM_ERROR", message: error instanceof Error ? error.message : String(error), retryable: true };
}

function code(error: InstanceType<typeof Anthropic.APIError>): string {
  if (error instanceof Anthropic.APIConnectionError) return "CONNECTION";
  if (error instanceof Anthropic.RateLimitError) return "RATE_LIMITED";
  if (error instanceof Anthropic.AuthenticationError) return "AUTHENTICATION";
  if (error instanceof Anthropic.PermissionDeniedError) return "PERMISSION_DENIED";
  if (error instanceof Anthropic.BadRequestError) return "INVALID_REQUEST";
  if (error.status === 529) return "OVERLOADED";
  return error.status === undefined ? "PROVIDER_ERROR" : `HTTP_${error.status}`;
}

function retryAfter(headers: Headers | undefined): number | undefined {
  const value = headers?.get("retry-after");
  if (value === null || value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1_000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}
