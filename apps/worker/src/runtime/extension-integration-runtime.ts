import { readFile } from "node:fs/promises";
import path from "node:path";
import { injectExtensionSubagentHooks } from "@evelandhq/agent-observer";
import { injectExtensionSchedules } from "@evelandhq/agent-scheduler";

const discoveryManifestPath = ".eve/discovery/agent-discovery-manifest.json";

export async function runExtensionIntegration(releaseDir: string): Promise<{
  observerFiles: string[];
  observerCoverageGaps: number;
  scheduleFiles: string[];
  scheduleDefinitions: number;
}> {
  const resolvedReleaseDir = path.resolve(releaseDir);
  const manifest = JSON.parse(
    await readFile(path.join(resolvedReleaseDir, discoveryManifestPath), "utf8"),
  ) as unknown;
  const observer = await injectExtensionSubagentHooks({
    releaseDir: resolvedReleaseDir,
    manifest,
  });
  const scheduler = await injectExtensionSchedules({
    releaseDir: resolvedReleaseDir,
    manifest,
  });
  return {
    observerFiles: observer.injectedFiles,
    observerCoverageGaps: observer.coverageGaps.length,
    scheduleFiles: scheduler.transformedFiles,
    scheduleDefinitions: scheduler.definitions.length,
  };
}
