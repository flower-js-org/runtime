import { canonicalJson } from "./json.ts";
import type { Json } from "./index.ts";
import { isManaged, isSharedKey, sharedKey } from "./keys.ts";
import type { ManagedKey, ManagedKeyVersion, SharedKey } from "./keys.ts";
export { key } from "./keys.ts";
export type { ManagedKey, ManagedKeyAlgorithm, KeyUsage, KeyOptions, ManagedKeyVersion, SharedKey } from "./keys.ts";

type NativeInput = Uint8Array | string;
type NativeResult = Uint8Array | string | boolean | null | SharedKey;
type NativeCrypto = (operation: number, parameter: number, ...inputs: (NativeInput | SharedKey)[]) => NativeResult;

function native(operation: number, parameter: number, ...inputs: (NativeInput | SharedKey)[]): NativeResult {
  const bridge = (globalThis as typeof globalThis & { __flowerCrypto?: NativeCrypto }).__flowerCrypto;
  if (typeof bridge !== "function") {
    throw new Error("Flower native cryptography is available only inside a Flower method");
  }
  return bridge(operation, parameter, ...inputs);
}

function array(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError("NaCl inputs must be Uint8Array values");
}

function binary(operation: number, ...inputs: Uint8Array[]): Uint8Array {
  inputs.forEach(array);
  return native(operation, 0, ...inputs) as Uint8Array;
}

function opened(operation: number, ...inputs: Uint8Array[]): Uint8Array | null {
  inputs.forEach(array);
  return native(operation, 0, ...inputs) as Uint8Array | null;
}

function checked(operation: number, ...inputs: Uint8Array[]): boolean {
  inputs.forEach(array);
  return native(operation, 0, ...inputs) as boolean;
}

const empty = new Uint8Array();
function managed(operation: string, key: ManagedKey | ManagedKeyVersion | SharedKey, options: unknown = {}, a: NativeInput = empty, b: NativeInput = empty, c: NativeInput = empty): NativeResult {
  canonicalJson(options);
  if (operation.startsWith("jwt.") && options !== null && typeof options === "object" &&
      (Object.hasOwn(options, "kid") || Object.hasOwn(options, "keyFormat"))) {
    throw new TypeError("Managed JWT keyFormat and version kid are determined by the binding");
  }
  if (isSharedKey(key)) {
    if (!["nacl.secretbox", "nacl.secretbox.open", "nacl.box.after", "nacl.box.open.after"].includes(operation)) {
      throw new TypeError("Shared keys support authenticated encryption/decryption only");
    }
    return native(operation.endsWith(".open") || operation === "nacl.box.open.after" ? 202 : 201, 0, key, a, b);
  }
  const descriptor = key.kind === "keyVersion" ? key.key : key;
  const version = key.kind === "keyVersion" ? { version: key.version } : {};
  return native(200, 0, canonicalJson({ operation, key: descriptor, options, ...version }), a, b, c);
}

/** Export only the public component, subject to the binding's publicKey usage. */
export function publicKey(key: ManagedKey | ManagedKeyVersion): Uint8Array {
  if (!isManaged(key) || !["key", "keyVersion"].includes(key.kind)) throw new TypeError("publicKey requires a managed key declaration");
  return managed("key.publicKey", key) as Uint8Array;
}

/** Pin the current version, or reconstruct a saved public version selector.
 * Store version alongside NaCl ciphertext/signatures. Historical versions allow
 * verification/decryption/public export, never signing/encryption/derivation. */
export function keyVersion(key: ManagedKey, version?: string): ManagedKeyVersion {
  if (!isManaged(key) || key.kind !== "key") throw new TypeError("keyVersion requires a managed key declaration");
  const selected = version === undefined ? managed("key.version", key) : version;
  if (typeof selected !== "string" || !/^flower\.[A-Za-z0-9_-]+\.[1-9][0-9]*$/.test(selected)) {
    throw new TypeError("Invalid managed key version");
  }
  return Object.freeze({ kind: "keyVersion", key, version: selected });
}

type SecretBoxKey = Uint8Array | ManagedKey | ManagedKeyVersion | SharedKey;
type SigningKey = Uint8Array | ManagedKey | ManagedKeyVersion;

function secretboxCall(operation: string, raw: number, message: Uint8Array, nonce: Uint8Array, key: SecretBoxKey): Uint8Array | null {
  array(message); array(nonce);
  return isManaged(key) ? managed(operation, key, {}, message, nonce) as Uint8Array | null : opened(raw, message, nonce, key);
}

