import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface StoredBlob { body: Uint8Array; contentType: string }

export interface BlobStore {
  /** Store bytes under their content address and return the key `sha256/<64 hex>`. Idempotent. */
  put(body: Uint8Array | string, contentType: string): Promise<string>;
  get(key: string): Promise<StoredBlob | null>;
  /** A time-limited URL a client can GET without credentials, or null when the store cannot provide one. */
  url(key: string, expiresInSeconds: number): Promise<string | null>;
}

const DEFAULT_TYPE = "application/octet-stream";
const EMPTY_HASH = sha256Hex("");
export const MAX_PRESIGN_SECONDS = 604_800;

export function isBlobKey(key: string): boolean {
  return /^sha256\/[0-9a-f]{64}$/.test(key);
}

/** Keys become file paths and object names, so anything but a content address is refused. */
function checkKey(key: string): void {
  if (!isBlobKey(key)) throw new Error(`Not a blob key: ${JSON.stringify(key)}`);
}

function bytesOf(body: Uint8Array | string): Uint8Array<ArrayBuffer> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  // fetch only sends views of unshared memory.
  return body.buffer instanceof ArrayBuffer ? body as Uint8Array<ArrayBuffer> : new Uint8Array(body);
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** `sha256/<hex>` holds the bytes and `sha256/<hex>.json` the content type. */
export class FileBlobStore implements BlobStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async put(body: Uint8Array | string, contentType: string): Promise<string> {
    const bytes = bytesOf(body);
    const key = `sha256/${sha256Hex(bytes)}`;
    const path = join(this.#root, key);
    await mkdir(dirname(path), { recursive: true });
    // The body lands last, so a blob that exists always has its content type.
    await writeAtomically(`${path}.json`, JSON.stringify({ contentType }));
    if (!(await exists(path))) await writeAtomically(path, bytes);
    return key;
  }

  async get(key: string): Promise<StoredBlob | null> {
    checkKey(key);
    const path = join(this.#root, key);
    const body = await readIfExists(path);
    if (!body) return null;
    const meta = await readIfExists(`${path}.json`);
    const contentType = meta ? (JSON.parse(meta.toString("utf8")) as { contentType: string }).contentType : DEFAULT_TYPE;
    return { body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength), contentType };
  }

  async url(key: string, _expiresInSeconds?: number): Promise<string | null> {
    checkKey(key);
    return null;
  }
}

