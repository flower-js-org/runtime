import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TOKEN_AUDIENCE as AUDIENCE, TOKEN_ISSUER as ISSUER } from "../app/access.ts";
import type { Role } from "../app/model.ts";

export { AUDIENCE, ISSUER };

export interface TokenClaims {
  sub: string;
  role: Role;
  /** The organization a user or computer token acts in. */
  org?: string;
  computer?: string;
  /** For named Flower partitions, which admit only principals whose tenant is the partition. */
  tenant?: string;
  name?: string;
}

const base64url = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");

/** Read an Ed25519 private key (PKCS#8 PEM), creating one when `create` is set and the file is missing. */
export async function loadSigningKey(path: string, create = false): Promise<KeyObject> {
  try {
    return createPrivateKey(await readFile(path, "utf8"));
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const { privateKey } = generateKeyPairSync("ed25519");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    await chmod(path, 0o600);
    return privateKey;
  }
}

export function publicKeyPem(privateKey: KeyObject): string {
  return createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
}

export function signToken(privateKey: KeyObject, claims: TokenClaims, ttlSeconds: number, now = Date.now()): string {
  const iat = Math.floor(now / 1_000);
  const header = base64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, iat, exp: iat + ttlSeconds, ...claims }));
  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

/** The claims of a valid token from this issuer, or null. */
export function verifyToken(publicKey: KeyObject, token: string, now = Date.now()): (TokenClaims & { exp: number }) | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  try {
    if (JSON.parse(Buffer.from(header, "base64url").toString()).alg !== "EdDSA") return null;
    if (!verify(null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (claims.iss !== ISSUER || claims.aud !== AUDIENCE || typeof claims.sub !== "string" || typeof claims.exp !== "number") return null;
    if (claims.exp * 1_000 <= now) return null;
    return claims;
  } catch {
    return null;
  }
}

export function bearer(header: string | undefined): string | null {
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}
