import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual, type KeyObject } from "node:crypto";

// Keys derived from the deployment's signing key, which only the gateway and workers hold:
// sealed values (Slack bot tokens) can live in Flower without Flower being able to use
// them, and grants (a link from Slack to the web) prove the worker issued them.

export type Purpose = "slack-tokens" | "grants";

export function deriveKey(signingKey: KeyObject, purpose: Purpose): Buffer {
  const material = signingKey.export({ format: "der", type: "pkcs8" });
  return Buffer.from(hkdfSync("sha256", material, "trinity", purpose, 32));
}

/** AES-256-GCM, as `v1.<iv>.<ciphertext>.<tag>` in base64url. */
export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv, data, cipher.getAuthTag()].map((part) => typeof part === "string" ? part : part.toString("base64url")).join(".");
}

export function unseal(key: Buffer, sealed: string): string {
  const [version, iv, data, tag] = sealed.split(".");
  if (version !== "v1" || iv === undefined || data === undefined || tag === undefined) throw new Error("Not a sealed value");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** A short-lived signed statement, as `<payload>.<signature>` in base64url. */
export function signGrant(key: Buffer, claims: Record<string, string>, ttlSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1_000) + ttlSeconds })).toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

/** The grant's claims, or null when it is forged or expired. */
export function verifyGrant(key: Buffer, grant: string): Record<string, string> | null {
  const [payload, signature] = grant.split(".");
  if (payload === undefined || signature === undefined) return null;
  const expected = createHmac("sha256", key).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, string> & { exp: number };
  if (claims.exp < Date.now() / 1_000) return null;
  const { exp: _, ...rest } = claims;
  return rest;
}
