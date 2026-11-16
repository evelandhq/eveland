import { realpathSync } from "node:fs";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { AGENT_RUNTIME_POLICY_PATH } from "@evelandhq/core/observability";

const observerStem = "eveland-observer";
const observerFileName = `${observerStem}.js`;
const runtimeRelativePath = ".eveland/observability/runtime.mjs";

export const OBSERVER_RUNTIME_FILE_NAME = "runtime.mjs";

/**
 * Container-absolute path of the Worker-delivered observer runtime: it lives
 * next to agent-policy.json in the read-only observability mount every
 * deployment receives. Shims baked into releases import this path first, so
 * the observer logic always matches the running Eveland instead of being
 * frozen at release build time. The file's default export is a plain Eve hook
 * configuration and its `instrumentation` export a plain instrumentation
 * configuration; a release's shims consume exactly that shape, so an
 * incompatible runtime change requires a NEW file name, never a changed
 * export shape.
 *
 * The hook shims and the instrumentation shim share state (the model each
 * provider call ran) only because they import this one URL at run time. The
 * path therefore exists only inside a deployment, never during `eve build`:
 * eve's bundler inlines a file URL it can resolve, which would give every
 * shim its own copy of the runtime.
 */
export const PLATFORM_OBSERVER_RUNTIME_PATH = path.posix.join(
  path.posix.dirname(AGENT_RUNTIME_POLICY_PATH),
  OBSERVER_RUNTIME_FILE_NAME,
);

/**
 * Version of the observer delivery contract embedded in a release. Bump only
 * when a release must be REBUILT to keep observability working (i.e. the shim
 * contract itself changes). A release on this contract carries the hook shims
 * and the instrumentation shim that reports the model each provider call ran.
 */
export const OBSERVER_RUNTIME_CONTRACT = 4;

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
  bundledRuntime ??= bundleObserverRuntimeEntry(
    fileURLToPath(new URL("./hook-runtime.ts", import.meta.url)),
  );
  bundledRuntime.catch(() => {
    // Do not cache a failed build; the next caller retries.
    bundledRuntime = undefined;
  });
  return bundledRuntime;
}

/** Bundles a runtime entry module the way the delivered observer runtime is bundled. */
export function bundleObserverRuntimeEntry(entryPoint: string): Promise<string> {
  return build({
    entryPoints: [entryPoint],
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
      js: 'import { createRequire as __eveland_createRequire } from "node:module"; import { pathToFileURL as __eveland_pathToFileURL } from "node:url"; const require = __eveland_createRequire(import.meta.url.startsWith("file:") ? import.meta.url : __eveland_pathToFileURL(`${process.cwd()}/`).href);',
    },
  }).then((result) => {
    const file = result.outputFiles[0];
    if (!file) throw new Error("Observer runtime bundle produced no output.");
    return file.text;
  });
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
  // eve names an instrumentation file by its stem, so any extension collides.
  const instrumentationDir = path.join(rootAgentRoot, "instrumentation");
  const reservedInstrumentation = (await readdir(instrumentationDir).catch(() => [])).find(
    (name) => path.parse(name).name === observerStem,
  );
  if (reservedInstrumentation !== undefined) {
    throw new Error(
      `Reserved instrumentation file ${releaseRelativePath(releaseDir, path.join(instrumentationDir, reservedInstrumentation))} already exists. Rename the authored file; Eveland will not overwrite it.`,
    );
  }

  const runtimePath = path.join(releaseDir, runtimeRelativePath);
  await mkdir(path.dirname(runtimePath), { recursive: true });
  await writeFile(runtimePath, await bundleObserverRuntime(), "utf8");

  const injectedFiles: string[] = [];
  for (const observerPath of observerPaths) {
    await mkdir(path.dirname(observerPath), { recursive: true });
    await writeFile(observerPath, createObserverShim(observerPath, runtimePath), "utf8");
    injectedFiles.push(releaseRelativePath(releaseDir, observerPath));
  }
  // Instrumentation is root-only in eve and receives every session the
  // process runs, subagents included, so one file serves the whole tree.
  const instrumentationPath = path.join(instrumentationDir, observerFileName);
  await mkdir(instrumentationDir, { recursive: true });
  await writeFile(
    instrumentationPath,
    createObserverInstrumentationShim(instrumentationPath, runtimePath),
    "utf8",
  );
  injectedFiles.push(releaseRelativePath(releaseDir, instrumentationPath));

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
  const agentRoots: string[] = [];
  const coverageGaps: ObserverCoverageGap[] = [];

  const collectExtensionSubagent = (source: ExtensionSubagentSource): void => {
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
    agentRoots.push(entryPath);
    for (const nested of source.manifest.subagents) collectExtensionSubagent(nested);
    collectMountedSubagents(source.manifest, collectExtensionSubagent);
  };

  const scanConsumerManifest = (current: ExtensionSubagentManifest): void => {
    collectMountedSubagents(current, collectExtensionSubagent);
    for (const local of current.subagents) scanConsumerManifest(local.manifest);
  };
  scanConsumerManifest(manifest);

  const observerPaths = [...new Set(agentRoots)]
    .sort((left, right) => left.localeCompare(right))
    .map((agentRoot) => path.join(agentRoot, "hooks", observerFileName));
  for (const observerPath of observerPaths) {
    if (await exists(observerPath)) {
      throw new Error(
        `Reserved observer hook already exists at ${releaseRelativePath(releaseDir, observerPath)}. Rename the Extension-authored file; Eveland will not overwrite it.`,
      );
    }
  }

  // The hook shim is the only file written into an installed Extension
  // package. It carries no runtime copy: it loads the runtime from the
  // platform mount, which also holds the policy, so without the mount there
  // is no telemetry to capture and the hook stays inert.
  const injectedFiles: string[] = [];
  for (const observerPath of observerPaths) {
    await mkdir(path.dirname(observerPath), { recursive: true });
    await writeFile(observerPath, createObserverShim(observerPath, undefined), "utf8");
    injectedFiles.push(releaseRelativePath(releaseDir, observerPath));
  }
  return { injectedFiles, coverageGaps };
}

