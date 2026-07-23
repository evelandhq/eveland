import { describe, expect, test } from "vitest";
import type { BuiltInOtlpMetricPoint } from "./observability.js";
import {
  collectorExporterComponentId,
  summarizeCollectorDelivery,
} from "./observability.js";

const targets = [
  {
    id: "builtin",
    label: "Built-in",
    exporterId: "otlp_http/builtin",
    supportedSignals: ["traces", "logs", "metrics"] as const,
  },
  {
    id: "destination_elastic",
    label: "Elastic",
    exporterId: collectorExporterComponentId(
      "destination_elastic",
    ),
    supportedSignals: ["traces", "logs", "metrics"] as const,
  },
];

describe("Collector delivery diagnostics", () => {
  test("derives recent delivery deltas and queue pressure per exporter", () => {
    const points = [
      metric(
        "otelcol_exporter_sent_spans",
        100,
        "2026-07-23T12:00:00.000Z",
        "otlp_http/builtin",
      ),
      metric(
        "otelcol_exporter_sent_spans",
        112,
        "2026-07-23T12:00:15.000Z",
        "otlp_http/builtin",
      ),
      metric(
        "otelcol_exporter_queue_size",
        0,
        "2026-07-23T12:00:15.000Z",
        "otlp_http/builtin",
      ),
      metric(
        "otelcol_exporter_queue_capacity",
        10,
        "2026-07-23T12:00:15.000Z",
        "otlp_http/builtin",
      ),
      metric(
        "otelcol_exporter_sent_log_records",
        50,
        "2026-07-23T12:00:00.000Z",
        "otlp_http/destination_elastic",
        "exporter",
      ),
      metric(
        "otelcol_exporter_sent_log_records",
        55,
        "2026-07-23T12:00:15.000Z",
        "otlp_http/destination_elastic",
        "exporter",
      ),
      metric(
        "otelcol_exporter_send_failed_log_records",
        3,
        "2026-07-23T12:00:00.000Z",
        "otlp_http/destination_elastic",
      ),
      metric(
        "otelcol_exporter_send_failed_log_records",
        5,
        "2026-07-23T12:00:15.000Z",
        "otlp_http/destination_elastic",
      ),
      metric(
        "otelcol_exporter_queue_size",
        8,
        "2026-07-23T12:00:15.000Z",
        "otlp_http/destination_elastic",
      ),
      metric(
        "otelcol_exporter_queue_capacity",
        10,
        "2026-07-23T12:00:15.000Z",
        "otlp_http/destination_elastic",
      ),
    ];

    const diagnostics = summarizeCollectorDelivery(
      points,
      targets,
      new Date("2026-07-23T12:00:30.000Z"),
    );

    expect(diagnostics.destinations).toEqual([
      expect.objectContaining({
        id: "builtin",
        status: "healthy",
        observedAt: "2026-07-23T12:00:15.000Z",
        queue: {
          size: 0,
          capacity: 10,
          utilization: 0,
        },
        signals: expect.objectContaining({
          traces: {
            sent: 12,
            sendFailed: 0,
            enqueueFailed: 0,
          },
        }),
      }),
      expect.objectContaining({
        id: "destination_elastic",
        status: "degraded",
        queue: {
          size: 8,
          capacity: 10,
          utilization: 0.8,
        },
        signals: expect.objectContaining({
          logs: {
            sent: 5,
            sendFailed: 2,
            enqueueFailed: 0,
          },
        }),
      }),
    ]);
  });

  test("marks missing and stale Collector telemetry explicitly", () => {
    const missing = summarizeCollectorDelivery(
      [],
      targets,
      new Date("2026-07-23T12:00:30.000Z"),
    );
    expect(missing.destinations.map((entry) => entry.status)).toEqual([
      "waiting",
      "waiting",
    ]);

    const stale = summarizeCollectorDelivery(
      [
        metric(
          "otelcol_exporter_queue_size",
          0,
          "2026-07-23T11:55:00.000Z",
          "otlp_http/builtin",
        ),
      ],
      targets,
      new Date("2026-07-23T12:00:30.000Z"),
    );
    expect(stale.destinations[0]?.status).toBe("stale");
  });
});

function metric(
  name: string,
  value: number,
  timestamp: string,
  exporterId: string,
  componentAttribute = "otelcol.component.id",
): BuiltInOtlpMetricPoint {
  return {
    id: `${name}-${timestamp}-${exporterId}`,
    name,
    description: null,
    unit: null,
    dataType: name.includes("queue_") ? "gauge" : "sum",
    aggregationTemporality: name.includes("queue_") ? null : 2,
    monotonic: name.includes("queue_") ? null : true,
    startTimestamp: "2026-07-23T11:59:00.000Z",
    timestamp,
    scopeName: "go.opentelemetry.io/collector/exporter/exporterhelper",
    attributes: { [componentAttribute]: exporterId },
    value: { asDouble: value },
    resource: {
      serviceName: "eveland-otel-collector",
      domain: "platform",
      projectId: null,
      deploymentId: null,
      attributes: {},
    },
    payload: {},
    receivedAt: timestamp,
  };
}
