import { createRequire } from "node:module";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

/**
 * Release-time injection of the Model Gateway default provider.
 *
 * Every eve 1.0 Release gets an instrumentation file whose `setup` installs
 * the provider from `eveland/model-gateway`. The file is inert until the
 * Worker delivers the reserved EVELAND_MODEL_GATEWAY_* variables, so a Model
 * Gateway configured after a deploy takes effect on the next restart without
 * a rebuild.
 *
 * Unlike the observer runtime, which the platform mount keeps current, this
 * bundle is frozen into the Release: the provider decides how model calls
 * behave, so it belongs to the immutable artifact. Only configuration is
 * delivered at runtime.
 *
 * `setup` runs once at startup, after every instrumentation module has loaded,
 * so a provider an Agent installs at module top level is already in place
 * when the runtime checks for one, and is never replaced.
 */

export const MODEL_GATEWAY_INSTRUMENTATION_STEM = "eveland-model-gateway";
export const MODEL_GATEWAY_INSTRUMENTATION_FILE = `${MODEL_GATEWAY_INSTRUMENTATION_STEM}.js`;
export const MODEL_GATEWAY_RUNTIME_FILE = ".eveland/model-gateway/runtime.mjs";

export type ModelGatewayInjectionResult =
  | { status: "injected"; injectedFiles: string[]; runtimeFile: string }
  | { status: "skipped"; reason: "eve-version" | "eve-unknown" | "no-agent-root" };

let bundledRuntime: Promise<string> | undefined;

/**
 * The single source of the runtime is the published SDK's
 * `src/model-gateway.ts`, so an Agent that imports `eveland/model-gateway`
 * for `eve dev` runs the same code a Release does. It is bundled from source
 * by path (the workspace never builds the SDK's dist/), with every dependency
 * inlined so the Release resolves nothing.
 */
export function bundleModelGatewayRuntime(): Promise<string> {
  bundledRuntime ??= build({
    entryPoints: [modelGatewayRuntimeSourcePath()],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
  }).then((result) => {
    const file = result.outputFiles[0];
    if (!file) throw new Error("Model Gateway runtime bundle produced no output.");
    return file.text;
  });
  bundledRuntime.catch(() => {
    bundledRuntime = undefined;
  });
  return bundledRuntime;
}

function modelGatewayRuntimeSourcePath(): string {
  const packageJson = createRequire(import.meta.url).resolve("eveland/package.json");
  return path.join(path.dirname(packageJson), "src", "model-gateway.ts");
}

/** Only eve 1.0 and later resolve string models through the default-provider global in `eve dev` too. */
export function eveSupportsModelGateway(eveVersion: string): boolean {
  const major = Number.parseInt(eveVersion.replace(/^[^\d]*/, ""), 10);
  return Number.isFinite(major) && major >= 1;
}

export async function injectModelGateway(input: {
  releaseDir: string;
  eveVersion: string;
}): Promise<ModelGatewayInjectionResult> {
  // Import already refuses a project whose eve dependency cannot be read, so
  // this only happens on paths that bypass import (tests, smoke fixtures).
  if (input.eveVersion.trim() === "") return { status: "skipped", reason: "eve-unknown" };
  if (!eveSupportsModelGateway(input.eveVersion)) {
    return { status: "skipped", reason: "eve-version" };
  }

  const releaseDir = path.resolve(input.releaseDir);
  const agentRoot = await resolveAgentRoot(releaseDir);
  if (agentRoot === undefined) return { status: "skipped", reason: "no-agent-root" };

  const instrumentationDir = path.join(agentRoot, "instrumentation");
  const collision = await findReservedInstrumentation(instrumentationDir);
  if (collision !== undefined) {
    throw new Error(
      `Reserved instrumentation file ${path.relative(releaseDir, collision)} already exists. Rename the authored file; Eveland will not overwrite it.`,
    );
  }

  const runtimePath = path.join(releaseDir, MODEL_GATEWAY_RUNTIME_FILE);
  await mkdir(path.dirname(runtimePath), { recursive: true });
  await writeFile(runtimePath, await bundleModelGatewayRuntime(), "utf8");

  const shimPath = path.join(instrumentationDir, MODEL_GATEWAY_INSTRUMENTATION_FILE);
  await mkdir(instrumentationDir, { recursive: true });
  await writeFile(shimPath, createModelGatewayShim(shimPath, runtimePath), "utf8");

  return {
    status: "injected",
    injectedFiles: [path.relative(releaseDir, shimPath).split(path.sep).join("/")],
    runtimeFile: MODEL_GATEWAY_RUNTIME_FILE,
  };
}

export function createModelGatewayShim(shimPath: string, runtimePath: string): string {
  let runtimeSpecifier = path
    .relative(path.dirname(shimPath), runtimePath)
    .split(path.sep)
    .join("/");
  if (!runtimeSpecifier.startsWith(".")) runtimeSpecifier = `./${runtimeSpecifier}`;
  return [
    `// Injected by Eveland. Installs the instance's Model Gateway as the AI SDK`,
    `// default provider for string model IDs, unless the Agent installed its own`,
    `// or no Model Gateway is configured for this project.`,
    `import { defineInstrumentation } from "eve/instrumentation";`,
    `import { installModelGateway } from ${JSON.stringify(runtimeSpecifier)};`,
    ``,
    `export default defineInstrumentation({`,
    `  setup() {`,
    `    const result = installModelGateway();`,
    `    if (result.status === "installed") {`,
    `      console.info(\`[eveland] Model Gateway: \${result.kind}\`);`,
    `    }`,
    `  },`,
    `});`,
    ``,
  ].join("\n");
}

async function resolveAgentRoot(releaseDir: string): Promise<string | undefined> {
  const nested = path.join(releaseDir, "agent");
  if (await isDirectory(nested)) return nested;
  return (await hasRootInstructions(releaseDir)) ? releaseDir : undefined;
}

async function findReservedInstrumentation(directory: string): Promise<string | undefined> {
  const entries = await readdir(directory).catch(() => [] as string[]);
  const reserved = entries.find(
    (name) => path.parse(name).name === MODEL_GATEWAY_INSTRUMENTATION_STEM,
  );
  return reserved === undefined ? undefined : path.join(directory, reserved);
}

async function hasRootInstructions(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.some(
    (entry) =>
      (entry.isFile() && /^instructions\.(?:md|[cm]?[jt]s)$/.test(entry.name)) ||
      (entry.isDirectory() && entry.name === "instructions"),
  );
}

async function isDirectory(target: string): Promise<boolean> {
  return readdir(target).then(
    () => true,
    () => false,
  );
}
