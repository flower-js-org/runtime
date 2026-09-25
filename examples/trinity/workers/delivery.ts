// Delivering to other services over HTTP: failures say whether and when to retry.

/** A failed delivery. Retry a retryable one, no sooner than `retryAfterMs` when it is set. */
export class DeliveryError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: { retryable: boolean; retryAfterMs?: number | undefined; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DeliveryError";
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Send a request and read its body, parsed when it is JSON. A network failure, including one
 * while reading the body, is retryable; an abort belongs to the caller and propagates as is.
 */
export async function deliver(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<{ response: Response; body: unknown }> {
  try {
    const response = await fetchImpl(url, init);
    const text = await response.text();
    return { response, body: parseJson(text) };
  } catch (error) {
    if (init.signal?.aborted) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new DeliveryError(`${init.method ?? "GET"} ${url}: ${reason}`, { retryable: true, cause: error });
  }
}

/** A failed response as an error. 408, 429 and 5xx are retryable unless `retryable` says otherwise. */
export function failure(response: Response, message: string, retryable = retryableStatus(response.status)): DeliveryError {
  const retryAfterMs = retryable ? retryAfter(response.headers) : undefined;
  return new DeliveryError(message, { retryable, retryAfterMs });
}

/** Split text into pieces of at most `limit` UTF-16 units, at a line break or else a space when one is near the end. */
export function splitText(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut >= limit / 2) {
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut + 1);
      continue;
    }
    cut = isHighSurrogate(rest.charCodeAt(limit - 1)) ? limit - 1 : limit;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

export function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function retryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  if (value.trim() !== "" && Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1_000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
