import { createBuildInfoFromEnv } from "@eveland/core/server/build-info";
import { DEFAULT_TEAM_ID } from "@eveland/db";
import {
  resolvePlatformOtlpServiceToken,
  startPlatformObservability,
  startPrivateLogs,
  startPrivateMetrics,
} from "@eveland/platform-observability";

const buildInfo = createBuildInfoFromEnv("worker", process.env);

export const workerInstanceId =
  process.env.WORKER_ID ?? `worker-${process.pid}`;

const resource = {
  serviceName: "eveland-worker",
  serviceVersion: buildInfo.version,
  serviceInstanceId: workerInstanceId,
  environment:
    process.env.NODE_ENV === "production" ? "production" : "development",
  teamId: DEFAULT_TEAM_ID,
  otlpEndpoint:
    process.env.EVELAND_OTLP_ENDPOINT ?? "http://127.0.0.1:4318",
  otlpServiceToken: resolvePlatformOtlpServiceToken(process.env),
  metricExportIntervalMs: Number(
    process.env.EVELAND_OTEL_METRIC_INTERVAL_MS ?? 60_000,
  ),
};

export const platformObservability = startPlatformObservability({
  ...resource,
});

export const capacityObservability = startPrivateMetrics({
  ...resource,
  telemetryDomain: "capacity",
  hostMetrics: true,
});

export const runtimeObservability = startPrivateLogs({
  ...resource,
  telemetryDomain: "runtime",
});
