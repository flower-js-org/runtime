import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { nacl, jwt } from "./crypto.ts";
import { nacl as rootNaCl, jwt as rootJWT } from "./index.ts";

type Input = Uint8Array | string;
type Result = Uint8Array | string | boolean | null;
function bridge(t: TestContext, callback: (operation: number, parameter: number, ...inputs: Input[]) => Result): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "__flowerCrypto");
  Object.defineProperty(globalThis, "__flowerCrypto", { value: callback, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "__flowerCrypto", previous);
    else Reflect.deleteProperty(globalThis, "__flowerCrypto");
    nacl.setPRNG(null);
  });
}

test("crypto imports are lazy and package root shares the same API", () => {
  assert.equal(rootNaCl, nacl);
  assert.equal(rootJWT, jwt);
  assert.throws(() => nacl.hash(new Uint8Array()), /only inside a Flower method/);
  assert.throws(() => nacl.hash("no implicit UTF-8" as any), TypeError);
  assert.throws(() => nacl.randomBytes(-1), TypeError);
  assert.throws(() => nacl.randomBytes(0x1_0000_0000), TypeError);
  assert.throws(() => nacl.randomBytes(1.5), TypeError);
  assert.throws(() => nacl.setPRNG(undefined as any), TypeError);
});

test("NaCl binary wrappers preserve view identity, argument order and result kinds", (t) => {
  const backing = new Uint8Array(128);
  const message = backing.subarray(7, 11), nonce = backing.subarray(16, 40);
  const key = backing.subarray(48, 80), signature = backing.subarray(48, 112);
  let observed: [number, number, ...Input[]] = [0, 0];
  let result: Result = new Uint8Array([9]);
  bridge(t, (op, parameter, ...inputs) => { observed = [op, parameter, ...inputs]; return result; });
  const calls: [number, Input[], () => unknown][] = [
    [1, [message, nonce, key], () => nacl.secretbox(message, nonce, key)],
    [2, [message, nonce, key], () => nacl.secretbox.open(message, nonce, key)],
    [3, [key, key], () => nacl.scalarMult(key, key)],
    [4, [key], () => nacl.scalarMult.base(key)],
    [5, [key, key], () => nacl.box.before(key, key)],
    [6, [message, nonce, key, key], () => nacl.box(message, nonce, key, key)],
    [7, [message, nonce, key, key], () => nacl.box.open(message, nonce, key, key)],
    [8, [message, signature], () => nacl.sign(message, signature)],
    [9, [signature, key], () => nacl.sign.open(signature, key)],
    [10, [message, signature], () => nacl.sign.detached(message, signature)],
    [11, [message, signature, key], () => nacl.sign.detached.verify(message, signature, key)],
    [15, [message], () => nacl.hash(message)],
    [16, [message, message], () => nacl.verify(message, message)],
  ];
  for (const [operation, inputs, call] of calls) {
    assert.equal(call(), result);
    assert.equal(observed[0], operation);
    assert.equal(observed[1], 0);
    assert.equal(observed.length, inputs.length + 2);
    inputs.forEach((input, index) => assert.equal(observed[index + 2], input));
  }
  result = null;
  assert.equal(nacl.secretbox.open(message, nonce, key), null);
  assert.equal(nacl.sign.open(signature, key), null);
  result = false;
  assert.equal(nacl.sign.detached.verify(message, signature, key), false);
  assert.equal(nacl.verify(message, message), false);
});

test("NaCl aliases and constants match the high-level API", () => {
  assert.equal(nacl.box.after, nacl.secretbox);
  assert.equal(nacl.box.open.after, nacl.secretbox.open);
  assert.deepEqual([nacl.secretbox.keyLength, nacl.secretbox.nonceLength, nacl.secretbox.overheadLength], [32, 24, 16]);
  assert.deepEqual([nacl.box.publicKeyLength, nacl.box.secretKeyLength, nacl.box.sharedKeyLength, nacl.box.nonceLength, nacl.box.overheadLength], [32, 32, 32, 24, 16]);
  assert.deepEqual([nacl.sign.publicKeyLength, nacl.sign.secretKeyLength, nacl.sign.seedLength, nacl.sign.signatureLength], [32, 64, 32, 64]);
  assert.deepEqual([nacl.scalarMult.scalarLength, nacl.scalarMult.groupElementLength, nacl.hash.hashLength], [32, 32, 64]);
});

test("key-pair wrappers isolate public buffers and erase temporary secret copies", (t) => {
  let operation = 0;
  let packed = new Uint8Array();
  let input: Uint8Array | undefined;
  bridge(t, (op, _parameter, ...inputs) => {
    operation = op;
    input = inputs[0] as Uint8Array;
    packed = new Uint8Array(op === 14 ? 64 : 96);
    packed.fill(1, 0, 32);
    packed.fill(2, 32);
    return packed;
  });
  const seed = new Uint8Array(32).fill(9);
  for (const [expected, call] of [
    [12, () => nacl.sign.keyPair.fromSeed(seed)],
    [13, () => nacl.sign.keyPair.fromSecretKey(seed)],
    [14, () => nacl.box.keyPair.fromSecretKey(seed)],
  ] as const) {
    const pair = call();
    assert.equal(operation, expected);
    assert.equal(input, seed);
    assert.equal(pair.publicKey.buffer.byteLength, 32);
    assert.equal(pair.secretKey.length, expected === 14 ? 32 : 64);
    assert.notEqual(pair.publicKey.buffer, pair.secretKey.buffer);
    assert.ok(pair.publicKey.every(value => value === 1));
    assert.ok(pair.secretKey.every(value => value === 2));
    assert.ok(packed.every(value => value === 0));
    assert.ok(seed.every(value => value === 9));
  }
  nacl.setPRNG((bytes, length) => { assert.equal(length, 32); bytes.fill(5); });
  nacl.sign.keyPair();
  assert.equal(operation, 12);
  assert.ok(input!.every(value => value === 0));
  nacl.box.keyPair();
  assert.equal(operation, 14);
});

