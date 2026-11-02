"use client";

import { eveSessionProtocolOfVersion } from "@evelandhq/core/eve-compatibility";
import type { EveVersionInfo } from "@/lib/api";
import { PlaygroundPanelV26 } from "@/components/playground-panel-v26";
import { PlaygroundPanelV27 } from "@/components/playground-panel-v27";

type PlaygroundPanelProps = {
  projectId: string;
  eveVersion: EveVersionInfo;
};

/**
 * The supported window spans two session protocols, and neither eve client
 * reads the other's stream: eve 0.83's reads versions 21-26 only and eve
 * 1.0's reads 27 only. The Playground therefore bundles both and renders the
 * one that matches the Eve the project's current Deployment runs. A version
 * the policy cannot place (none deployed yet, or an unsupported one, which the
 * panel refuses anyway) takes the newest protocol.
 */
export function playgroundProtocolFor(eveVersion: EveVersionInfo): "v26" | "v27" {
  return eveSessionProtocolOfVersion(eveVersion.version) ?? "v27";
}

export function PlaygroundPanel({ projectId, eveVersion }: PlaygroundPanelProps) {
  return playgroundProtocolFor(eveVersion) === "v26" ? (
    <PlaygroundPanelV26 eveVersion={eveVersion} projectId={projectId} />
  ) : (
    <PlaygroundPanelV27 eveVersion={eveVersion} projectId={projectId} />
  );
}
