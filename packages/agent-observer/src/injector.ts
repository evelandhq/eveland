import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const observerFileName = "eveland-observer.js";
const runtimeRelativePath = ".eveland/observability/runtime.mjs";

export type ObserverCoverageGap = {
  kind: "file-form-subagent";
  path: string;
  reason: string;
};

export type ObserverInjectionResult = {
  injectedFiles: string[];
  runtimeFile?: string;
  coverageGaps: ObserverCoverageGap[];
};

export async function injectObserverHooks(input: {
  releaseDir: string;
}): Promise<ObserverInjectionResult> {
  const releaseDir = path.resolve(input.releaseDir);
  const nestedAgentRoot = path.join(releaseDir, "agent");
  const rootAgentRoot = (await isDirectory(nestedAgentRoot))
    ? nestedAgentRoot
    : releaseDir;
  const hasAgentRoot =
    rootAgentRoot === nestedAgentRoot ||
    (await hasRootInstructions(rootAgentRoot));

  if (!hasAgentRoot) return { injectedFiles: [], coverageGaps: [] };

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
  await build({
    entryPoints: [
      fileURLToPath(new URL("./hook-runtime.ts", import.meta.url)),
    ],
    outfile: runtimePath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["eve/hooks"],
    legalComments: "none",
  });

  const injectedFiles: string[] = [];
  for (const observerPath of observerPaths) {
    await mkdir(path.dirname(observerPath), { recursive: true });
    await writeFile(
      observerPath,
      createObserverShim(observerPath, runtimePath),
      "utf8",
    );
    injectedFiles.push(path.relative(releaseDir, observerPath));
  }

  return {
    injectedFiles,
    runtimeFile: runtimeRelativePath,
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
  return `export { default } from ${JSON.stringify(relativeRuntimePath)};\n`;
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
          "Eve 0.25.x, 0.26.x, and 0.27.x discover file-form subagents but give them no independent hooks slot; the parent stream exposes only control-plane child events.",
      });
    }
  }
}

async function hasAgentConfig(directory: string): Promise<boolean> {
  const entries = await readdir(directory).catch(() => []);
  return entries.some((name) => /^agent\.(?:[cm]?[jt]s)$/.test(name));
}

async function hasRootInstructions(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  return entries.some(
    (entry) =>
      (entry.isFile() &&
        /^instructions\.(?:md|[cm]?[jt]s)$/.test(entry.name)) ||
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
