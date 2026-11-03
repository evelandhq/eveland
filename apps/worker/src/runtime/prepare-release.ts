import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { injectObserverHooks, type ObserverInjectionResult } from "@evelandhq/agent-observer";
import { eveLineOfSpecifier } from "@evelandhq/core/eve-compatibility";
import { injectSchedulerAdapter, type SchedulerInjectionResult } from "@evelandhq/agent-scheduler";
import { execa } from "execa";
import { injectExtensionIntegrator } from "./extension-integration.js";
import {
  loadModelCatalog,
  seedModelCatalog,
  type ModelCatalogLoadResult,
} from "./model-catalog-cache.js";
import { injectModelGateway, type ModelGatewayInjectionResult } from "./model-gateway-injection.js";
import {
  injectWorkflowWorld,
  type WorkflowWorldBuildConfig,
  type WorkflowWorldInjectionResult,
} from "./workflow-world.js";

export type PreparedReleaseResult = ObserverInjectionResult & {
  extensionIntegratorFile?: string;
  workflowWorld?: WorkflowWorldInjectionResult;
  scheduler: SchedulerInjectionResult;
  modelGateway: ModelGatewayInjectionResult;
  /** Absent when the caller has no catalog cache to offer (tests, smoke paths). */
  modelCatalog?: ModelCatalogLoadResult;
};

export async function prepareReleaseTree(input: {
  sourcePath: string;
  buildDir: string;
  workflowWorld?: WorkflowWorldBuildConfig;
  /** The Worker's daily AI Gateway model catalog cache; see ./model-catalog-cache.ts. */
  modelCatalogCacheFile?: string;
  fetchModelCatalog?: (input: string, init?: RequestInit) => Promise<Response>;
}): Promise<PreparedReleaseResult> {
  const sourcePath = path.resolve(input.sourcePath);
  const buildDir = path.resolve(input.buildDir);
  if (sourcePath === buildDir)
    throw new Error("Prepared release directory must be distinct from the imported source tree.");

  await mkdir(buildDir, { recursive: true });
  await execa("cp", ["-a", `${sourcePath}/.`, buildDir]);
  const observer = await injectObserverHooks({ releaseDir: buildDir });
  const workflowWorld = input.workflowWorld
    ? await injectWorkflowWorld({ releaseDir: buildDir, config: input.workflowWorld })
    : undefined;
  const scheduler = await injectSchedulerAdapter({ releaseDir: buildDir });
  const modelGateway = await injectModelGateway({
    releaseDir: buildDir,
    eveVersion: eveLineOfSpecifier(await declaredEveSpecifier(buildDir)) ?? "",
  });
  const modelCatalog = input.modelCatalogCacheFile
    ? await loadModelCatalog({
        cacheFile: input.modelCatalogCacheFile,
        ...(input.fetchModelCatalog ? { fetchImpl: input.fetchModelCatalog } : {}),
      })
    : undefined;
  if (modelCatalog && modelCatalog.source !== "unavailable") {
    await seedModelCatalog({ releaseDir: buildDir, catalog: modelCatalog.catalog });
  }
  const extensionIntegratorFile = (await hasExtensionMountSources(buildDir))
    ? await injectExtensionIntegrator(buildDir)
    : undefined;
  return {
    ...observer,
    ...(extensionIntegratorFile ? { extensionIntegratorFile } : {}),
    ...(workflowWorld ? { workflowWorld } : {}),
    scheduler,
    modelGateway,
    ...(modelCatalog ? { modelCatalog } : {}),
  };
}

/** Build-log lines for the Model Gateway and model-catalog steps of release preparation. */
export function preparedReleaseLogLines(result: PreparedReleaseResult): string[] {
  const lines: string[] = [];
  if (result.modelGateway.status === "injected") {
    lines.push(
      `Injected Eveland Model Gateway provider: ${result.modelGateway.injectedFiles.join(", ")}`,
    );
  } else if (result.modelGateway.reason === "eve-version") {
    lines.push(
      "WARNING: the Model Gateway provider needs eve 1.0 or later, so this release calls models exactly as authored. Upgrade eve to route string model IDs through the platform Model Gateway.",
    );
  }
  const catalog = result.modelCatalog;
  if (catalog?.source === "cache" || catalog?.source === "fetched") {
    lines.push(`Model catalog: Eveland cache fetched at ${catalog.catalog.fetchedAt}`);
  } else if (catalog?.source === "stale-cache") {
    lines.push(
      `WARNING: could not refresh the AI Gateway model catalog (${catalog.error}); using Eveland's cache fetched at ${catalog.catalog.fetchedAt}.`,
    );
  } else if (catalog?.source === "unavailable") {
    lines.push(
      `WARNING: the AI Gateway model catalog is unavailable (${catalog.error}); eve will try to fetch it during the build.`,
    );
  }
  return lines;
}

async function declaredEveSpecifier(releaseDir: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(path.join(releaseDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return manifest.dependencies?.eve ?? manifest.devDependencies?.eve ?? null;
  } catch {
    return null;
  }
}

async function hasExtensionMountSources(releaseDir: string): Promise<boolean> {
  const nestedAgentRoot = path.join(releaseDir, "agent");
  const agentRoot = (await isDirectory(nestedAgentRoot)) ? nestedAgentRoot : releaseDir;
  return agentTreeHasExtensions(agentRoot);
}

async function agentTreeHasExtensions(agentRoot: string): Promise<boolean> {
  const extensionEntries = await readdir(path.join(agentRoot, "extensions"), {
    withFileTypes: true,
  }).catch(() => []);
  if (extensionEntries.length > 0) return true;

  const subagents = await readdir(path.join(agentRoot, "subagents"), {
    withFileTypes: true,
  }).catch(() => []);
  for (const subagent of subagents) {
    if (
      subagent.isDirectory() &&
      (await agentTreeHasExtensions(path.join(agentRoot, "subagents", subagent.name)))
    ) {
      return true;
    }
  }
  return false;
}

async function isDirectory(target: string): Promise<boolean> {
  return readdir(target).then(
    () => true,
    () => false,
  );
}
