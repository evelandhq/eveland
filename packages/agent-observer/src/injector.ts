import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { AGENT_RUNTIME_POLICY_PATH } from "@evelandhq/core/observability";

const observerFileName = "eveland-observer.js";
const extensionRuntimeFileName = "eveland-observer-runtime.mjs";
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
export const OBSERVER_RUNTIME_CONTRACT = 3;

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

type ExtensionSubagentSource = {
  entryPath: string;
  logicalPath: string;
  subagentId: string;
  manifest: ExtensionSubagentManifest;
};

type ExtensionSubagentManifest = {
  agentRoot: string;
  subagents: ExtensionSubagentSource[];
  resolvedExtensions: ExtensionSubagentMount[];
};

type ExtensionSubagentMount = {
  namespace: string;
  manifest: ExtensionSubagentManifest;
  overrides?: ExtensionSubagentManifest;
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

export async function injectExtensionSubagentHooks(input: {
  releaseDir: string;
  manifest: unknown;
}): Promise<{ injectedFiles: string[]; coverageGaps: ObserverCoverageGap[] }> {
  const releaseDir = path.resolve(input.releaseDir);
  const manifest = readExtensionSubagentManifest(input.manifest);
  const agentRoots: Array<{ agentRoot: string; fallbackRuntimePath: string }> = [];
  const coverageGaps: ObserverCoverageGap[] = [];

  const collectExtensionSubagent = (
    source: ExtensionSubagentSource,
    ownerManifest: ExtensionSubagentManifest,
  ): void => {
    const entryPath = resolveReleasePath(releaseDir, source.entryPath);
    if (isModulePath(entryPath)) {
      coverageGaps.push({
        kind: "file-form-subagent",
        path: entryPath,
        reason:
          "Eve Extension file-form subagents have no independent hooks slot; the parent stream exposes only control-plane child events.",
      });
      return;
    }
    agentRoots.push({
      agentRoot: entryPath,
      fallbackRuntimePath: resolveReleasePath(
        releaseDir,
        path.join(ownerManifest.agentRoot, "lib", extensionRuntimeFileName),
      ),
    });
    for (const nested of source.manifest.subagents) {
      collectExtensionSubagent(nested, ownerManifest);
    }
    collectMountedSubagents(source.manifest, collectExtensionSubagent);
  };

  const scanConsumerManifest = (current: ExtensionSubagentManifest): void => {
    collectMountedSubagents(current, collectExtensionSubagent);
    for (const local of current.subagents) scanConsumerManifest(local.manifest);
  };
  scanConsumerManifest(manifest);

  const runtimePath = path.join(releaseDir, runtimeRelativePath);
  if (!(await exists(runtimePath))) {
    throw new Error(
      `Extension observer injection requires the platform runtime at ${runtimeRelativePath}.`,
    );
  }
  const observerTargets = [
    ...new Map(agentRoots.map((entry) => [entry.agentRoot, entry] as const)).values(),
  ]
    .sort((left, right) => left.agentRoot.localeCompare(right.agentRoot))
    .map((entry) => ({
      observerPath: path.join(entry.agentRoot, "hooks", observerFileName),
      fallbackRuntimePath: entry.fallbackRuntimePath,
    }));
  const fallbackRuntimePaths = [
    ...new Set(observerTargets.map((target) => target.fallbackRuntimePath)),
  ];
  for (const fallbackRuntimePath of fallbackRuntimePaths) {
    if (await exists(fallbackRuntimePath)) {
      throw new Error(
        `Reserved Extension observer runtime already exists at ${releaseRelativePath(releaseDir, fallbackRuntimePath)}. Rename the authored file; Eveland will not overwrite it.`,
      );
    }
  }
  for (const { observerPath } of observerTargets) {
    if (await exists(observerPath)) {
      throw new Error(
        `Reserved observer hook already exists at ${releaseRelativePath(releaseDir, observerPath)}. Rename the Extension-authored file; Eveland will not overwrite it.`,
      );
    }
  }

  const runtime = await readFile(runtimePath, "utf8");
  for (const fallbackRuntimePath of fallbackRuntimePaths) {
    await mkdir(path.dirname(fallbackRuntimePath), { recursive: true });
    await writeFile(fallbackRuntimePath, runtime, "utf8");
  }
  const injectedFiles: string[] = [];
  for (const { observerPath, fallbackRuntimePath } of observerTargets) {
    await mkdir(path.dirname(observerPath), { recursive: true });
    await writeFile(
      observerPath,
      createObserverShim(observerPath, fallbackRuntimePath, true),
      "utf8",
    );
    injectedFiles.push(releaseRelativePath(releaseDir, observerPath));
  }
  return { injectedFiles, coverageGaps };
}

function createObserverShim(
  observerPath: string,
  runtimePath: string,
  staticFallback = false,
): string {
  let relativeRuntimePath = path
    .relative(path.dirname(observerPath), runtimePath)
    .split(path.sep)
    .join("/");
  if (!relativeRuntimePath.startsWith(".")) {
    relativeRuntimePath = `./${relativeRuntimePath}`;
  }
  const fallback = staticFallback
    ? [
        `import fallbackRuntime from ${JSON.stringify(relativeRuntimePath)};`,
        ``,
        `let runtime = { default: fallbackRuntime };`,
        `try {`,
        `  runtime = await import(${JSON.stringify(`file://${PLATFORM_OBSERVER_RUNTIME_PATH}`)});`,
        `} catch {}`,
      ]
    : [
        `let runtime;`,
        `try {`,
        `  runtime = await import(${JSON.stringify(`file://${PLATFORM_OBSERVER_RUNTIME_PATH}`)});`,
        `} catch {`,
        `  runtime = await import(${JSON.stringify(relativeRuntimePath)});`,
        `}`,
      ];
  return [
    `import { defineHook } from "eve/hooks";`,
    ``,
    `// Prefer the observer runtime the Eveland Worker delivers into the`,
    `// observability mount, so captured telemetry always matches the running`,
    `// platform; fall back to the bundle baked into this release when the Agent`,
    `// runs outside an Eveland deployment.`,
    ...fallback,
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
          "Every supported Eve line discovers file-form subagents but gives them no independent hooks slot; the parent stream exposes only control-plane child events.",
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

function collectMountedSubagents(
  manifest: ExtensionSubagentManifest,
  collect: (source: ExtensionSubagentSource, ownerManifest: ExtensionSubagentManifest) => void,
): void {
  for (const mount of [...manifest.resolvedExtensions].sort((left, right) =>
    left.namespace.localeCompare(right.namespace),
  )) {
    const ids = new Set<string>();
    const sources: Array<{
      source: ExtensionSubagentSource;
      ownerManifest: ExtensionSubagentManifest;
    }> = [
      ...(mount.overrides?.subagents.map((source) => ({
        source,
        ownerManifest: mount.overrides!,
      })) ?? []),
      ...mount.manifest.subagents.map((source) => ({
        source,
        ownerManifest: mount.manifest,
      })),
    ];
    for (const { source, ownerManifest } of sources) {
      if (ids.has(source.subagentId)) continue;
      ids.add(source.subagentId);
      collect(source, ownerManifest);
    }
  }
}

function readExtensionSubagentManifest(value: unknown): ExtensionSubagentManifest {
  if (!isExtensionSubagentManifest(value)) {
    throw new Error("Expected a well-formed Eve discovery manifest for Extension injection.");
  }
  return value;
}

function isExtensionSubagentManifest(value: unknown): value is ExtensionSubagentManifest {
  return (
    isRecord(value) &&
    typeof value.agentRoot === "string" &&
    Array.isArray(value.subagents) &&
    value.subagents.every(isExtensionSubagentSource) &&
    Array.isArray(value.resolvedExtensions) &&
    value.resolvedExtensions.every(isExtensionSubagentMount)
  );
}

function isExtensionSubagentSource(value: unknown): value is ExtensionSubagentSource {
  return (
    isRecord(value) &&
    typeof value.entryPath === "string" &&
    typeof value.logicalPath === "string" &&
    typeof value.subagentId === "string" &&
    isExtensionSubagentManifest(value.manifest)
  );
}

function isExtensionSubagentMount(value: unknown): value is ExtensionSubagentMount {
  return (
    isRecord(value) &&
    typeof value.namespace === "string" &&
    isExtensionSubagentManifest(value.manifest) &&
    (value.overrides === undefined || isExtensionSubagentManifest(value.overrides))
  );
}

function resolveReleasePath(releaseDir: string, target: string): string {
  const resolved = path.resolve(target);
  const relative = path.relative(releaseDir, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(
      `Extension source ${resolved} must stay inside the disposable Release directory ${releaseDir}.`,
    );
  }
  return resolved;
}

function releaseRelativePath(releaseDir: string, target: string): string {
  return path.relative(releaseDir, target).split(path.sep).join("/");
}

function isModulePath(target: string): boolean {
  return /\.(?:[cm]?[jt]s)$/.test(target);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
