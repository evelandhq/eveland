import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { AGENT_RUNTIME_POLICY_PATH } from "@eveland/core/observability";

const observerFileName = "eveland-observer.js";
const runtimeRelativePath = ".eveland/observability/runtime.mjs";

export const OBSERVER_RUNTIME_FILE_NAME = "runtime.mjs";

/**
 * Container-absolute path of the Worker-delivered observer runtime: it lives
 * next to agent-policy.json in the read-only observability mount every
 * deployment receives. Shims baked into releases import this path first, so
 * the observer logic always matches the running Eveland instead of being
 * frozen at release build time. The file's default export is a plain Eve hook
 * configuration; that contract must hold for every shim ever shipped, so an
 * incompatible runtime change requires a NEW file name (leaving this one
 * absent so old shims fall back to their baked bundle), never a changed
 * export shape.
 */
export const PLATFORM_OBSERVER_RUNTIME_PATH = path.posix.join(
  path.posix.dirname(AGENT_RUNTIME_POLICY_PATH),
  OBSERVER_RUNTIME_FILE_NAME,
);

/**
 * Version of the observer delivery contract embedded in a release. Bump only
 * when a release must be REBUILT to keep observability working (i.e. the shim
 * contract itself changes). Version 1 is implicit: releases built before this
 * constant existed embed a fully self-contained observer that ignores the
 * platform-delivered runtime and goes stale as the platform moves.
 */
export const OBSERVER_RUNTIME_CONTRACT = 2;

export type ObserverCoverageGap = {
  kind: "file-form-subagent";
  path: string;
  reason: string;
};

export type ObserverInjectionResult = {
  injectedFiles: string[];
  runtimeFile?: string;
  observerContract: number;
  coverageGaps: ObserverCoverageGap[];
};

let bundledRuntime: Promise<string> | undefined;

/**
 * Bundles the observer hook runtime into a single self-contained ESM file
 * (no imports left to resolve), memoized for the process lifetime: the same
 * artifact is baked into release builds as the offline fallback and written
 * into every deployment's observability mount by the Worker.
 */
export function bundleObserverRuntime(): Promise<string> {
  bundledRuntime ??= build({
    entryPoints: [fileURLToPath(new URL("./hook-runtime.ts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
    banner: {
      // The OTel SDK ships CJS modules that require() node builtins; in an ESM
      // bundle esbuild routes those through a shim that needs a real require.
      // Without this, importing the bundle in plain Node throws
      // "Dynamic require of 'util' is not supported".
      js: 'import { createRequire as __eveland_createRequire } from "node:module"; const require = __eveland_createRequire(import.meta.url);',
    },
  }).then((result) => {
    const file = result.outputFiles[0];
    if (!file) throw new Error("Observer runtime bundle produced no output.");
    return file.text;
  });
  bundledRuntime.catch(() => {
    // Do not cache a failed build; the next caller retries.
    bundledRuntime = undefined;
  });
  return bundledRuntime;
}

export async function injectObserverHooks(input: {
  releaseDir: string;
}): Promise<ObserverInjectionResult> {
  const releaseDir = path.resolve(input.releaseDir);
  const nestedAgentRoot = path.join(releaseDir, "agent");
  const rootAgentRoot = (await isDirectory(nestedAgentRoot)) ? nestedAgentRoot : releaseDir;
  const hasAgentRoot =
    rootAgentRoot === nestedAgentRoot || (await hasRootInstructions(rootAgentRoot));

  if (!hasAgentRoot) {
    return {
      injectedFiles: [],
      observerContract: OBSERVER_RUNTIME_CONTRACT,
      coverageGaps: [],
    };
  }

  const agentRoots: string[] = [rootAgentRoot];
  const coverageGaps: ObserverCoverageGap[] = [];
  await discoverSubagentRoots(rootAgentRoot, agentRoots, coverageGaps);

  const observerPaths = agentRoots.map((agentRoot) =>
    path.join(agentRoot, "hooks", observerFileName),
  );
  for (const observerPath of observerPaths) {
    if (await exists(observerPath)) {
      throw new Error(
        `Reserved observer hook already exists at ${path.relative(releaseDir, observerPath)}. Rename the authored file; Eveland will not overwrite it.`,
      );
    }
  }

  const runtimePath = path.join(releaseDir, runtimeRelativePath);
  await mkdir(path.dirname(runtimePath), { recursive: true });
  await writeFile(runtimePath, await bundleObserverRuntime(), "utf8");

  const injectedFiles: string[] = [];
  for (const observerPath of observerPaths) {
    await mkdir(path.dirname(observerPath), { recursive: true });
    await writeFile(observerPath, createObserverShim(observerPath, runtimePath), "utf8");
    injectedFiles.push(path.relative(releaseDir, observerPath));
  }

  return {
    injectedFiles,
    runtimeFile: runtimeRelativePath,
    observerContract: OBSERVER_RUNTIME_CONTRACT,
    coverageGaps,
  };
}

function createObserverShim(observerPath: string, runtimePath: string): string {
  let relativeRuntimePath = path
    .relative(path.dirname(observerPath), runtimePath)
    .split(path.sep)
    .join("/");
  if (!relativeRuntimePath.startsWith(".")) {
    relativeRuntimePath = `./${relativeRuntimePath}`;
  }
  return [
    `import { defineHook } from "eve/hooks";`,
    ``,
    `// Prefer the observer runtime the Eveland Worker delivers into the`,
    `// observability mount, so captured telemetry always matches the running`,
    `// platform; fall back to the bundle baked into this release when the Agent`,
    `// runs outside an Eveland deployment.`,
    `let runtime;`,
    `try {`,
    `  runtime = await import(${JSON.stringify(`file://${PLATFORM_OBSERVER_RUNTIME_PATH}`)});`,
    `} catch {`,
    `  runtime = await import(${JSON.stringify(relativeRuntimePath)});`,
    `}`,
    ``,
    `export default defineHook(runtime.default);`,
    ``,
  ].join("\n");
}

async function discoverSubagentRoots(
  agentRoot: string,
  agentRoots: string[],
  coverageGaps: ObserverCoverageGap[],
): Promise<void> {
  const subagentsDir = path.join(agentRoot, "subagents");
  if (!(await isDirectory(subagentsDir))) return;

  const entries = await readdir(subagentsDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(subagentsDir, entry.name);
    if (entry.isDirectory()) {
      if (await hasAgentConfig(entryPath)) {
        agentRoots.push(entryPath);
        await discoverSubagentRoots(entryPath, agentRoots, coverageGaps);
      }
      continue;
    }

    if (entry.isFile() && /\.(?:[cm]?[jt]s)$/.test(entry.name)) {
      coverageGaps.push({
        kind: "file-form-subagent",
        path: entryPath,
        reason:
          "Eve 0.28.x, 0.29.x, and 0.30.x discover file-form subagents but give them no independent hooks slot; the parent stream exposes only control-plane child events.",
      });
    }
  }
}

async function hasAgentConfig(directory: string): Promise<boolean> {
  const entries = await readdir(directory).catch(() => []);
  return entries.some((name) => /^agent\.(?:[cm]?[jt]s)$/.test(name));
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

async function exists(target: string): Promise<boolean> {
  return access(target).then(
    () => true,
    () => false,
  );
}