/** Synced before the rename, so a key recorded elsewhere never names a torn file after a crash. */
async function writeAtomically(path: string, data: Uint8Array | string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function readIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export interface S3Options {
  bucket: string;
  prefix?: string;
  region: string;
  /** Base URL of an S3-compatible service (R2, Garage, MinIO), addressed path-style. Without it, AWS virtual-hosted URLs. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class S3BlobStore implements BlobStore {
  readonly #options: S3Options;
  /** Everything before the key, path segments already encoded, ending in `/`. */
  readonly #base: string;

  constructor(options: S3Options) {
    this.#options = options;
    const bucket = options.endpoint
      ? `${options.endpoint.replace(/\/+$/, "")}/${encode(options.bucket)}`
      : `https://${options.bucket}.s3.${options.region}.amazonaws.com`;
    const prefix = options.prefix?.replace(/^\/+|\/+$/g, "");
    this.#base = prefix ? `${bucket}/${encodePath(prefix)}/` : `${bucket}/`;
  }

  async put(body: Uint8Array | string, contentType: string): Promise<string> {
    const bytes = bytesOf(body);
    const hash = sha256Hex(bytes);
    const key = `sha256/${hash}`;
    // The content address doubles as the payload hash, which S3 checks against the body it receives.
    const response = await this.#send("PUT", key, { "content-type": contentType }, hash, bytes);
    if (!response.ok) throw await failure("PUT", key, response);
    await response.body?.cancel();
    return key;
  }

  async get(key: string): Promise<StoredBlob | null> {
    checkKey(key);
    const response = await this.#send("GET", key, {}, EMPTY_HASH);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) throw await failure("GET", key, response);
    return { body: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? DEFAULT_TYPE };
  }

  /** S3 refuses presigned URLs that live longer than seven days, so longer requests get seven days. */
  async url(key: string, expiresInSeconds: number): Promise<string | null> {
    checkKey(key);
    const expires = Math.min(Math.max(Math.ceil(expiresInSeconds), 1), MAX_PRESIGN_SECONDS);
    return presignV4(this.#options, { method: "GET", url: new URL(this.#base + key), expiresInSeconds: expires }, this.#now());
  }

  #send(method: string, key: string, headers: Record<string, string>, payloadHash: string, body?: Uint8Array<ArrayBuffer>): Promise<Response> {
    const url = new URL(this.#base + key);
    const signed = signV4(this.#options, { method, url, headers, payloadHash }, this.#now());
    return (this.#options.fetch ?? fetch)(url, { method, headers: signed, ...(body ? { body } : {}) });
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }
}

async function failure(method: string, key: string, response: Response): Promise<Error> {
  const text = await response.text().catch(() => "");
  return new Error(`S3 ${method} ${key} failed with ${response.status}: ${text.slice(0, 500)}`);
}

/** TRINITY_BLOBS=file:///abs/dir or s3://bucket/optional/prefix. S3 uses AWS_REGION (default us-east-1), AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, and TRINITY_S3_ENDPOINT for R2/Garage/MinIO (path-style addressing when an endpoint is set, virtual-hosted otherwise). */
export function blobStoreFromEnv(env: NodeJS.ProcessEnv = process.env): BlobStore {
  const location = env.TRINITY_BLOBS;
  if (!location) throw new Error("TRINITY_BLOBS is not set");
  const url = new URL(location);
  if (url.protocol === "file:") return new FileBlobStore(fileURLToPath(url));
  if (url.protocol !== "s3:") throw new Error(`TRINITY_BLOBS must be a file: or s3: URL, not ${location}`);
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("S3 blobs need AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
  return new S3BlobStore({
    bucket: url.hostname,
    prefix: decodeURIComponent(url.pathname),
    region: env.AWS_REGION || "us-east-1",
    accessKeyId,
    secretAccessKey,
    ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
    ...(env.TRINITY_S3_ENDPOINT ? { endpoint: env.TRINITY_S3_ENDPOINT } : {}),
  });
}

// AWS Signature Version 4, as S3 specifies it.

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  /** Default "s3". */
  service?: string;
}

export interface SigV4Request {
  method: string;
  url: URL;
  /** Headers to send and sign besides Host, which fetch derives from the URL. */
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body, or UNSIGNED-PAYLOAD. */
  payloadHash: string;
}

/** Sign with the Authorization header. Returns every header to send. */
export function signV4(credentials: SigV4Credentials, request: SigV4Request, date: Date): Record<string, string> {
  const time = amzDate(date);
  const headers: Record<string, string> = {
    ...request.headers,
    "x-amz-content-sha256": request.payloadHash,
    "x-amz-date": time,
    ...(credentials.sessionToken ? { "x-amz-security-token": credentials.sessionToken } : {}),
  };
  const signing = canonicalHeaders({ host: request.url.host, ...headers });
  const canonical = [request.method, canonicalUri(request.url), canonicalQuery([...request.url.searchParams]), signing.canonical, signing.names, request.payloadHash].join("\n");
  const { scope, signature } = sign(credentials, time, canonical);
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope},SignedHeaders=${signing.names},Signature=${signature}`;
  return headers;
}

/** A URL that authenticates through its query string and signs only Host, so any client can GET it. */
export function presignV4(credentials: SigV4Credentials, request: { method: string; url: URL; expiresInSeconds: number }, date: Date): string {
  const { expiresInSeconds: expires } = request;
  if (!Number.isInteger(expires) || expires < 1 || expires > MAX_PRESIGN_SECONDS) throw new RangeError(`Presigned URLs expire after 1 to ${MAX_PRESIGN_SECONDS} seconds, not ${expires}`);
  const time = amzDate(date);
  const query: [string, string][] = [
    ...request.url.searchParams,
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${credentials.accessKeyId}/${scope(credentials, time)}`],
    ["X-Amz-Date", time],
    ["X-Amz-Expires", String(expires)],
    ...(credentials.sessionToken ? [["X-Amz-Security-Token", credentials.sessionToken] as [string, string]] : []),
    ["X-Amz-SignedHeaders", "host"],
  ];
  const uri = canonicalUri(request.url);
  const queryString = canonicalQuery(query);
  const canonical = [request.method, uri, queryString, `host:${request.url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  return `${request.url.origin}${uri}?${queryString}&X-Amz-Signature=${sign(credentials, time, canonical).signature}`;
}

function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]|\.\d{3}/g, "");
}

function scope(credentials: SigV4Credentials, time: string): string {
  return `${time.slice(0, 8)}/${credentials.region}/${credentials.service ?? "s3"}/aws4_request`;
}

function sign(credentials: SigV4Credentials, time: string, canonicalRequest: string): { scope: string; signature: string } {
  const credentialScope = scope(credentials, time);
  const stringToSign = ["AWS4-HMAC-SHA256", time, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  let key: Buffer = Buffer.from(`AWS4${credentials.secretAccessKey}`);
  for (const part of credentialScope.split("/")) key = createHmac("sha256", key).update(part).digest();
  return { scope: credentialScope, signature: createHmac("sha256", key).update(stringToSign).digest("hex") };
}

/** RFC 3986 encoding: everything but unreserved characters, which encodeURIComponent leaves a few of. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePath(path: string): string {
  return path.split("/").map(encode).join("/");
}

/** S3 decodes the path it receives and encodes each segment once, so the signature must too. */
function canonicalUri(url: URL): string {
  return url.pathname.split("/").map((segment) => encode(decodeURIComponent(segment))).join("/");
}

function canonicalQuery(params: [string, string][]): string {
  return params
    .map(([name, value]) => [encode(name), encode(value)] as const)
    .sort(([a, x], [b, y]) => a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function canonicalHeaders(headers: Record<string, string>): { canonical: string; names: string } {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return {
    canonical: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    names: entries.map(([name]) => name).join(";"),
  };
}
