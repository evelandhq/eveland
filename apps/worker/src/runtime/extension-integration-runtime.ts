import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { injectExtensionSubagentHooks, type ObserverCoverageGap } from "@evelandhq/agent-observer";
import { injectExtensionSchedules } from "@evelandhq/agent-scheduler";

const discoveryManifestPath = ".eve/discovery/agent-discovery-manifest.json";
export const EXTENSION_COVERAGE_GAPS_RELEASE_PATH =
  ".eveland/observability/extension-coverage-gaps.json";

export async function runExtensionIntegration(releaseDir: string): Promise<{
  observerFiles: string[];
  observerCoverageGaps: ObserverCoverageGap[];
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
  const observerCoverageGaps = observer.coverageGaps.map((gap) => ({
    ...gap,
    path: path.relative(resolvedReleaseDir, gap.path).split(path.sep).join("/"),
  }));
  const coverageArtifactPath = path.join(resolvedReleaseDir, EXTENSION_COVERAGE_GAPS_RELEASE_PATH);
  await mkdir(path.dirname(coverageArtifactPath), { recursive: true });
  await writeFile(
    coverageArtifactPath,
    `${JSON.stringify(observerCoverageGaps, null, 2)}\n`,
    "utf8",
  );
  return {
    observerFiles: observer.injectedFiles,
    observerCoverageGaps,
    scheduleFiles: scheduler.transformedFiles,
    scheduleDefinitions: scheduler.definitions.length,
  };
}
