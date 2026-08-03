import { describe, expect, test } from "vitest";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { createWorkerTelemetry } from "./worker-telemetry.js";

describe("worker telemetry", () => {
  test("surfaces host metric failures without retrying on every job poll", async () => {
    const metrics = createTestMetrics();
    let now = new Date("2026-07-18T10:00:00.000Z");
    let attempts = 0;
    const telemetry = createWorkerTelemetry(metrics.meter, {
      workerId: "worker-1",
      dataDir: "/missing",
      intervalMs: 5_000,
      metricIntervalMs: 60_000,
      now: () => now,
      collect: async () => {
        attempts += 1;
        throw new Error("statfs failed");
      },
    });

    await telemetry.publishTick({ durationMs: 80, error: null });
    now = new Date("2026-07-18T10:00:05.000Z");
    await telemetry.publishTick({ durationMs: 85, error: null });

    expect(attempts).toBe(1);
    await metrics.reader.forceFlush();
    expect(metricNames(metrics.exporter)).toContain("eveland.worker.capacity.collection.failures");
    await metrics.provider.shutdown();
  });

  test("publishes OTel worker and filesystem metrics on bounded cadences", async () => {
    const metrics = createTestMetrics();
    let now = new Date("2026-07-18T10:00:00.000Z");
    let collections = 0;
    const telemetry = createWorkerTelemetry(metrics.meter, {
      workerId: "worker-1",
      dataDir: "/var/lib/eveland",
      intervalMs: 5_000,
      metricIntervalMs: 60_000,
      startedAt: new Date("2026-07-18T09:00:00.000Z"),
      now: () => now,
      collect: async (workerId, _dataDir, cpuTimes) => {
        collections += 1;
        return {
          cpuTimes: { idle: collections * 10, total: collections * 20 },
          sample: {
            workerId,
            observedAt: now.toISOString(),
            cpuPercent: cpuTimes ? 50 : null,
            load1: 0.4,
            memoryTotalBytes: 16_000,
            memoryAvailableBytes: 8_000,
            diskTotalBytes: 100_000,
            diskAvailableBytes: 60_000,
            diskInodesTotal: 10_000,
            diskInodesAvailable: 9_000,
          },
        };
      },
    });

    await telemetry.publishTick({ durationMs: 80, error: null });
    now = new Date("2026-07-18T10:00:05.000Z");
    await telemetry.publishTick({
      durationMs: 90,
      error: new Error("database unavailable"),
    });

    expect(collections).toBe(1);

    now = new Date("2026-07-18T10:01:00.000Z");
    await telemetry.publishTick({ durationMs: 75, error: null });

    expect(collections).toBe(2);
    await metrics.reader.forceFlush();
    expect(metricNames(metrics.exporter)).toEqual(
      expect.arrayContaining([
        "eveland.worker.heartbeat",
        "eveland.worker.tick.duration",
        "eveland.worker.tick.failures",
        "system.filesystem.usage",
        "system.filesystem.limit",
        "system.filesystem.utilization",
        "eveland.system.filesystem.inodes.usage",
        "eveland.system.filesystem.inodes.limit",
        "eveland.host.load.1m",
      ]),
    );
    await metrics.provider.shutdown();
  });
});

function createTestMetrics() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000,
  });
  const provider = new MeterProvider({ readers: [reader] });
  return {
    exporter,
    reader,
    provider,
    meter: provider.getMeter("worker-telemetry-test"),
  };
}

function metricNames(exporter: InMemoryMetricExporter): string[] {
  return exporter
    .getMetrics()
    .flatMap((data) => data.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .map((metric) => metric.descriptor.name);
}
