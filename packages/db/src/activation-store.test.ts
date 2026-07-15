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

  test("renews only live leases and starts the idle deadline after the final release", async () => {
    const store = createMemoryStore();
    const { deployment } = await deploymentFixture(store, "Idle Agent", 41996);
    const startedAt = new Date("2026-07-15T02:00:00.000Z");
    const claim = await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_idle",
      expiresAt: new Date("2026-07-15T02:01:00.000Z"),
      now: startedAt,
    });
    await store.updateRuntimeInstance(claim.runtimeInstance.id, {
      status: "ready",
      endpointHost: "127.0.0.1",
      endpointPort: deployment.hostPort,
    }, startedAt);

    await expect(store.renewActivationLease(
      claim.lease.id,
      new Date("2026-07-15T02:03:00.000Z"),
      new Date("2026-07-15T02:00:30.000Z"),
    )).resolves.toMatchObject({ expiresAt: "2026-07-15T02:03:00.000Z" });
    await store.releaseActivationLease(claim.lease.id, new Date("2026-07-15T02:01:30.000Z"));
    await expect(store.renewActivationLease(
      claim.lease.id,
      new Date("2026-07-15T02:04:00.000Z"),
      new Date("2026-07-15T02:02:00.000Z"),
    )).resolves.toBeNull();

    await expect(store.claimIdleRuntimeInstances({
      now: new Date("2026-07-15T02:02:29.999Z"),
      idleTtlMs: 60_000,
      limit: 10,
    })).resolves.toEqual([]);
    await expect(store.claimIdleRuntimeInstances({
      now: new Date("2026-07-15T02:02:30.000Z"),
      idleTtlMs: 60_000,
      limit: 10,
    })).resolves.toEqual([expect.objectContaining({ id: claim.runtimeInstance.id, status: "draining" })]);
    await expect(store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_during_drain",
      expiresAt: new Date("2026-07-15T02:04:00.000Z"),
      now: new Date("2026-07-15T02:02:31.000Z"),
    })).rejects.toThrow(/draining/);
  });

  test("coalesces activation jobs and recovers a stale Worker claim", async () => {
    const store = createMemoryStore();
    const { project, deployment } = await deploymentFixture(store, "Activation Job Agent", 41995);
    const claim = await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_activation_job",
      expiresAt: new Date("2026-07-15T04:10:00.000Z"),
      now: new Date("2026-07-15T04:00:00.000Z"),
    });

    const first = await store.enqueueDeploymentActivation(
      project.id,
      deployment.id,
      claim.runtimeInstance.id,
      new Date("2026-07-15T04:00:00.000Z"),
    );
    const duplicate = await store.enqueueDeploymentActivation(
      project.id,
      deployment.id,
      claim.runtimeInstance.id,
      new Date("2026-07-15T04:00:01.000Z"),
    );
    expect(duplicate.id).toBe(first.id);
    await expect(store.claimNextJob("activation-worker")).resolves.toMatchObject({ id: first.id, status: "running" });

    const recovered = await store.enqueueDeploymentActivation(
      project.id,
      deployment.id,
      claim.runtimeInstance.id,
      new Date("2026-07-15T04:06:00.000Z"),
      300_000,
    );
    expect(recovered).toMatchObject({ id: first.id, status: "queued" });
  });
});

async function deploymentFixture(store: ReturnType<typeof createMemoryStore>, name: string, hostPort: number) {
  const project = await store.createProject({ name, importKind: "zip" });
  const importJob = await store.claimNextJob("fixture-import");
  await store.completeJob(importJob!.id);
  const revision = await store.recordSourceRevision({
    projectId: project.id,
    kind: "zip",
    sourcePath: `/tmp/${name.toLowerCase().replaceAll(" ", "-")}`,
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
  const deployment = await store.recordDeployment({
    projectId: project.id,
    sourceRevisionId: revision.id,
    imageTag: `fixture:${project.slug}`,
    containerName: `fixture-${project.slug}`,
    internalPort: 3000,
    hostPort,
    runtimeKind: "docker",
  });
  return { project, revision, deployment };
}
