import os from "node:os";
import { createBuildInfoFromEnv } from "@evelandhq/core/server/build-info";
import { OTLP_ENDPOINT_FALLBACK } from "@evelandhq/core/ports";
import { DEFAULT_TEAM_ID } from "@evelandhq/db";
import {
  resolvePlatformOtlpServiceToken,
  startPlatformObservability,
} from "@evelandhq/platform-observability";

const buildInfo = createBuildInfoFromEnv("workflow-dispatcher", process.env);

export const platformObservability = startPlatformObservability({
  serviceName: "eveland-workflow-dispatcher",
  serviceVersion: buildInfo.version,
  serviceInstanceId: `${os.hostname()}:${process.pid}`,
  environment: process.env.NODE_ENV === "production" ? "production" : "development",
  teamId: DEFAULT_TEAM_ID,
  otlpEndpoint: process.env.EVELAND_OTLP_ENDPOINT ?? OTLP_ENDPOINT_FALLBACK,
  otlpServiceToken: resolvePlatformOtlpServiceToken(process.env),
  metricExportIntervalMs: Number(process.env.EVELAND_OTEL_METRIC_INTERVAL_MS ?? 60_000),
});
