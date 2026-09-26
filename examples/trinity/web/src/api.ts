// The signed-in identity, the Flower client that acts as it, and the gateway's own endpoints.
import { FlowerClient, FlowerError, type Update } from "@flower-js/sdk/client";
import { createSignal } from "solid-js";
import type app from "../../app/index.ts";
import type { Attachment } from "../../app/model.ts";
import { parseSegment } from "./log.ts";

export type Client = FlowerClient<typeof app>;
export { FlowerError };

export interface Claims { sub: string; role: string; org?: string; tenant?: string; name?: string; exp?: number }
export interface Auth { token: string; claims: Claims; expiresAt: number; client: Client }

const STORAGE_KEY = "trinity.auth";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The claims of a JWT, read without verifying: the gateway and Flower verify it. */
export function decodeClaims(token: string): Claims | null {
  try {
    const part = token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(part.padEnd(part.length + (4 - part.length % 4) % 4, "=")), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Claims;
  } catch {
    return null;
  }
}

function stored(): string | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as { token?: unknown } | null;
    return typeof value?.token === "string" ? value.token : null;
  } catch {
    return null;
  }
}

/** A token for a tenant organization talks to that tenant's partition. */
function adopt(token: string | null): Auth | null {
  const claims = token === null ? null : decodeClaims(token);
  if (token === null || claims === null) return null;
  const base: Client = new FlowerClient<typeof app>(location.origin, { credentials: { token } });
  return { token, claims, expiresAt: typeof claims.exp === "number" ? claims.exp * 1000 : Infinity, client: claims.tenant ? base.partition(claims.tenant) : base };
}

// The signal drives the views; `current` answers imperative code at once, before the next flush.
let current = adopt(stored());
const [authSignal, setAuthSignal] = createSignal<Auth | null>(current);
export const auth = authSignal;
export const currentAuth = () => current;

/** The Flower client acting as the signed-in user; views exist only while someone is signed in. */
export function client(): Client {
  if (current === null) throw new Error("Not signed in");
  return current.client;
}

export function setToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify({ token }));
  } catch {
    // Storage can be unavailable (private windows); the token then lasts for this page only.
  }
  current = adopt(token);
  setAuthSignal(current);
}

/** The last user name signed in with, to prefill the sign-in form. */
export function lastSubject(): string {
  try {
    return localStorage.getItem("trinity.subject") ?? "";
  } catch {
    return "";
  }
}

async function gateway<T>(path: string, { body, headers = {}, token = current?.token }: { body?: BodyInit; headers?: Record<string, string>; token?: string | null } = {}): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: fall back to the status text below.
  }
  if (!response.ok) throw new HttpError(response.status, (data as { error?: string } | null)?.error ?? (text || response.statusText));
  return data as T;
}

const json = (value: unknown) => ({ body: JSON.stringify(value), headers: { "content-type": "application/json" } });

export async function devLogin(subject: string, name: string): Promise<void> {
  const issued = await gateway<{ token: string }>("/auth/dev", { ...json({ subject, ...(name ? { name } : {}) }), token: null });
  try {
    localStorage.setItem("trinity.subject", subject);
  } catch {
    // Only a convenience.
  }
  setToken(issued.token);
}

export async function switchOrg(org: string): Promise<void> {
  setToken((await gateway<{ token: string }>("/auth/switch", json({ org }))).token);
}

/** Link the Slack account named by the Slack worker's grant to the signed-in member. */
export function linkSlack(grant: string): Promise<{ workspace: string }> {
  return gateway("/slack/link", json({ grant }));
}

/** Slack's OAuth page for installing the app into a workspace, when the gateway can offer it. */
export async function slackInstallUrl(): Promise<string> {
  return (await gateway<{ url: string }>("/slack/install", json({}))).url;
}

/** Store a file in blob storage; the result is an Attachment for session.send. */
export function upload(file: File): Promise<Attachment> {
  return gateway(`/uploads?name=${encodeURIComponent(file.name || "attachment")}`, { body: file, headers: { "content-type": file.type || "application/octet-stream" } });
}

/** Blob keys are "sha256/<hex>"; the slash is part of the route. Images and links cannot send headers, hence the token parameter. */
export function blobUrl(session: string, key: string): string {
  return `/blobs/${encodeURIComponent(session)}/${key}?token=${encodeURIComponent(current?.token ?? "")}`;
}

export async function fetchSegment(session: string, key: string) {
  const response = await fetch(blobUrl(session, key));
  if (!response.ok) throw new HttpError(response.status, response.status === 404 ? "Earlier messages are unavailable" : response.statusText);
  return parseSegment(await response.text());
}

export function describe(error: unknown): string {
  if (error instanceof FlowerError) return error.failure?.message ?? error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isAuthError(error: unknown): boolean {
  if (error instanceof FlowerError) return error.failure?.code === "UNAUTHENTICATED" || error.status === 401;
  return error instanceof HttpError && error.status === 401;
}

export const isForbidden = (error: unknown) => error instanceof FlowerError && error.failure?.code === "FORBIDDEN";

/**
 * A live query's values, for a memo to follow. Hand-written rather than an async generator, whose
 * return() would wait for the pending next() and hold the connection open until the next update.
 */
export function values<T>(updates: AsyncGenerator<Update<T>>, onError?: (error: unknown) => void): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<T>> {
        try {
          const result = await updates.next();
          return result.done ? { done: true, value: undefined } : { done: false, value: result.value.value };
        } catch (error) {
          onError?.(error);
          throw error;
        }
      },
      async return(): Promise<IteratorResult<T>> {
        await updates.return(undefined);
        return { done: true, value: undefined };
      },
    }),
  };
}
