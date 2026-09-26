import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { blobStoreFromEnv, FileBlobStore, isBlobKey, presignV4, S3BlobStore, signV4 } from "../workers/blobs.ts";

// The credentials and clock of AWS's published Signature Version 4 examples for S3.
const example = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" };
const exampleDate = new Date("2013-05-24T00:00:00Z");
const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const bytes = (text: string) => new TextEncoder().encode(text);

test("files round-trip under their content address", async () => {
  const root = await mkdtemp(join(tmpdir(), "trinity-blobs-"));
  const store = new FileBlobStore(root);
  const key = await store.put("hello", "text/plain");
  assert.equal(key, `sha256/${sha256("hello")}`);
  assert.equal(await store.put(bytes("hello"), "text/plain"), key);
  assert.deepEqual(await store.get(key), { body: bytes("hello"), contentType: "text/plain" });
  assert.deepEqual((await readdir(join(root, "sha256"))).sort(), [sha256("hello"), `${sha256("hello")}.json`]);
  assert.equal(await store.get(`sha256/${sha256("absent")}`), null);
  assert.equal(await store.url(key, 60), null);
});

test("only content addresses are keys", async () => {
  const store = new FileBlobStore(await mkdtemp(join(tmpdir(), "trinity-blobs-")));
  const hex = sha256("hello");
  assert.equal(isBlobKey(`sha256/${hex}`), true);
  for (const key of ["../../etc/passwd", `sha256/../${hex.slice(3)}`, `sha256/${hex.toUpperCase()}`, `sha256/${hex.slice(1)}`, `sha256/${hex}.json`, `sha256/${hex}\n`, `/sha256/${hex}`, hex]) {
    assert.equal(isBlobKey(key), false, key);
    await assert.rejects(store.get(key), /Not a blob key/);
    await assert.rejects(store.url(key, 60), /Not a blob key/);
  }
});

test("header signatures match AWS's GET Object example", () => {
  const headers = signV4(example, {
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    headers: { Range: "bytes=0-9 " },
    payloadHash: emptyHash,
  }, exampleDate);
  assert.equal(headers.authorization, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,"
    + "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.equal(headers["x-amz-date"], "20130524T000000Z");
  assert.equal(headers["x-amz-content-sha256"], emptyHash);
});

test("presigned URLs match AWS's query-string example", () => {
  const url = presignV4(example, { method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), expiresInSeconds: 86400 }, exampleDate);
  assert.equal(url, "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256"
    + "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z"
    + "&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  assert.throws(() => presignV4(example, { method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), expiresInSeconds: 604_801 }, exampleDate), RangeError);
});

interface Recorded { method: string; url: string; headers: Headers }

/** Serves objects by URL, or answers every request with `status` when given one. */
function fakeS3(status?: number) {
  const objects = new Map<string, { body: Uint8Array; type: string }>();
  const requests: Recorded[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    requests.push({ method, url, headers });
    if (status) return new Response("<Error><Code>AccessDenied</Code></Error>", { status });
    if (method === "PUT") {
      objects.set(url, { body: new Uint8Array(init!.body as Uint8Array), type: headers.get("content-type")! });
      return new Response(null);
    }
    const object = objects.get(url);
    if (!object) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    return new Response(object.body as Uint8Array<ArrayBuffer>, { headers: { "content-type": object.type } });
  }) as typeof fetch;
  return { requests, fetch: fake };
}

