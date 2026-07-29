import type { ObservabilitySignal } from "@eveland/core/observability";
import {
  arrayOfRecords,
  metricDataPoints,
} from "./values.js";

export function countOtlpSignalItems(
  signal: ObservabilitySignal,
  payload: Record<string, unknown>,
): number {
  if (signal === "traces") {
    return arrayOfRecords(payload.resourceSpans).reduce(
      (resourceTotal, resourceSpans) =>
        resourceTotal +
        arrayOfRecords(resourceSpans.scopeSpans).reduce(
          (scopeTotal, scopeSpans) =>
            scopeTotal + arrayOfRecords(scopeSpans.spans).length,
          0,
        ),
      0,
    );
  }
  if (signal === "logs") {
    return arrayOfRecords(payload.resourceLogs).reduce(
      (resourceTotal, resourceLogs) =>
        resourceTotal +
        arrayOfRecords(resourceLogs.scopeLogs).reduce(
          (scopeTotal, scopeLogs) =>
            scopeTotal +
            arrayOfRecords(scopeLogs.logRecords).length,
          0,
        ),
      0,
    );
  }
  return arrayOfRecords(payload.resourceMetrics).reduce(
    (resourceTotal, resourceMetrics) =>
      resourceTotal +
      arrayOfRecords(resourceMetrics.scopeMetrics).reduce(
        (scopeTotal, scopeMetrics) =>
          scopeTotal +
          arrayOfRecords(scopeMetrics.metrics).reduce(
            (metricTotal, metric) =>
              metricTotal + metricDataPoints(metric).length,
            0,
          ),
        0,
      ),
    0,
  );
}

export function createOtlpPartialSuccessResponse(
  signal: ObservabilitySignal,
  rejectedItems: number,
): Record<string, unknown> {
  if (rejectedItems <= 0) return {};
  const rejectedField = {
    traces: "rejectedSpans",
    logs: "rejectedLogRecords",
    metrics: "rejectedDataPoints",
  }[signal];
  return {
    partialSuccess: {
      [rejectedField]: String(rejectedItems),
      errorMessage:
        "Telemetry items were rejected because required Eveland resource or OTLP signal fields were missing.",
    },
  };
}
