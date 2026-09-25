// The signed-in identity, the Flower client that acts as it, and the gateway's own endpoints.
import { FlowerClient, FlowerError } from "/sdk/client.js";
import { parseSegment } from "./render.js";

const STORAGE_KEY = "trinity.auth";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The claims of a JWT, read without verifying: the gateway and Flower verify it. */
export function decodeClaims(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(part.padEnd(part.length + (4 - part.length % 4) % 4, "=")), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function read() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return stored && typeof stored.token === "string" ? stored : null;
  } catch {
    return null;
  }
}

let auth = null;
/** Rebuilt whenever the token changes: a token for a tenant organization talks to that tenant's partition. */
export let client = null;

function adopt(value) {
  const claims = value === null ? null : decodeClaims(value.token);
  auth = claims === null ? null : { token: value.token, claims, expiresAt: typeof claims.exp === "number" ? claims.exp * 1000 : value.expiresAt ?? Infinity };
  if (auth === null) {
    client = null;
    return;
  }
  const base = new FlowerClient(location.origin, { credentials: () => (auth ? { token: auth.token } : undefined) });
  client = auth.claims.tenant ? base.partition(auth.claims.tenant) : base;
}

adopt(read());

export const currentAuth = () => auth;

export function setToken(token) {
  try {
    if (token === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify({ token }));
  } catch {
    // Storage can be unavailable (private windows); the token then lasts for this page only.
  }
  adopt(token === null ? null : { token });
}

/** The last user name signed in with, to prefill the sign-in form. */
export function lastSubject() {
  try {
    return localStorage.getItem("trinity.subject") ?? "";
  } catch {
    return "";
  }
}

async function gateway(path, { body, headers = {}, token = auth?.token } = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: fall back to the status text below.
  }
  if (!response.ok) throw new HttpError(response.status, data?.error ?? (text || response.statusText));
  return data;
}

const json = (value) => ({ body: JSON.stringify(value), headers: { "content-type": "application/json" } });

export async function devLogin(subject, name) {
  const issued = await gateway("/auth/dev", { ...json({ subject, ...(name ? { name } : {}) }), token: null });
  try {
    localStorage.setItem("trinity.subject", subject);
  } catch {
    // Only a convenience.
  }
  setToken(issued.token);
}

export async function switchOrg(org) {
  const issued = await gateway("/auth/switch", json({ org }));
  setToken(issued.token);
}

/** Link the Slack account named by the Slack worker's grant to the signed-in member. */
export function linkSlack(grant) {
  return gateway("/slack/link", json({ grant }));
}

/** Slack's OAuth page for installing the app into a workspace, when the gateway can offer it. */
export async function slackInstallUrl() {
  return (await gateway("/slack/install", json({}))).url;
}

/** Store a file in blob storage; the result is an Attachment for session.send. */
export function upload(file) {
  return gateway(`/uploads?name=${encodeURIComponent(file.name || "attachment")}`, { body: file, headers: { "content-type": file.type || "application/octet-stream" } });
}

/** Blob keys are "sha256/<hex>"; the slash is part of the route. Images and links cannot send headers, hence the token parameter. */
export function blobUrl(session, key) {
  return `/blobs/${encodeURIComponent(session)}/${key}?token=${encodeURIComponent(auth?.token ?? "")}`;
}

export async function fetchSegment(session, key) {
  const response = await fetch(blobUrl(session, key));
  if (!response.ok) throw new HttpError(response.status, response.status === 404 ? "Earlier messages are unavailable" : response.statusText);
  return parseSegment(await response.text());
}

export function describe(error) {
  if (error instanceof FlowerError) return error.failure?.message ?? error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isAuthError(error) {
  if (error instanceof FlowerError) return error.failure?.code === "UNAUTHENTICATED" || error.status === 401;
  return error instanceof HttpError && error.status === 401;
}

export { FlowerError };