test("S3 puts and gets path-style through an endpoint", async () => {
  const s3 = fakeS3();
  const store = new S3BlobStore({ ...example, bucket: "blobs", prefix: "/trinity/dev/", endpoint: "http://127.0.0.1:3900/", fetch: s3.fetch, now: () => exampleDate });
  const hash = sha256("hello");
  const key = await store.put("hello", "text/plain");
  assert.equal(key, `sha256/${hash}`);
  const [put] = s3.requests;
  assert.equal(put!.method, "PUT");
  assert.equal(put!.url, `http://127.0.0.1:3900/blobs/trinity/dev/sha256/${hash}`);
  assert.equal(put!.headers.get("x-amz-content-sha256"), hash);
  assert.match(put!.headers.get("authorization")!,
    /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request,SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,Signature=[0-9a-f]{64}$/);

  assert.deepEqual(await store.get(key), { body: bytes("hello"), contentType: "text/plain" });
  assert.equal(s3.requests[1]!.headers.get("x-amz-content-sha256"), emptyHash);
  assert.equal(await store.get(`sha256/${sha256("absent")}`), null);

  const url = await store.url(key, 3600);
  assert.ok(url!.startsWith(`http://127.0.0.1:3900/blobs/trinity/dev/sha256/${hash}?X-Amz-Algorithm=AWS4-HMAC-SHA256&`), url!);
  assert.match(url!, /&X-Amz-Expires=3600&/);
  assert.match((await store.url(key, 30 * 86400))!, /&X-Amz-Expires=604800&/);
});

test("S3 defaults to virtual-hosted AWS URLs and reports failures", async () => {
  const s3 = fakeS3(403);
  const store = new S3BlobStore({ ...example, region: "eu-west-1", bucket: "blobs", sessionToken: "session/token", fetch: s3.fetch, now: () => exampleDate });
  const key = `sha256/${sha256("x")}`;
  await assert.rejects(store.put("x", "text/plain"), { message: `S3 PUT ${key} failed with 403: <Error><Code>AccessDenied</Code></Error>` });
  await assert.rejects(store.get(key), /S3 GET .* failed with 403/);
  const [put] = s3.requests;
  assert.equal(put!.url, `https://blobs.s3.eu-west-1.amazonaws.com/${key}`);
  assert.equal(put!.headers.get("x-amz-security-token"), "session/token");
  assert.match(put!.headers.get("authorization")!, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
  const url = (await store.url(key, 60))!;
  assert.ok(url.startsWith(`https://blobs.s3.eu-west-1.amazonaws.com/${key}?`), url);
  assert.match(url, /&X-Amz-Security-Token=session%2Ftoken&X-Amz-SignedHeaders=host&X-Amz-Signature=[0-9a-f]{64}$/);
});

test("TRINITY_BLOBS picks the store", async () => {
  const root = await mkdtemp(join(tmpdir(), "trinity-blobs-"));
  const files = blobStoreFromEnv({ TRINITY_BLOBS: pathToFileURL(root).href });
  assert.ok(files instanceof FileBlobStore);
  const key = await files.put("hello", "text/plain");
  assert.deepEqual(await new FileBlobStore(root).get(key), { body: bytes("hello"), contentType: "text/plain" });

  const credentials = { AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "secret" };
  const r2 = blobStoreFromEnv({ ...credentials, TRINITY_BLOBS: "s3://blobs/a/b", AWS_REGION: "auto", TRINITY_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com" });
  assert.ok(r2 instanceof S3BlobStore);
  assert.match((await r2.url(key, 60))!, new RegExp(`^https://account\\.r2\\.cloudflarestorage\\.com/blobs/a/b/${key}\\?.*Credential=AKID%2F\\d{8}%2Fauto%2Fs3%2Faws4_request&`));
  const aws = blobStoreFromEnv({ ...credentials, TRINITY_BLOBS: "s3://blobs" });
  assert.ok((await aws.url(key, 60))!.startsWith(`https://blobs.s3.us-east-1.amazonaws.com/${key}?`));

  assert.throws(() => blobStoreFromEnv({}), /TRINITY_BLOBS is not set/);
  assert.throws(() => blobStoreFromEnv({ TRINITY_BLOBS: "s3://blobs" }), /AWS_ACCESS_KEY_ID/);
  assert.throws(() => blobStoreFromEnv({ TRINITY_BLOBS: "https://example.com/blobs" }), /file: or s3:/);
});
