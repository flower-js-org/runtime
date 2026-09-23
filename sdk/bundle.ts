import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { build } from "esbuild";
import type { Bundle } from "./client.ts";

export interface BuildOptions {
  /** Static initialization runs once before snapshotting. Module initialization
   * must not depend on invocation bindings. Each callback still starts fresh. */
  initialization?: "per-invocation" | "static";
}

/** Compile a default-exported define(...) module for the isolated server runtime. */
export async function buildBundle(entry: string, options: BuildOptions = {}): Promise<Bundle> {
  if (options.initialization !== undefined &&
      !["per-invocation", "static"].includes(options.initialization)) {
    throw new TypeError("initialization must be per-invocation or static");
  }
  const absolute = resolve(entry);
  const result = await build({
    absWorkingDir: dirname(absolute),
    entryPoints: [basename(absolute)],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "__flowerBundle",
    platform: "neutral",
    target: "es2020",
    charset: "ascii",
    legalComments: "none",
    treeShaking: true,
    logLevel: "silent",
  });
  const javascript = (options.initialization === "static" ? "/* flower:static-init */\n" : "") + result.outputFiles[0].text;
  return { hash: createHash("sha256").update(javascript).digest("hex"), javascript };
}

export async function loadBundle(path: string, options: BuildOptions = {}): Promise<Bundle> {
  if (!path.endsWith(".json")) return buildBundle(path, options);
  if (options.initialization !== undefined) throw new TypeError("A built bundle already specifies its initialization mode");
  const bundle: unknown = JSON.parse(await readFile(path, "utf8"));
  if (bundle === null || typeof bundle !== "object" ||
      typeof (bundle as Bundle).hash !== "string" ||
      typeof (bundle as Bundle).javascript !== "string") {
    throw new TypeError("Bundle file must contain hash and javascript strings");
  }
  const result = bundle as Bundle;
  const hash = createHash("sha256").update(result.javascript).digest("hex");
  if (result.hash !== hash) throw new TypeError("Bundle hash does not match its JavaScript");
  return { hash, javascript: result.javascript };
}

export async function writeBundle(entry: string, output: string, options: BuildOptions = {}): Promise<Bundle> {
  const bundle = await buildBundle(entry, options);
  await writeFile(output, JSON.stringify(bundle, null, 2) + "\n");
  return bundle;
}
