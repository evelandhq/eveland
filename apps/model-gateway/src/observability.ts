import os from "node:os";
import { createBuildInfoFromEnv } from "@evelandhq/core/server/build-info";
import { DEFAULT_TEAM_ID } from "@evelandhq/db";
import {
  resolvePlatformOtlpServiceToken,
  startPlatformObservability,
} from "@evelandhq/platform-observability";

const buildInfo = createBuildInfoFromEnv("model-gateway", process.env);

export const platformObservability = startPlatformObservability({
  serviceName: "eveland-model-gateway",
  serviceVersion: buildInfo.version,
  serviceInstanceId: `${os.hostname()}:${process.pid}`,
  environment: process.env.NODE_ENV === "production" ? "production" : "development",
  teamId: DEFAULT_TEAM_ID,
  otlpEndpoint: process.env.EVELAND_OTLP_ENDPOINT ?? "http://127.0.0.1:4318",
  otlpServiceToken: resolvePlatformOtlpServiceToken(process.env),
  metricExportIntervalMs: Number(process.env.EVELAND_OTEL_METRIC_INTERVAL_MS ?? 60_000),
});
