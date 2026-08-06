import {
  createBuildInfo,
  evelandReleaseChannels,
  type EvelandComponent,
  type EvelandReleaseChannel,
} from "@evelandhq/core/build-info";

export function createBuildInfoFromEnv(
  component: EvelandComponent,
  environment: Record<string, string | undefined>,
) {
  const configuredChannel = environment.EVELAND_RELEASE_CHANNEL;
  const channel: EvelandReleaseChannel = evelandReleaseChannels.includes(
    configuredChannel as EvelandReleaseChannel,
  )
    ? (configuredChannel as EvelandReleaseChannel)
    : "dev";

  return createBuildInfo(component, {
    revision: environment.EVELAND_REVISION?.trim() || "unknown",
    channel,
  });
}
