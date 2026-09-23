import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const temporary = await mkdtemp(join(tmpdir(), "flower-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}
try {
  run(npm, ["run", "build"]);
  const [packed] = JSON.parse(run(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary]));
  assert.equal(packed.name, "@flower-js/sdk");
  const paths = packed.files.map(({ path }) => path);
  for (const required of ["dist/index.js", "dist/index.d.ts", "dist/crypto.js", "dist/crypto.d.ts", "dist/cli.js", "dist/bundle.js", "LICENSE-MIT"]) {
    assert.ok(paths.includes(required), `Missing packaged ${required}`);
  }
  assert.ok(paths.every((path) => /^(?:dist\/[^/]+\.(?:js|d\.ts)|package\.json|README\.md|LICENSE-(?:MIT|APACHE))$/.test(path)),
    "Package must contain only compiled SDK, declarations and package documentation");
  assert.ok(paths.every((path) => !path.includes(".test.")), "Tests must not ship");
  await writeFile(join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(temporary, packed.filename),
    `typescript@${manifest.devDependencies.typescript}`, `@types/node@${manifest.devDependencies["@types/node"]}`], temporary);
  await writeFile(join(temporary, "app.ts"), `
import { collection, define, mutation, query, key, keyVersion, transaction } from "@flower-js/sdk";
import { scheduler } from "@flower-js/sdk/scheduler";
import { workQueue } from "@flower-js/sdk/temporal";
import { nacl, jwt } from "@flower-js/sdk/crypto";
const sessions = key("sessions", { algorithm: "Ed25519", usages: ["sign", "verify"] });
const managed = query("managed", (_ctx, token: string) => jwt.verify(token, sessions).claims);
const values = collection<number>("numbers");
const indexed=collection<{due:number}>("scheduled").index("due",["due"]);
const page=query("page",ctx=>ctx.range(indexed.by("due").range({gte:0,limit:10})));
const transfer=transaction("transfer",()=>({calls:[{partition:"tenant",method:"set",args:1}]}));
const authorize=query("authorize",(_ctx,request:any)=>request.credentials?{subject:"example",tenant:request.partition??undefined}:null);
void authorize; void transfer; void page; void keyVersion;
const set = mutation("set", (ctx, n: number) => { ctx.set(values, "n", n); return n; });
const get = query("get", ctx => ctx.get(values, "n"));
const digest = query("digest", (_ctx, bytes: number[]) => Array.from(nacl.hash(new Uint8Array(bytes))));
const checkToken = query("checkToken", (_ctx, token: string) => jwt.verify(token, new Uint8Array(32), { algorithms: ["HS256"] }).claims);
const timers = scheduler("timers", { set });
const jobs = workQueue<{ n: number }>("jobs", { maxLeaseMs: 1000 });
void timers; void jobs;
export default define({ keys: [sessions], http: { set, get, digest, checkToken, managed } });
`);
  await writeFile(join(temporary, "consumer.ts"), `
import { FlowerClient } from "@flower-js/sdk/client";
import { buildBundle } from "@flower-js/sdk/bundle";
import { createHttp2Transport } from "@flower-js/sdk/http2";
import { nacl as rootNaCl, jwt as rootJWT } from "@flower-js/sdk";
import { nacl, jwt } from "@flower-js/sdk/crypto";
import type { JWTVerified, JWTSignOptions, NaClKeyPair, ManagedKey, ManagedJWTSignOptions, SharedKey } from "@flower-js/sdk/crypto";
import app from "./app.js";
const transport = createHttp2Transport();
const client = new FlowerClient("http://localhost:7101", { fetch: transport.fetch });
const bundle = await buildBundle("app.ts", { initialization: "static" });
if (typeof client.query !== "function" || app.http.get.kind !== "query" || !bundle.javascript.includes("__flowerBundle")) throw new Error("Broken installed SDK");
if (rootNaCl !== nacl || rootJWT !== jwt || nacl.box.after !== nacl.secretbox || nacl.sign.signatureLength !== 64) throw new Error("Broken crypto exports");
if(typeof client.openRetrySession!=="function"||typeof client.sessionRequestId!=="function"||typeof client.refreshRetryIdentity!=="function")throw new Error("Broken retry/session exports");
if (app.keys?.[0].name !== "sessions" || typeof client.keyImport !== "function" || typeof client.keyCacheStats !== "function") throw new Error("Broken managed key exports");
const managedOptions: ManagedJWTSignOptions = { typ: "JWT" };
const useManaged = (key: ManagedKey, shared: SharedKey) => {
  jwt.sign({ exp: 123 }, key, managedOptions);
  jwt.verify("token", key);
  return nacl.box.after(new Uint8Array(), new Uint8Array(24), shared);
};
void useManaged;
const signingOptions: JWTSignOptions = { algorithm: "ES256", keyFormat: "der" };
const verifyShape = (verified: JWTVerified<{ sub: string }>, pair: NaClKeyPair) => verified.claims.sub + pair.publicKey.length;
void signingOptions; void verifyShape;
let unavailable = false;
try { nacl.hash(new Uint8Array()); } catch (error) { unavailable = error instanceof Error && /only inside a Flower method/.test(error.message); }
if (!unavailable) throw new Error("Native crypto must fail clearly outside Flower");
await transport.close();
`);
  await writeFile(join(temporary, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
    outDir: "out", types: ["node"],
  }, include: ["*.ts"] }));
  run(process.execPath, [join(temporary, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], temporary);
  run(process.execPath, ["out/consumer.js"], temporary);
  const cli = resolve(temporary, "node_modules/.bin/flower");
  assert.match(run(cli, ["--help"], temporary), /Usage: flower COMMAND/);
  run(cli, ["build", "app.ts", "application.flower.json"], temporary);
  const bundle = JSON.parse(await readFile(join(temporary, "application.flower.json"), "utf8"));
  assert.match(bundle.hash, /^[0-9a-f]{64}$/);
  assert.ok(bundle.javascript.includes("__flowerBundle"));
  console.log(`Verified ${packed.filename}: ${paths.length} files, consumer types/imports, module bundle and installed CLI.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