function signingCall(operation: string, raw: number, message: Uint8Array, key: SigningKey): Uint8Array | null {
  array(message);
  return isManaged(key) ? managed(operation, key, {}, message) as Uint8Array | null : opened(raw, message, key);
}

function boxCall(operation: string, raw: number, message: Uint8Array, nonce: Uint8Array, peer: Uint8Array, key: SigningKey): Uint8Array | null {
  array(message); array(nonce); array(peer);
  return isManaged(key) ? managed(operation, key, {}, message, nonce, peer) as Uint8Array | null : opened(raw, message, nonce, peer, key);
}

function boxBefore(peer: Uint8Array, key: Uint8Array): Uint8Array;
function boxBefore(peer: Uint8Array, key: ManagedKey | ManagedKeyVersion): SharedKey;
function boxBefore(peer: Uint8Array, key: SigningKey): Uint8Array | SharedKey {
  array(peer);
  return isManaged(key) ? sharedKey(managed("nacl.box.before", key, {}, peer)) : binary(5, peer, key);
}

export interface NaClKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** Fill exactly length bytes. A custom source owns its entropy and nonce safety. */
export type NaClPRNG = (output: Uint8Array, length: number) => void;
let customRandom: NaClPRNG | null = null;

function randomSize(length: number): void {
  // This is the binary bridge's uint32 length, not an application resource cap.
  if (!Number.isInteger(length) || length < 0 || length > 0xffff_ffff) {
    throw new TypeError("Random byte length must be a nonnegative uint32 integer");
  }
}

function nativeRandom(length: number): Uint8Array {
  randomSize(length);
  return native(0, length) as Uint8Array;
}

function randomBytes(length: number): Uint8Array {
  randomSize(length);
  if (customRandom === null) return nativeRandom(length);
  const output = new Uint8Array(length);
  try {
    customRandom(output, length);
    return output;
  } catch (error) {
    output.fill(0);
    throw error;
  }
}

function keyPair(operation: number, secret: Uint8Array): NaClKeyPair {
  const packed = binary(operation, secret);
  try {
    // Separate buffers keep a public key's .buffer from exposing secret bytes.
    return { publicKey: packed.slice(0, 32), secretKey: packed.slice(32) };
  } finally {
    packed.fill(0);
  }
}

function randomKeyPair(operation: number): NaClKeyPair {
  const seed = randomBytes(32);
  try {
    return keyPair(operation, seed);
  } finally {
    seed.fill(0);
  }
}

const secretbox = Object.freeze(Object.assign(
  (message: Uint8Array, nonce: Uint8Array, key: SecretBoxKey): Uint8Array => secretboxCall("nacl.secretbox", 1, message, nonce, key) as Uint8Array,
  {
    open: (box: Uint8Array, nonce: Uint8Array, key: SecretBoxKey): Uint8Array | null => secretboxCall("nacl.secretbox.open", 2, box, nonce, key),
    keyLength: 32 as const, nonceLength: 24 as const, overheadLength: 16 as const,
  },
));

const scalarMult = Object.freeze(Object.assign(
  (secret: Uint8Array, publicKey: Uint8Array): Uint8Array => binary(3, secret, publicKey),
  {
    base: (secret: SigningKey): Uint8Array => isManaged(secret) ? managed("nacl.scalarMult.base", secret) as Uint8Array : binary(4, secret),
    scalarLength: 32 as const, groupElementLength: 32 as const,
  },
));

const boxOpen = Object.freeze(Object.assign(
  (box: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: SigningKey): Uint8Array | null =>
    boxCall("nacl.box.open", 7, box, nonce, publicKey, secretKey),
  { after: secretbox.open },
));

const boxKeyPair = Object.freeze(Object.assign(
  (): NaClKeyPair => randomKeyPair(14),
  { fromSecretKey: (secret: Uint8Array): NaClKeyPair => keyPair(14, secret) },
));

const box = Object.freeze(Object.assign(
  (message: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: SigningKey): Uint8Array =>
    boxCall("nacl.box", 6, message, nonce, publicKey, secretKey) as Uint8Array,
  {
    before: boxBefore,
    after: secretbox, open: boxOpen, keyPair: boxKeyPair,
    publicKeyLength: 32 as const, secretKeyLength: 32 as const, sharedKeyLength: 32 as const,
    nonceLength: 24 as const, overheadLength: 16 as const,
  },
));

const detached = Object.freeze(Object.assign(
  (message: Uint8Array, secretKey: SigningKey): Uint8Array => signingCall("nacl.sign.detached", 10, message, secretKey) as Uint8Array,
  {
    verify: (message: Uint8Array, signature: Uint8Array, publicKey: SigningKey): boolean => {
      array(message); array(signature);
      return isManaged(publicKey) ? managed("nacl.sign.detached.verify", publicKey, {}, message, signature) as boolean : checked(11, message, signature, publicKey);
    },
  },
));

