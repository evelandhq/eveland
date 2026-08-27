import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const hookFileName = "eveland-model-gateway.js";
const runtimeRelativePath = ".eveland/model-gateway/runtime.mjs";

export type ModelGatewayInjectionResult = {
  injectedFiles: string[];
  runtimeFile?: string;
};

let bundledRuntime: Promise<string> | undefined;

/**
 * Bundles the model-gateway hook runtime (including the exact pinned
 * `@ai-sdk/gateway` client) into one self-contained ESM file. Baked into the
 * release on purpose — unlike the observer runtime, whose contract tracks the
 * running platform and is therefore mount-delivered, this bundle's contract
 * is the gateway wire protocol version it pins, which the release should keep
 * until it is rebuilt.
 */
export function bundleModelGatewayRuntime(): Promise<string> {
  bundledRuntime ??= build({
    entryPoints: [fileURLToPath(new URL("./hook-runtime.ts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
    banner: {
      // Some transitive deps ship CJS that require() node builtins; esbuild's
      // ESM output shims those through a require that must exist.
      js: 'import { createRequire as __eveland_createRequire } from "node:module"; import { pathToFileURL as __eveland_pathToFileURL } from "node:url"; const require = __eveland_createRequire(import.meta.url.startsWith("file:") ? import.meta.url : __eveland_pathToFileURL(`${process.cwd()}/`).href);',
    },
  }).then((result) => {
    const file = result.outputFiles[0];
    if (!file) throw new Error("Model gateway runtime bundle produced no output.");
    return file.text;
  });
  bundledRuntime.catch(() => {
    bundledRuntime = undefined;
  });
  return bundledRuntime;
}

/**
 * Bakes the model-gateway runtime into a release and writes a hook shim into
 * the root agent's hooks directory. The shim wraps the runtime with the
 * Agent's own `defineHook`; the runtime's import side effect installs the AI
 * SDK default provider process-wide, so the root agent's hook covers every
 * subagent in the same process. The runtime no-ops unless the platform
 * injects EVELAND_MODEL_GATEWAY_URL, so injection is unconditional.
 */
export async function injectModelGatewayRuntime(input: {
  releaseDir: string;
}): Promise<ModelGatewayInjectionResult> {
  const releaseDir = path.resolve(input.releaseDir);
  const nestedAgentRoot = path.join(releaseDir, "agent");
  const agentRoot = (await isDirectory(nestedAgentRoot)) ? nestedAgentRoot : releaseDir;
  const hasAgentRoot = agentRoot === nestedAgentRoot || (await hasRootAgentMarkers(agentRoot));
  if (!hasAgentRoot) {
    return { injectedFiles: [] };
  }

  const hookPath = path.join(agentRoot, "hooks", hookFileName);
  if (await exists(hookPath)) {
    throw new Error(
      `Reserved model gateway hook already exists at ${path.relative(releaseDir, hookPath)}. Rename the authored file; Eveland will not overwrite it.`,
    );
  }

  const runtimePath = path.join(releaseDir, runtimeRelativePath);
  await mkdir(path.dirname(runtimePath), { recursive: true });
  await writeFile(runtimePath, await bundleModelGatewayRuntime(), "utf8");

  await mkdir(path.dirname(hookPath), { recursive: true });
  await writeFile(hookPath, createModelGatewayShim(hookPath, runtimePath), "utf8");

  return {
    injectedFiles: [path.relative(releaseDir, hookPath).split(path.sep).join("/")],
    runtimeFile: runtimeRelativePath,
  };
}

function createModelGatewayShim(hookPath: string, runtimePath: string): string {
  let relativeRuntimePath = path
    .relative(path.dirname(hookPath), runtimePath)
    .split(path.sep)
    .join("/");
  if (!relativeRuntimePath.startsWith(".")) {
    relativeRuntimePath = `./${relativeRuntimePath}`;
  }
  return [
    `import { defineHook } from "eve/hooks";`,
    ``,
    `// Importing the baked runtime installs the Eveland Model Gateway as the`,
    `// AI SDK's default provider (when the platform injects a gateway URL),`,
    `// so string models resolve through the platform. Outside an Eveland`,
    `// deployment the runtime is a no-op and string models keep their`,
    `// default resolution.`,
    `import runtime from ${JSON.stringify(relativeRuntimePath)};`,
    ``,
    `export default defineHook(runtime);`,
    ``,
  ].join("\n");
}

async function hasRootAgentMarkers(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.some(
    (entry) =>
      (entry.isFile() && /^(?:instructions|agent)\.(?:md|[cm]?[jt]s)$/.test(entry.name)) ||
      (entry.isDirectory() && entry.name === "instructions"),
  );
}

async function exists(target: string): Promise<boolean> {
  return access(target).then(
    () => true,
    () => false,
  );
}

async function isDirectory(target: string): Promise<boolean> {
  return readdir(target).then(
    () => true,
    () => false,
  );
}
