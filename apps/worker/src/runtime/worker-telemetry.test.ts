import { describe, expect, test } from "vitest";
import { createMemoryStore } from "@eveland/db";
import { createWorkerTelemetry } from "./worker-telemetry.js";

describe("worker telemetry", () => {
  test("surfaces host metric failures without retrying on every job poll", async () => {
    const store = createMemoryStore();
    let now = new Date("2026-07-18T10:00:00.000Z");
    let attempts = 0;
    const telemetry = createWorkerTelemetry(store, {
      workerId: "worker-1",
      dataDir: "/missing",
      intervalMs: 5_000,
      metricIntervalMs: 60_000,
      retentionMs: 30 * 86_400_000,
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
    await expect(store.listWorkerHeartbeats()).resolves.toEqual([
      expect.objectContaining({ lastError: "Host capacity metrics are unavailable; inspect Worker logs." }),
    ]);
  });

  test("publishes every heartbeat while sampling and pruning metrics on bounded cadences", async () => {
    const store = createMemoryStore();
    let now = new Date("2026-07-18T10:00:00.000Z");
    let collections = 0;
    const telemetry = createWorkerTelemetry(store, {
      workerId: "worker-1",
      dataDir: "/var/lib/eveland",
      intervalMs: 5_000,
      metricIntervalMs: 60_000,
      retentionMs: 30 * 86_400_000,
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
    await telemetry.publishTick({ durationMs: 90, error: new Error("database unavailable") });

    expect(collections).toBe(1);
    await expect(store.listWorkerHeartbeats()).resolves.toEqual([
      expect.objectContaining({
        observedAt: "2026-07-18T10:00:05.000Z",
        lastTickDurationMs: 90,
        lastError: "Worker tick failed; inspect Worker logs.",
      }),
    ]);
    await expect(store.listHostMetrics({ limit: 100 })).resolves.toHaveLength(1);

    now = new Date("2026-07-18T10:01:00.000Z");
    await telemetry.publishTick({ durationMs: 75, error: null });

    expect(collections).toBe(2);
    await expect(store.listHostMetrics({ limit: 100 })).resolves.toHaveLength(2);
  });
});