const signKeyPair = Object.freeze(Object.assign(
  (): NaClKeyPair => randomKeyPair(12),
  {
    fromSeed: (seed: Uint8Array): NaClKeyPair => keyPair(12, seed),
    fromSecretKey: (secret: Uint8Array): NaClKeyPair => keyPair(13, secret),
  },
));

const sign = Object.freeze(Object.assign(
  (message: Uint8Array, secretKey: SigningKey): Uint8Array => signingCall("nacl.sign", 8, message, secretKey) as Uint8Array,
  {
    open: (signedMessage: Uint8Array, publicKey: SigningKey): Uint8Array | null => signingCall("nacl.sign.open", 9, signedMessage, publicKey),
    detached, keyPair: signKeyPair,
    publicKeyLength: 32 as const, secretKeyLength: 64 as const, seedLength: 32 as const,
    signatureLength: 64 as const,
  },
));

/**
 * TweetNaCl's high-level API backed by native Rust primitives. Binary views go
 * directly through the Wasm bridge. Strict Ed25519 verification rejects legacy
 * malleable signatures; signing keys must contain the public key matching their
 * seed. X25519 preserves NaCl's all-zero result for low-order input points.
 *
 * OS randomness is available only in mutation callbacks. Explicit seeds,
 * nonces, and other deterministic operations also work in queries. setPRNG
 * installs a guest-local override; its caller owns cryptographic safety and
 * determinism. Pass null to restore the native source. JWT nonce generation
 * always uses the native source and is unaffected by this override.
 */
export const nacl = Object.freeze({
  secretbox, scalarMult, box, sign, randomBytes,
  hash: Object.freeze(Object.assign((message: Uint8Array): Uint8Array => binary(15, message), { hashLength: 64 as const })),
  verify: (a: Uint8Array, b: Uint8Array): boolean => checked(16, a, b),
  setPRNG(source: NaClPRNG | null): void {
    if (source !== null && typeof source !== "function") throw new TypeError("PRNG must be a function or null");
    customRandom = source;
  },
});

export type JWTAlgorithm = "HS256" | "RS256" | "ES256" | "EdDSA";
/** Raw HMAC/AES bytes, PEM/explicit DER, or a declared native managed handle. */
export type JWTKey = Uint8Array | string | ManagedKey | ManagedKeyVersion;
export type JWTKeyFormat = "raw" | "pem" | "der";
/** NumericDate claims (exp, nbf, iat) are seconds, not milliseconds. */
export type JWTClaims = Readonly<Record<string, Json>>;

export interface JWTSignOptions {
  algorithm: JWTAlgorithm;
  /** Defaults to pem for strings and raw for bytes. DER must be explicit. */
  keyFormat?: JWTKeyFormat;
  kid?: string;
  typ?: string;
}

export interface ManagedJWTSignOptions {
  /** Optional consistency check; the trusted binding determines the algorithm. */
  algorithm?: JWTAlgorithm;
  typ?: string;
}

export interface ManagedJWTVerifyOptions extends JWTValidationOptions {
  /** Optional additional restriction; the bound key's algorithm remains authoritative. */
  algorithms?: readonly JWTAlgorithm[];
}

export interface JWTValidationOptions {
  issuer?: string;
  /** Required whenever the token contains aud; any listed audience may match. */
  audience?: readonly string[];
  subject?: string;
  /** Nonnegative seconds; defaults to zero. Time comes from the invocation. */
  clockToleranceSeconds?: number;
  /** Defaults to true. Present exp/nbf claims are always checked. */
  requireExpiration?: boolean;
  typ?: string;
}

export interface JWTVerifyOptions extends JWTValidationOptions {
  /** Required, nonempty allowlist; never chosen from an untrusted token alone. */
  algorithms: readonly JWTAlgorithm[];
  keyFormat?: JWTKeyFormat;
}

export interface JWTEncryptOptions {
  /** A unique 12-byte nonce for this key. Omit for mutation-only OS randomness. */
  nonce?: Uint8Array;
  /** Raw keys only; managed JWTs carry the authenticated immutable version. */
  kid?: string;
  typ?: string;
}

export interface JWTProtectedHeader {
  alg: JWTAlgorithm | "dir";
  enc?: "A256GCM";
  kid?: string;
  typ?: string;
}

export interface JWTVerified<Claims extends object = JWTClaims> {
  /** Standard claims are validated; a type parameter does not validate custom claims. */
  claims: Claims;
  protectedHeader: JWTProtectedHeader;
}

