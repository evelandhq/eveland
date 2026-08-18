import type { DeploymentRecord, ReleaseWorkflowAttestation } from "@evelandhq/core/contracts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { deriveWorkflowWorldAttestation } from "../runtime/workflow-world.js";

/**
 * Historical Release classification from the immutable artifact — never from
 * the worker's environment, the Project's current route, or the most recent
 * Release.
 *
 * A systemd Release is a directory on disk whose `imageTag` is the release
 * ref. Release preparation wrote a generated root agent config that names the
 * injected world (`world: "<package>"`), and the injected package's manifest
 * sits in the release's own `node_modules`. Both are read back here; either
 * missing or unparsable keeps the Release `unknown` — an unclassifiable
 * artifact is quarantined, not guessed at.
 *
 * Docker artifacts are images; reading their filesystem needs the Docker
 * daemon and is deliberately not implemented here. They stay `unknown` for
 * explicit operator disposition, and the cutover report names each one.
 */
export type ArtifactClassifier = (input: {
  releaseRef: string;
  runtimeKind: DeploymentRecord["runtimeKind"];
}) => Promise<ReleaseWorkflowAttestation | null>;

const WORLD_PATTERN = /world:\s*"((?:@[\w.-]+\/)?[\w.-]+)"/;

export const classifyArtifactFromFilesystem: ArtifactClassifier = async (input) => {
  if (input.runtimeKind !== "systemd") return null;
  const releaseDir = path.resolve(input.releaseRef);
  const agentConfig = await readFirst([
    path.join(releaseDir, "agent", "agent.ts"),
    path.join(releaseDir, "agent.ts"),
  ]);
  if (!agentConfig) return null;
  const worldMatch = WORLD_PATTERN.exec(agentConfig);
  if (!worldMatch) return null;
  const packageName = worldMatch[1]!;
  const manifestRaw = await readFirst([
    path.join(releaseDir, "node_modules", packageName, "package.json"),
  ]);
  if (!manifestRaw) return null;
  let packageVersion: string;
  try {
    const manifest = JSON.parse(manifestRaw) as { name?: unknown; version?: unknown };
    if (manifest.name !== packageName || typeof manifest.version !== "string") return null;
    packageVersion = manifest.version;
  } catch {
    return null;
  }
  return deriveWorkflowWorldAttestation({ packageName, packageVersion });
};

async function readFirst(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      // keep looking
    }
  }
  return null;
}