test("native entropy and explicit PRNG overrides have separate paths", (t) => {
  let calls = 0;
  bridge(t, (op, parameter, ...inputs) => {
    assert.equal(op, 0); assert.equal(inputs.length, 0); calls += 1;
    return new Uint8Array(parameter).fill(7);
  });
  assert.deepEqual(nacl.randomBytes(3), new Uint8Array([7, 7, 7]));
  nacl.setPRNG((bytes, length) => { assert.equal(length, 2); bytes.fill(8); });
  assert.deepEqual(nacl.randomBytes(2), new Uint8Array([8, 8]));
  assert.equal(calls, 1);
  let failedOutput: Uint8Array | undefined;
  nacl.setPRNG(bytes => { failedOutput = bytes; bytes.fill(3); throw new Error("failed PRNG"); });
  assert.throws(() => nacl.randomBytes(2), /failed PRNG/);
  assert.deepEqual(failedOutput, new Uint8Array(2));
  nacl.setPRNG(null);
  assert.equal(nacl.randomBytes(0).length, 0);
  assert.equal(calls, 2);
});

test("JWT sends binary keys directly and serializes only finite plain JSON", (t) => {
  let observed: [number, number, ...Input[]] = [0, 0];
  bridge(t, (op, parameter, ...inputs) => {
    observed = [op, parameter, ...inputs];
    return op === 100 ? "signed.token.value" : '{"claims":{"sub":"alice"},"protectedHeader":{"alg":"HS256"}}';
  });
  const key = new Uint8Array(32), claims = { sub: "alice", exp: 2000 };
  assert.equal(jwt.sign(claims, key, { algorithm: "HS256" }), "signed.token.value");
  assert.deepEqual(observed, [100, 0, '{"exp":2000,"sub":"alice"}', key, '{"algorithm":"HS256","keyFormat":"raw"}']);
  assert.equal(observed[3], key);
  assert.equal(jwt.verify<{ sub: string }>("a.b.c", key, { algorithms: ["HS256"] }).claims.sub, "alice");
  assert.deepEqual(observed, [101, 0, "a.b.c", key, '{"algorithms":["HS256"],"keyFormat":"raw"}']);
  jwt.sign(claims, "PEM text", { algorithm: "RS256" });
  assert.match(observed[4] as string, /"keyFormat":"pem"/);
  jwt.sign(claims, key, { algorithm: "EdDSA", keyFormat: "der" });
  assert.match(observed[4] as string, /"keyFormat":"der"/);
  assert.throws(() => jwt.sign(claims, "PEM", { algorithm: "HS256", keyFormat: "raw" }), TypeError);
  assert.throws(() => jwt.sign({ exp: NaN }, key, { algorithm: "HS256" }), /finite/);
  assert.throws(() => jwt.sign([] as any, key, { algorithm: "HS256" }), /object/);
  assert.throws(() => jwt.verify("a.b.c", key, { get algorithms() { throw new Error("must not run"); } } as any), /accessors/);
});

test("JWT encryption uses native entropy unless a nonce is explicitly provided", (t) => {
  const key = new Uint8Array(32), explicit = new Uint8Array(12).fill(1);
  let calls: number[] = [], generated: Uint8Array | undefined;
  bridge(t, (op, parameter, ...inputs) => {
    calls.push(op);
    if (op === 0) { assert.equal(parameter, 12); generated = new Uint8Array(12).fill(2); return generated; }
    if (op === 102) {
      assert.equal(inputs[1], key);
      assert.equal((inputs[2] as Uint8Array).length, 12);
      assert.deepEqual(JSON.parse(inputs[3] as string), { kid: "key-1" });
      return "protected..nonce.ciphertext.tag";
    }
    assert.equal(op, 103);
    return '{"claims":{"exp":2000},"protectedHeader":{"alg":"dir","enc":"A256GCM"}}';
  });
  nacl.setPRNG(() => { throw new Error("JWT must not use NaCl PRNG override"); });
  assert.equal(jwt.encrypt({ exp: 2000 }, key, { nonce: explicit, kid: "key-1" }), "protected..nonce.ciphertext.tag");
  assert.deepEqual(calls, [102]);
  assert.ok(explicit.every(byte => byte === 1));
  calls = [];
  jwt.encrypt({ exp: 2000 }, key, { kid: "key-1" });
  assert.deepEqual(calls, [0, 102]);
  assert.ok(generated!.every(byte => byte === 0));
  assert.equal(jwt.decrypt("a..b.c.d", key).protectedHeader.enc, "A256GCM");
  assert.throws(() => jwt.encrypt({}, key, { nonce: new Uint8Array(11) }), /12 bytes/);
  assert.throws(() => jwt.encrypt({}, new Uint8Array(31)), /32 bytes/);
  assert.throws(() => jwt.encrypt({}, key, { get nonce() { throw new Error("must not run"); } } as any), /accessors/);
});