function objectJson(value: unknown, label: string): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain JSON object`);
  }
  return canonicalJson(value);
}

function keyOptions(key: Uint8Array | string, options: JWTSignOptions | JWTVerifyOptions): string {
  objectJson(options, "JWT options");
  const format = options.keyFormat ?? (typeof key === "string" ? "pem" : "raw");
  if (typeof key === "string" ? format !== "pem" : !(key instanceof Uint8Array) || format === "pem") {
    throw new TypeError("JWT keys require a PEM string or raw/DER Uint8Array bytes");
  }
  return canonicalJson({ ...options, keyFormat: format });
}

function tokenString(token: string): void {
  if (typeof token !== "string") throw new TypeError("JWT token must be a string");
}

/** Compact JWS and dir/A256GCM JWE. Verification uses Flower invocation time. */
function jwtSign(claims: JWTClaims, key: ManagedKey | ManagedKeyVersion, options?: ManagedJWTSignOptions): string;
function jwtSign(claims: JWTClaims, key: Uint8Array | string, options: JWTSignOptions): string;
function jwtSign(claims: JWTClaims, key: JWTKey, options: JWTSignOptions | ManagedJWTSignOptions = {}): string {
  const claimsJson = objectJson(claims, "JWT claims");
  if (isManaged(key)) return managed("jwt.sign", key, options, claimsJson) as string;
  return native(100, 0, claimsJson, key, keyOptions(key, options as JWTSignOptions)) as string;
}

function jwtVerify<Claims extends object = JWTClaims>(token: string, key: ManagedKey | ManagedKeyVersion, options?: ManagedJWTVerifyOptions): JWTVerified<Claims>;
function jwtVerify<Claims extends object = JWTClaims>(token: string, key: Uint8Array | string, options: JWTVerifyOptions): JWTVerified<Claims>;
function jwtVerify<Claims extends object = JWTClaims>(token: string, key: JWTKey, options: JWTVerifyOptions | ManagedJWTVerifyOptions = {}): JWTVerified<Claims> {
    tokenString(token);
    if (isManaged(key)) return JSON.parse(managed("jwt.verify", key, options, token) as string) as JWTVerified<Claims>;
    return JSON.parse(native(101, 0, token, key, keyOptions(key, options as JWTVerifyOptions)) as string) as JWTVerified<Claims>;
}

export const jwt = Object.freeze({
  sign: jwtSign,
  verify: jwtVerify,
  encrypt(claims: JWTClaims, key: Uint8Array | ManagedKey | ManagedKeyVersion, options: JWTEncryptOptions = {}): string {
    const handle = isManaged(key);
    if (!handle) array(key);
    // Validate descriptors before reading nonce, without serializing its bytes.
    if (options === null || typeof options !== "object" || Array.isArray(options) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
      throw new TypeError("JWT encryption options must be a plain object");
    }
    const fields: Record<string, unknown> = Object.create(null);
    let nonce: Uint8Array | undefined;
    for (const name of Reflect.ownKeys(options)) {
      const descriptor = Object.getOwnPropertyDescriptor(options, name)!;
      if (typeof name !== "string" || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("JWT options cannot contain symbols, hidden properties, or accessors");
      }
      if (name === "nonce") nonce = descriptor.value;
      else fields[name] = descriptor.value;
    }
    if (nonce !== undefined) {
      array(nonce);
      if (nonce.length !== 12) throw new TypeError("JWT encryption nonce must contain 12 bytes");
    }
    if (!handle && key.length !== 32) throw new TypeError("JWT encryption key must contain 32 bytes");
    const claimsJson = objectJson(claims, "JWT claims");
    const optionsJson = canonicalJson(fields);
    const chosen = nonce ?? nativeRandom(12);
    try {
      if (handle) return managed("jwt.encrypt", key, fields, claimsJson, chosen) as string;
      return native(102, 0, claimsJson, key, chosen, optionsJson) as string;
    } finally {
      if (nonce === undefined) chosen.fill(0);
    }
  },
  decrypt<Claims extends object = JWTClaims>(token: string, key: Uint8Array | ManagedKey | ManagedKeyVersion, options: JWTValidationOptions = {}): JWTVerified<Claims> {
    tokenString(token);
    if (isManaged(key)) return JSON.parse(managed("jwt.decrypt", key, options, token) as string) as JWTVerified<Claims>;
    array(key);
    return JSON.parse(native(103, 0, token, key, objectJson(options, "JWT options")) as string) as JWTVerified<Claims>;
  },
});
