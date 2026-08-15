import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ReleaseDiscovery } from "./types.js";
import { readSchedulerDefinitions, type SchedulerDefinition } from "@evelandhq/agent-scheduler";

/**
 * Eveland runs `eve info` after `eve build` to materialize the full discovery
 * manifest in the built app tree. Once a Release is built this artifact -- not
 * the platform's pre-install static file scan -- is the authority on what the
 * agent contains. Reading it is informational: a Release whose artifacts
 * cannot be read still deploys.
 */
export const DISCOVERY_MANIFEST_RELEASE_PATH = ".eve/discovery/agent-discovery-manifest.json";

export async function readReleaseDiscovery(
  releaseDir: string,
): Promise<ReleaseDiscovery | undefined> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      await readFile(path.join(releaseDir, DISCOVERY_MANIFEST_RELEASE_PATH), "utf8"),
    );
  } catch {
    return undefined;
  }
  return { manifest, resolvedEveVersion: await readResolvedEveVersion(releaseDir) };
}

export async function readReleaseSchedulerDefinitions(
  releaseDir: string,
): Promise<SchedulerDefinition[] | undefined> {
  try {
    return await readSchedulerDefinitions(releaseDir);
  } catch {
    return undefined;
  }
}

async function readResolvedEveVersion(releaseDir: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(
      await readFile(path.join(releaseDir, "node_modules", "eve", "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}
