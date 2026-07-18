import { describe, expect, test } from "vitest";
import type { HostMetricSample, WorkerHeartbeat } from "@eveland/core/instance-health";
import { createMemoryStore } from "./store.js";

function heartbeat(overrides: Partial<WorkerHeartbeat> = {}): WorkerHeartbeat {
  return {
    workerId: "worker-1",
    startedAt: "2026-07-18T08:00:00.000Z",
    observedAt: "2026-07-18T10:00:00.000Z",
    intervalMs: 5_000,
    lastTickDurationMs: 70,
    lastError: null,
    ...overrides,
  };
}

function metric(observedAt: string, workerId = "worker-1"): Omit<HostMetricSample, "id"> {
  return {
    workerId,
    observedAt,
    cpuPercent: 25,
    load1: 0.5,
    memoryTotalBytes: 16_000,
    memoryAvailableBytes: 8_000,
    diskTotalBytes: 100_000,
    diskAvailableBytes: 60_000,
    diskInodesTotal: 10_000,
    diskInodesAvailable: 9_000,
  };
}

describe("instance health store", () => {
  test("upserts one current heartbeat per worker", async () => {
    const store = createMemoryStore();

    await store.upsertWorkerHeartbeat(heartbeat());
    await store.upsertWorkerHeartbeat(heartbeat({
      observedAt: "2026-07-18T10:00:05.000Z",
      lastTickDurationMs: 91,
    }));

    await expect(store.listWorkerHeartbeats()).resolves.toEqual([
      expect.objectContaining({
        workerId: "worker-1",
        observedAt: "2026-07-18T10:00:05.000Z",
        lastTickDurationMs: 91,
      }),
    ]);
  });

  test("returns metric history in chronological order for a bounded range", async () => {
    const store = createMemoryStore();
    await store.recordHostMetric(metric("2026-07-18T09:00:00.000Z"));
    await store.recordHostMetric(metric("2026-07-18T10:00:00.000Z"));
    await store.recordHostMetric(metric("2026-07-18T11:00:00.000Z", "worker-2"));

    const samples = await store.listHostMetrics({
      workerId: "worker-1",
      since: new Date("2026-07-18T09:30:00.000Z"),
      limit: 100,
    });

    expect(samples.map((sample) => sample.observedAt)).toEqual([
      "2026-07-18T10:00:00.000Z",
    ]);
  });

  test("prunes expired metric samples without deleting current history", async () => {
    const store = createMemoryStore();
    await store.recordHostMetric(metric("2026-06-01T10:00:00.000Z"));
    await store.recordHostMetric(metric("2026-07-18T10:00:00.000Z"));

    await expect(store.pruneHostMetrics(new Date("2026-07-01T00:00:00.000Z"))).resolves.toBe(1);
    await expect(store.listHostMetrics({ limit: 100 })).resolves.toHaveLength(1);
  });

  test("summarizes queued work and active runtime states", async () => {
    const store = createMemoryStore({
      jobs: [
        {
          id: "job-queued",
          projectId: "project-1",
          type: "build_deploy",
          status: "queued",
          payload: {},
          attempts: 0,
          lastError: null,
          createdAt: "2026-07-18T09:00:00.000Z",
          updatedAt: "2026-07-18T09:00:00.000Z",
        },
        {
          id: "job-running",
          projectId: "project-1",
          type: "import_source",
          status: "running",
          payload: {},
          attempts: 1,
          lastError: null,
          createdAt: "2026-07-18T09:30:00.000Z",
          updatedAt: "2026-07-18T09:45:00.000Z",
        },
      ],
      runtimeInstances: [
        {
          id: "runtime-ready",
          deploymentId: "deployment-1",
          generation: 1,
          status: "ready",
          endpointHost: "127.0.0.1",
          endpointPort: 41_001,
          startedAt: "2026-07-18T09:00:00.000Z",
          readyAt: "2026-07-18T09:00:01.000Z",
          stoppedAt: null,
          lastError: null,
        },
        {
          id: "runtime-failed",
          deploymentId: "deployment-2",
          generation: 1,
          status: "failed",
          endpointHost: null,
          endpointPort: null,
          startedAt: null,
          readyAt: null,
          stoppedAt: "2026-07-18T09:50:00.000Z",
          lastError: "start failed",
        },
      ],
    });

    await expect(store.getInstanceWorkload()).resolves.toEqual({
      queuedJobs: 1,
      runningJobs: 1,
      oldestQueuedAt: "2026-07-18T09:00:00.000Z",
      runtimeInstances: {
        starting: 0,
        ready: 1,
        draining: 0,
        stopped: 0,
        failed: 1,
      },
    });
  });
});
