import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ReleaseDiscovery } from "./types.js";

/**
 * eve writes its discovery manifest into the app tree during `eve build`; once
 * a release is built this artifact -- not the platform's pre-install static file
 * scan -- is the authority on what the agent contains. Reading it is
 * informational: a release whose artifacts cannot be read still deploys.
 */
export const DISCOVERY_MANIFEST_RELEASE_PATH = ".eve/discovery/agent-discovery-manifest.json";

export async function readReleaseDiscovery(releaseDir: string): Promise<ReleaseDiscovery | undefined> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(path.join(releaseDir, DISCOVERY_MANIFEST_RELEASE_PATH), "utf8"));
  } catch {
    return undefined;
  }
  return { manifest, resolvedEveVersion: await readResolvedEveVersion(releaseDir) };
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