/**
 * The hook shim baked into a release. It prefers the observer runtime the
 * Eveland Worker delivers into the observability mount, so captured telemetry
 * always matches the running platform. With a `fallbackRuntimePath` it falls
 * back to the bundle baked into the release; without one (an installed
 * Extension package) it is inert when the mount is absent.
 */
export function createObserverShim(
  observerPath: string,
  fallbackRuntimePath: string | undefined,
  platformRuntimeUrl = `file://${PLATFORM_OBSERVER_RUNTIME_PATH}`,
): string {
  return [
    `import { defineHook } from "eve/hooks";`,
    ``,
    ...runtimeImport(observerPath, fallbackRuntimePath, platformRuntimeUrl),
    ``,
    `export default defineHook(runtime?.default ?? { events: { "*"() {} } });`,
    ``,
  ].join("\n");
}

/**
 * The root instrumentation shim. It wraps the runtime's `instrumentation`
 * export, from the same module the hook shims import, so the model each
 * provider call ran reaches the hook that exports the run's usage.
 */
export function createObserverInstrumentationShim(
  shimPath: string,
  fallbackRuntimePath: string,
  platformRuntimeUrl = `file://${PLATFORM_OBSERVER_RUNTIME_PATH}`,
): string {
  return [
    `import { defineInstrumentation } from "eve/instrumentation";`,
    ``,
    ...runtimeImport(shimPath, fallbackRuntimePath, platformRuntimeUrl),
    ``,
    `export default defineInstrumentation(runtime?.instrumentation ?? { events: {} });`,
    ``,
  ].join("\n");
}

function runtimeImport(
  shimPath: string,
  fallbackRuntimePath: string | undefined,
  platformRuntimeUrl: string,
): string[] {
  const fallback =
    fallbackRuntimePath === undefined
      ? `  runtime = undefined;`
      : `  runtime = await import(${JSON.stringify(relativeSpecifier(shimPath, fallbackRuntimePath))});`;
  return [
    `let runtime;`,
    `try {`,
    `  runtime = await import(${JSON.stringify(platformRuntimeUrl)});`,
    `} catch {`,
    fallback,
    `}`,
  ];
}

function relativeSpecifier(from: string, target: string): string {
  const relative = path.relative(path.dirname(from), target).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
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
  collect: (source: ExtensionSubagentSource) => void,
): void {
  for (const mount of [...manifest.resolvedExtensions].sort((left, right) =>
    left.namespace.localeCompare(right.namespace),
  )) {
    // A consumer override replaces the Extension's subagent of the same id.
    const ids = new Set<string>();
    for (const source of [...(mount.overrides?.subagents ?? []), ...mount.manifest.subagents]) {
      if (ids.has(source.subagentId)) continue;
      ids.add(source.subagentId);
      collect(source);
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
    Boolean(value.namespace) &&
    isExtensionSubagentManifest(value.manifest) &&
    (value.overrides === undefined || isExtensionSubagentManifest(value.overrides))
  );
}

function resolveReleasePath(releaseDir: string, target: string): string {
  const resolved = path.resolve(target);
  const canonical = canonicalizeExistingAncestor(resolved);
  if (!isPathInside(releaseDir, resolved) || !isPathInside(realpathSync(releaseDir), canonical)) {
    throw new Error(
      `Extension source ${resolved} must stay inside the disposable Release directory ${releaseDir}.`,
    );
  }
  return resolved;
}

function canonicalizeExistingAncestor(target: string): string {
  let candidate = target;
  for (;;) {
    try {
      const suffix = path.relative(candidate, target);
      return path.resolve(realpathSync(candidate), suffix);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    Boolean(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
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
