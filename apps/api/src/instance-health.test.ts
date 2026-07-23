import { describe, expect, test } from "vitest";
import { createTestStore } from "@eveland/db/vitest";
import { collectInstanceHealth, probeGatewayHealth } from "./instance-health.js";

describe("instance health diagnostics", () => {
  test("probes the Gateway health endpoint without exposing internal credentials", async () => {
    const health = await probeGatewayHealth(
      { EVELAND_GATEWAY_INTERNAL_URL: "http://gateway:4080" },
      async (input) => {
        expect(String(input)).toBe("http://gateway:4080/health");
        return new Response(JSON.stringify({ ok: true, component: "gateway" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      () => new Date("2026-07-18T10:00:00.000Z"),
    );

    expect(health).toEqual({
      status: "healthy",
      message: "Gateway health endpoint is reachable.",
      observedAt: "2026-07-18T10:00:00.000Z",
    });
  });

  test("combines component reachability, OTLP ingestion, host capacity, and workload", async () => {
    const store = createTestStore();
    await store.upsertWorkerHeartbeat({
      workerId: "worker-1",
      startedAt: "2026-07-18T08:00:00.000Z",
      observedAt: "2026-07-18T09:59:55.000Z",
      intervalMs: 5_000,
      lastTickDurationMs: 70,
      lastError: null,
    });
    await store.recordHostMetric({
      workerId: "worker-1",
      observedAt: "2026-07-18T09:59:30.000Z",
      cpuPercent: 32,
      load1: 0.7,
      memoryTotalBytes: 16_000,
      memoryAvailableBytes: 8_000,
      diskTotalBytes: 100_000,
      diskAvailableBytes: 60_000,
      diskInodesTotal: 10_000,
      diskInodesAvailable: 8_000,
    });
    await store.ingestOtlpMetricPoints([
      collectorSelfMetric("2026-07-18T09:59:45.000Z"),
    ]);

    const report = await collectInstanceHealth(store, {
      now: () => new Date("2026-07-18T10:00:00.000Z"),
      historyHours: 24,
      gatewayHealth: async () => ({
        status: "healthy",
        message: "Gateway internal diagnostics are reachable.",
        observedAt: "2026-07-18T10:00:00.000Z",
      }),
    });

    expect(report.status).toBe("healthy");
    expect(report.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "api", status: "healthy" }),
      expect.objectContaining({ key: "postgres", status: "healthy" }),
      expect.objectContaining({ key: "gateway", status: "healthy" }),
      expect.objectContaining({ key: "worker", status: "healthy" }),
      expect.objectContaining({ key: "collector", status: "healthy" }),
    ]));
    expect(report.capacity.overall).toBe("healthy");
    expect(report.metrics).toHaveLength(1);
    expect(report.workload.queuedJobs).toBe(0);
  });

  test("reports stale workers and unreachable Gateway without guessing healthy", async () => {
    const store = createTestStore();
    await store.upsertWorkerHeartbeat({
      workerId: "worker-1",
      startedAt: "2026-07-18T08:00:00.000Z",
      observedAt: "2026-07-18T09:55:00.000Z",
      intervalMs: 5_000,
      lastTickDurationMs: 70,
      lastError: null,
    });

    const report = await collectInstanceHealth(store, {
      now: () => new Date("2026-07-18T10:00:00.000Z"),
      historyHours: 24,
      gatewayHealth: async () => ({
        status: "unavailable",
        message: "Gateway diagnostics are unavailable.",
        observedAt: null,
      }),
    });

    expect(report.status).toBe("unavailable");
    expect(report.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "gateway", status: "unavailable" }),
      expect.objectContaining({ key: "worker", status: "unavailable" }),
    ]));
  });

  test("marks stale Collector self-metrics unavailable even when other telemetry was received", async () => {
    const store = createTestStore();
    await store.ingestOtlpBatch({
      signal: "traces",
      payload: { resourceSpans: [] },
    });
    await store.ingestOtlpMetricPoints([
      collectorSelfMetric("2026-07-18T09:55:00.000Z"),
    ]);

    const report = await collectInstanceHealth(store, {
      now: () => new Date("2026-07-18T10:00:00.000Z"),
      historyHours: 24,
      gatewayHealth: async () => ({
        status: "healthy",
        message: "Gateway diagnostics are reachable.",
        observedAt: "2026-07-18T10:00:00.000Z",
      }),
    });

    expect(report.components).toContainEqual(
      expect.objectContaining({
        key: "collector",
        status: "unavailable",
        observedAt: "2026-07-18T09:55:00.000Z",
      }),
    );
  });
});

function collectorSelfMetric(timestamp: string) {
  return {
    name: "otelcol_process_uptime",
    description: "Collector uptime.",
    unit: "s",
    dataType: "sum" as const,
    aggregationTemporality: 2,
    monotonic: true,
    startTimestamp: "2026-07-18T09:00:00.000Z",
    timestamp,
    scopeName: "go.opentelemetry.io/collector/service",
    attributes: {},
    value: { asDouble: 3_600 },
    resource: {
      serviceName: "eveland-otel-collector",
      domain: "platform" as const,
      projectId: null,
      deploymentId: null,
      attributes: {},
    },
    payload: {},
  };
}
