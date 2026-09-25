import { createHmac, timingSafeEqual } from "node:crypto";
import { DeliveryError, deliver, retryAfter, retryableStatus, splitText } from "./delivery.ts";

const GITHUB_API = "https://api.github.com";
const COMMENT_LIMIT = 65_536;

export function verifyGithubSignature(secret: string, rawBody: string, signatureHeader: string | undefined): boolean {
  if (signatureHeader === undefined) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return safeEqual(expected, signatureHeader);
}

export interface GithubInbound {
  repo: string;
  number: number;
  thread: string;
  messageId: string;
  user: string;
  text: string;
  url: string;
}

/**
 * A message addressed to the bot, or null. `botLogin` may be a GitHub App's `slug[bot]` login:
 * people mention the slug, and the app comments as `slug[bot]`.
 */
export function parseGithubEvent(event: string, body: unknown, botLogin: string): GithubInbound | null {
  const payload = body as Record<string, any> | null;
  const found = source(event, payload);
  if (found === undefined) return null;
  const { item, number, text } = found;
  const repo = payload?.repository?.full_name;
  const user = item?.user?.login;
  const id = item?.id;
  if (typeof repo !== "string" || typeof number !== "number" || typeof user !== "string" || typeof text !== "string") return null;
  if (typeof id !== "number" && typeof id !== "string") return null;
  const name = botLogin.replace(/\[bot\]$/i, "").toLowerCase();
  const author = user.toLowerCase();
  if (author === name || author === `${name}[bot]` || !mentions(text, name)) return null;
  return {
    repo, number, thread: `${repo}#${number}`, messageId: `${event}:${id}`, user,
    text: text.replace(STRIP, (match, login: string) => login.toLowerCase() === name ? "" : match).trim(),
    url: typeof item.html_url === "string" ? item.html_url : "",
  };
}

function source(event: string, payload: Record<string, any> | null): { item: any; number: unknown; text: unknown } | undefined {
  switch (`${event}.${payload?.action}`) {
    case "issue_comment.created": return { item: payload?.comment, number: payload?.issue?.number, text: payload?.comment?.body };
    case "pull_request_review_comment.created": return { item: payload?.comment, number: payload?.pull_request?.number, text: payload?.comment?.body };
    case "issues.opened": {
      const issue = payload?.issue;
      return { item: issue, number: issue?.number, text: issue?.body ? `${issue.title}\n\n${issue.body}` : issue?.title };
    }
    default: return undefined;
  }
}

// Logins are letters, digits and hyphens; a preceding word character makes an email address, not a mention.
const MENTION = /(?<![\w/-])@([A-Za-z0-9-]+)(?:\[bot\])?(?![\w-])/g;
const STRIP = new RegExp(`${MENTION.source}[ \\t]*`, "g");

/** GitHub does not notify for mentions in code or quoted replies, so neither do we. */
function mentions(text: string, name: string): boolean {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/`[^`\n]*`/g, "").replace(/^ {0,3}>.*$/gm, "");
  return [...prose.matchAll(MENTION)].some((match) => match[1]!.toLowerCase() === name);
}

/**
 * Comment on an issue or pull request, in several comments when the body exceeds GitHub's limit.
 * Returns the first comment. The pieces are posted one by one, so a retry after a partial failure repeats earlier ones.
 */
export async function postGithubComment(
  options: { token: string; repo: string; number: number; body: string; apiUrl?: string; signal?: AbortSignal },
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: number; url: string }> {
  const base = (options.apiUrl ?? GITHUB_API).replace(/\/+$/, "");
  const repo = options.repo.split("/").map(encodeURIComponent).join("/");
  const url = `${base}/repos/${repo}/issues/${options.number}/comments`;
  let first: { id: number; url: string } | undefined;
  for (const piece of splitText(options.body, COMMENT_LIMIT)) {
    const { response, body } = await deliver(fetchImpl, url, {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${options.token}`,
        "Content-Type": "application/json",
        "User-Agent": "trinity",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ body: piece }),
      signal: options.signal,
    });
    if (!response.ok) throw githubFailure(response, body);
    const comment = body as Record<string, any> | undefined;
    if (typeof comment?.id !== "number" || typeof comment.html_url !== "string") {
      throw new DeliveryError(`GitHub accepted a comment on ${options.repo}#${options.number} but returned no id.`, { retryable: false });
    }
    first ??= { id: comment.id, url: comment.html_url };
  }
  return first!;
}

/** Rate limits also come as 403: primary ones exhaust x-ratelimit-remaining, secondary ones set Retry-After. */
function githubFailure(response: Response, body: unknown): DeliveryError {
  const headers = response.headers;
  const exhausted = headers.get("x-ratelimit-remaining") === "0";
  const retryable = retryableStatus(response.status) || (response.status === 403 && (exhausted || headers.has("retry-after")));
  const reset = Number(headers.get("x-ratelimit-reset"));
  const detail = (body as Record<string, any> | undefined)?.message;
  const message = `GitHub responded ${response.status}: ${typeof detail === "string" ? detail : response.statusText}`;
  if (!retryable) return new DeliveryError(message, { retryable });
  const retryAfterMs = retryAfter(headers) ?? (exhausted && reset > 0 ? Math.max(0, reset * 1_000 - Date.now()) : undefined);
  return new DeliveryError(message, { retryable, retryAfterMs });
}

function safeEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

