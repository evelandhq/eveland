import { describe, expect, test } from "vitest";
import type { HostMetricSample, WorkerHeartbeat } from "@eveland/core/instance-health";
import { createTestStore } from "./vitest-store.js";

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
    cpuCores: 2,
    pgConnections: [
      { role: "shared", usedConnections: 42, maxConnections: 100, agentPoolSize: 10 },
    ],
  };
}

describe("instance health store", () => {
  test("upserts one current heartbeat per worker", async () => {
    const store = createTestStore();

    await store.upsertWorkerHeartbeat(heartbeat());
    await store.upsertWorkerHeartbeat(
      heartbeat({
        observedAt: "2026-07-18T10:00:05.000Z",
        lastTickDurationMs: 91,
      }),
    );

    await expect(store.listWorkerHeartbeats()).resolves.toEqual([
      expect.objectContaining({
        workerId: "worker-1",
        observedAt: "2026-07-18T10:00:05.000Z",
        lastTickDurationMs: 91,
      }),
    ]);
  });

  test("returns metric history in chronological order for a bounded range", async () => {
    const store = createTestStore();
    await store.recordHostMetric(metric("2026-07-18T09:00:00.000Z"));
    await store.recordHostMetric(metric("2026-07-18T10:00:00.000Z"));
    await store.recordHostMetric(metric("2026-07-18T11:00:00.000Z", "worker-2"));

    const samples = await store.listHostMetrics({
      workerId: "worker-1",
      since: new Date("2026-07-18T09:30:00.000Z"),
      limit: 100,
    });

    expect(samples.map((sample) => sample.observedAt)).toEqual(["2026-07-18T10:00:00.000Z"]);
  });

  test("prunes expired metric samples without deleting current history", async () => {
    const store = createTestStore();
    await store.recordHostMetric(metric("2026-06-01T10:00:00.000Z"));
    await store.recordHostMetric(metric("2026-07-18T10:00:00.000Z"));

    await expect(store.pruneHostMetrics(new Date("2026-07-01T00:00:00.000Z"))).resolves.toBe(1);
    await expect(store.listHostMetrics({ limit: 100 })).resolves.toHaveLength(1);
  });

  test("summarizes queued work and active runtime states", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Health Workload", importKind: "zip" });
    await store.claimNextJob("worker-health");
    await store.enqueueJob(project.id, "build_deploy");
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/health-workload",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const readyDeployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:health-ready",
      containerName: "fixture-health-ready",
      internalPort: 3_000,
      hostPort: 41_001,
      runtimeKind: "docker",
    });
    const failedDeployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:health-failed",
      containerName: "fixture-health-failed",
      internalPort: 3_000,
      hostPort: 41_002,
      runtimeKind: "docker",
    });
    const readyClaim = await store.acquireActivationLease({
      deploymentId: readyDeployment.id,
      kind: "public_request",
      ownerId: "health-ready",
      expiresAt: new Date("2026-07-18T10:05:00.000Z"),
      now: new Date("2026-07-18T10:00:00.000Z"),
    });
    await store.updateRuntimeInstance(
      readyClaim.runtimeInstance.id,
      {
        status: "ready",
        endpointHost: "127.0.0.1",
        endpointPort: readyDeployment.hostPort,
      },
      new Date("2026-07-18T10:00:01.000Z"),
    );
    const failedClaim = await store.acquireActivationLease({
      deploymentId: failedDeployment.id,
      kind: "public_request",
      ownerId: "health-failed",
      expiresAt: new Date("2026-07-18T10:05:00.000Z"),
      now: new Date("2026-07-18T10:00:00.000Z"),
    });
    await store.updateRuntimeInstance(
      failedClaim.runtimeInstance.id,
      {
        status: "failed",
        error: "start failed",
      },
      new Date("2026-07-18T10:00:02.000Z"),
    );

    await expect(store.getInstanceWorkload()).resolves.toEqual({
      queuedJobs: 1,
      runningJobs: 1,
      oldestQueuedAt: expect.any(String),
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

describe("worker heartbeat replay", () => {
  test("a replayed older heartbeat does not move observedAt backwards", async () => {
    const store = createTestStore();
    const current = {
      workerId: "worker-a",
      startedAt: "2026-07-28T00:00:00.000Z",
      observedAt: "2026-07-28T00:05:00.000Z",
      intervalMs: 5_000,
      lastTickDurationMs: 12,
      lastError: null,
    };
    await store.upsertWorkerHeartbeat(current);

    // OTLP delivery is at least once: an older metrics batch can be redelivered
    // and would otherwise make a healthy worker look stale.
    const replayed = await store.upsertWorkerHeartbeat({
      ...current,
      observedAt: "2026-07-28T00:01:00.000Z",
      lastTickDurationMs: 999,
    });

    expect(replayed.observedAt).toBe(current.observedAt);
    expect(replayed.lastTickDurationMs).toBe(current.lastTickDurationMs);
    await expect(store.listWorkerHeartbeats()).resolves.toEqual([
      expect.objectContaining({ observedAt: current.observedAt }),
    ]);
  });

  test("a newer heartbeat still advances the record", async () => {
    const store = createTestStore();
    const base = {
      workerId: "worker-a",
      startedAt: "2026-07-28T00:00:00.000Z",
      observedAt: "2026-07-28T00:05:00.000Z",
      intervalMs: 5_000,
      lastTickDurationMs: 12,
      lastError: null,
    };
    await store.upsertWorkerHeartbeat(base);

    const advanced = await store.upsertWorkerHeartbeat({
      ...base,
      observedAt: "2026-07-28T00:06:00.000Z",
      lastTickDurationMs: 34,
    });

    expect(advanced).toMatchObject({
      observedAt: "2026-07-28T00:06:00.000Z",
      lastTickDurationMs: 34,
    });
  });
});
