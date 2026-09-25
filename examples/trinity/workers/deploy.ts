import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FlowerAdmin, type Json } from "@flower-js/sdk";
import { buildBundle } from "@flower-js/sdk/bundle";

const appModule = new URL("../app/app.ts", import.meta.url).pathname;

/** Write an entry that builds the application verifying tokens signed by this public key. */
export async function writeEntry(directory: string, publicKeyPem: string): Promise<string> {
  const entry = join(directory, "entry.ts");
  await mkdir(directory, { recursive: true });
  // Only the application module is imported, so the entry can live anywhere and still resolve the SDK from this repository.
  await writeFile(entry, `import { makeDeployedApp } from ${JSON.stringify(appModule)};\n\nexport default makeDeployedApp(${JSON.stringify(publicKeyPem)});\n`);
  return entry;
}

export interface DeployOptions { flowerUrl: string; adminToken: string; publicKeyPem: string; directory: string; partition?: string }

export async function deployApp(options: DeployOptions): Promise<{ hash: string; revision: number; value: Json }> {
  const bundle = await buildBundle(await writeEntry(options.directory, options.publicKeyPem));
  const admin = new FlowerAdmin(options.flowerUrl, { adminToken: options.adminToken });
  const target = options.partition ? admin.partition(options.partition) : admin;
  const receipt = await target.deploy(bundle, { requestId: `deploy:${options.partition ?? ""}:${bundle.hash}` });
  return { hash: bundle.hash, revision: receipt.revision, value: receipt.value };
}
