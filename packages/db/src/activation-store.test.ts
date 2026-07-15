import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./store.js";

describe("runtime activation persistence", () => {
  test("elects one starter and shares its RuntimeInstance across concurrent leases", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Dormant Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/dormant-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:dormant",
      containerName: "fixture-dormant",
      internalPort: 3000,
      hostPort: 41995,
      runtimeKind: "docker",
    });
    const now = new Date("2026-07-15T02:00:00.000Z");

    const claims = await Promise.all([
      store.acquireActivationLease({
        deploymentId: deployment.id,
        kind: "schedule_run",
        ownerId: "srun_one",
        expiresAt: new Date("2026-07-15T02:02:00.000Z"),
        now,
      }),
      store.acquireActivationLease({
        deploymentId: deployment.id,
        kind: "public_request",
        ownerId: "req_one",
        expiresAt: new Date("2026-07-15T02:01:00.000Z"),
        now,
      }),
    ]);

    expect(claims.filter((claim) => claim.starter)).toHaveLength(1);
    expect(new Set(claims.map((claim) => claim.runtimeInstance.id)).size).toBe(1);
    const instance = await store.updateRuntimeInstance(claims[0]!.runtimeInstance.id, {
      status: "ready",
      endpointHost: "127.0.0.1",
      endpointPort: deployment.hostPort,
    }, now);
    expect(instance).toMatchObject({ status: "ready", readyAt: now.toISOString() });

    await store.releaseActivationLease(claims[0]!.lease.id, now);
    await expect(store.hasActiveActivationLeases(deployment.id, now)).resolves.toBe(true);
    await store.releaseActivationLease(claims[1]!.lease.id, now);
    await expect(store.hasActiveActivationLeases(deployment.id, now)).resolves.toBe(false);
  });
});
