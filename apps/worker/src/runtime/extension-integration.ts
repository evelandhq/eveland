import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const EXTENSION_INTEGRATOR_RELEASE_PATH = ".eveland/extensions/integrate.mjs";

let bundledIntegrator: Promise<string> | undefined;

export function bundleExtensionIntegrator(): Promise<string> {
  bundledIntegrator ??= build({
    entryPoints: [fileURLToPath(new URL("./extension-integration-entry.ts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node24",
    legalComments: "none",
    banner: {
      js: 'import { createRequire as __eveland_createRequire } from "node:module"; import { fileURLToPath as __eveland_fileURLToPath } from "node:url"; import { dirname as __eveland_dirname } from "node:path"; const require = __eveland_createRequire(import.meta.url); const __filename = __eveland_fileURLToPath(import.meta.url); const __dirname = __eveland_dirname(__filename);',
    },
  }).then((result) => {
    const file = result.outputFiles[0];
    if (!file) throw new Error("Extension integrator bundle produced no output.");
    return file.text;
  });
  bundledIntegrator.catch(() => {
    bundledIntegrator = undefined;
  });
  return bundledIntegrator;
}

export async function injectExtensionIntegrator(releaseDir: string): Promise<string> {
  const target = path.join(releaseDir, EXTENSION_INTEGRATOR_RELEASE_PATH);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, await bundleExtensionIntegrator(), "utf8");
  return EXTENSION_INTEGRATOR_RELEASE_PATH;
}
