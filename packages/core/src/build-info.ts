export const EVELAND_VERSION = "0.24.0"; // x-release-please-version

export const evelandComponents = ["api", "gateway", "web", "worker"] as const;
export const evelandReleaseChannels = ["dev", "edge", "prerelease", "stable"] as const;

export type EvelandComponent = (typeof evelandComponents)[number];
export type EvelandReleaseChannel = (typeof evelandReleaseChannels)[number];

export type EvelandBuildInfo = {
  service: "eveland";
  component: EvelandComponent;
  version: string;
  revision: string;
  channel: EvelandReleaseChannel;
};

export function createBuildInfo(
  component: EvelandComponent,
  input: { revision: string; channel: EvelandReleaseChannel },
): EvelandBuildInfo {
  return {
    service: "eveland",
    component,
    version: EVELAND_VERSION,
    revision: input.revision,
    channel: input.channel,
  };
}

export function formatBuildInfo(buildInfo: EvelandBuildInfo): string {
  return `Eveland ${buildInfo.version} (${buildInfo.component}, ${buildInfo.channel}, ${buildInfo.revision})`;
}

export function isSameBuild(
  left: Pick<EvelandBuildInfo, "version" | "revision" | "channel">,
  right: Pick<EvelandBuildInfo, "version" | "revision" | "channel">,
): boolean {
  return (
    left.version === right.version &&
    left.revision === right.revision &&
    left.channel === right.channel
  );
}
