import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

describe("runtime activation persistence", () => {
  test("elects one starter and shares its RuntimeInstance across concurrent leases", async () => {
    const store = createTestStore();
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
    const instance = await store.updateRuntimeInstance(
      claims[0]!.runtimeInstance.id,
      {
        status: "ready",
        endpointHost: "127.0.0.1",
        endpointPort: deployment.hostPort,
      },
      now,
    );
    expect(instance).toMatchObject({ status: "ready", readyAt: now.toISOString() });

    await store.releaseActivationLease(claims[0]!.lease.id, now);
    await expect(store.hasActiveActivationLeases(deployment.id, now)).resolves.toBe(true);
    await store.releaseActivationLease(claims[1]!.lease.id, now);
    await expect(store.hasActiveActivationLeases(deployment.id, now)).resolves.toBe(false);
  });

  test("renews only live leases and starts the idle deadline after the final release", async () => {
    const store = createTestStore();
    const { deployment } = await deploymentFixture(store, "Idle Agent", 41996);
    const startedAt = new Date("2026-07-15T02:00:00.000Z");
    const claim = await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_idle",
      expiresAt: new Date("2026-07-15T02:01:00.000Z"),
      now: startedAt,
    });
    await store.updateRuntimeInstance(
      claim.runtimeInstance.id,
      {
        status: "ready",
        endpointHost: "127.0.0.1",
        endpointPort: deployment.hostPort,
      },
      startedAt,
    );

    await expect(
      store.renewActivationLease(
        claim.lease.id,
        new Date("2026-07-15T02:03:00.000Z"),
        new Date("2026-07-15T02:00:30.000Z"),
      ),
    ).resolves.toMatchObject({ expiresAt: "2026-07-15T02:03:00.000Z" });
    await store.releaseActivationLease(claim.lease.id, new Date("2026-07-15T02:01:30.000Z"));
    await expect(
      store.renewActivationLease(
        claim.lease.id,
        new Date("2026-07-15T02:04:00.000Z"),
        new Date("2026-07-15T02:02:00.000Z"),
      ),
    ).resolves.toBeNull();

    await expect(
      store.claimIdleRuntimeInstances({
        now: new Date("2026-07-15T02:02:29.999Z"),
        idleTtlMs: 60_000,
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      store.claimIdleRuntimeInstances({
        now: new Date("2026-07-15T02:02:30.000Z"),
        idleTtlMs: 60_000,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: claim.runtimeInstance.id, status: "draining" }),
    ]);
    await expect(
      store.acquireActivationLease({
        deploymentId: deployment.id,
        kind: "public_request",
        ownerId: "req_during_drain",
        expiresAt: new Date("2026-07-15T02:04:00.000Z"),
        now: new Date("2026-07-15T02:02:31.000Z"),
      }),
    ).rejects.toThrow(/draining/);
  });

  test("coalesces activation jobs and recovers a stale Worker claim", async () => {
    const store = createTestStore();
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
    await expect(
      store.claimNextJob("activation-worker", new Date("2026-07-15T04:00:30.000Z")),
    ).resolves.toMatchObject({
      id: first.id,
      status: "running",
    });

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

describe("orphan process adoption persistence", () => {
  test("finds a deployment by its container name", async () => {
    const store = createTestStore();
    const { deployment } = await deploymentFixture(store, "Adoptable Agent", 41991);

    await expect(
      store.getDeploymentByContainerName(deployment.containerName),
    ).resolves.toMatchObject({
      id: deployment.id,
    });
    await expect(store.getDeploymentByContainerName("eveland-unknown-process")).resolves.toBeNull();
  });

  test("adopts an unmanaged deployment into a ready RuntimeInstance that activation reuses and idle claiming drains", async () => {
    const store = createTestStore();
    const { deployment } = await deploymentFixture(store, "Zombie Agent", 41992);
    const now = new Date("2026-07-16T08:00:00.000Z");

    const adopted = await store.adoptRuntimeInstance(
      deployment.id,
      {
        endpointHost: "127.0.0.1",
        endpointPort: deployment.hostPort,
      },
      now,
    );
    expect(adopted).toMatchObject({
      deploymentId: deployment.id,
      generation: 1,
      status: "ready",
      endpointHost: "127.0.0.1",
      endpointPort: deployment.hostPort,
      readyAt: now.toISOString(),
    });
    await expect(store.listDeploymentRuntimeInstances(deployment.id)).resolves.toEqual([
      expect.objectContaining({ id: adopted!.id }),
    ]);

    const claim = await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_adopted",
      expiresAt: new Date("2026-07-16T08:01:00.000Z"),
      now,
    });
    expect(claim.starter).toBe(false);
    expect(claim.runtimeInstance.id).toBe(adopted!.id);
    await store.releaseActivationLease(claim.lease.id, now);

    await expect(
      store.claimIdleRuntimeInstances({
        now: new Date("2026-07-16T08:05:00.000Z"),
        idleTtlMs: 300_000,
        limit: 10,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: adopted!.id, status: "draining" })]);
  });

  test("refuses adoption while a live or draining instance exists and re-adopts after stop", async () => {
    const store = createTestStore();
    const { deployment } = await deploymentFixture(store, "Readopt Agent", 41993);
    const now = new Date("2026-07-16T09:00:00.000Z");

    const first = await store.adoptRuntimeInstance(
      deployment.id,
      {
        endpointHost: "127.0.0.1",
        endpointPort: deployment.hostPort,
      },
      now,
    );
    await expect(
      store.adoptRuntimeInstance(
        deployment.id,
        {
          endpointHost: "127.0.0.1",
          endpointPort: deployment.hostPort,
        },
        now,
      ),
    ).resolves.toBeNull();

    await store.claimIdleRuntimeInstances({
      now: new Date("2026-07-16T09:05:00.000Z"),
      idleTtlMs: 300_000,
      limit: 10,
    });
    await expect(
      store.adoptRuntimeInstance(
        deployment.id,
        {
          endpointHost: "127.0.0.1",
          endpointPort: deployment.hostPort,
        },
        new Date("2026-07-16T09:05:01.000Z"),
      ),
    ).resolves.toBeNull();

    await store.updateRuntimeInstance(
      first!.id,
      { status: "stopped" },
      new Date("2026-07-16T09:05:02.000Z"),
    );
    await expect(
      store.adoptRuntimeInstance(
        deployment.id,
        {
          endpointHost: "127.0.0.1",
          endpointPort: deployment.hostPort,
        },
        new Date("2026-07-16T09:06:00.000Z"),
      ),
    ).resolves.toMatchObject({ generation: 2, status: "ready" });
  });
});

async function deploymentFixture(
  store: ReturnType<typeof createTestStore>,
  name: string,
  hostPort: number,
) {
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

describe("runtime instance port reservation", () => {
  async function createFixtureDeployment(
    store: ReturnType<typeof createTestStore>,
    name: string,
    hostPort: number,
  ) {
    const project = await store.createProject({ name, importKind: "zip" });
    const importJob = await store.claimNextJob(`fixture-import-${hostPort}`);
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: `/tmp/${hostPort}`,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    return store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: `fixture:${hostPort}`,
      containerName: `fixture-port-${hostPort}`,
      internalPort: 3000,
      hostPort,
      runtimeKind: "systemd",
    });
  }

  test("reserves a free port on a starting instance and stamps the endpoint", async () => {
    const store = createTestStore();
    const deployment = await createFixtureDeployment(store, "Port Reserve Agent", 41900);
    const claim = await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_reserve",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(store.reserveRuntimeInstancePort(claim.runtimeInstance.id, 41911)).resolves.toBe(
      true,
    );
    await expect(store.getRuntimeInstance(claim.runtimeInstance.id)).resolves.toMatchObject({
      status: "starting",
      endpointHost: "127.0.0.1",
      endpointPort: 41911,
    });
  });

  test("refuses a port held by another live instance, in any live status", async () => {
    const store = createTestStore();
    const holderDeployment = await createFixtureDeployment(store, "Port Holder Agent", 41901);
    const contenderDeployment = await createFixtureDeployment(store, "Port Contender Agent", 41902);
    const holder = await store.acquireActivationLease({
      deploymentId: holderDeployment.id,
      kind: "public_request",
      ownerId: "req_holder",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(store.reserveRuntimeInstancePort(holder.runtimeInstance.id, 41912)).resolves.toBe(
      true,
    );

    const contender = await store.acquireActivationLease({
      deploymentId: contenderDeployment.id,
      kind: "public_request",
      ownerId: "req_contender",
      expiresAt: new Date(Date.now() + 60_000),
    });
    // Still reservable-looking while the holder is only starting -- must refuse.
    await expect(
      store.reserveRuntimeInstancePort(contender.runtimeInstance.id, 41912),
    ).resolves.toBe(false);

    // Ready keeps the reservation.
    await store.updateRuntimeInstance(holder.runtimeInstance.id, {
      status: "ready",
      endpointHost: "127.0.0.1",
      endpointPort: 41912,
    });
    await expect(
      store.reserveRuntimeInstancePort(contender.runtimeInstance.id, 41912),
    ).resolves.toBe(false);

    // A different port still works for the contender.
    await expect(
      store.reserveRuntimeInstancePort(contender.runtimeInstance.id, 41913),
    ).resolves.toBe(true);
  });

  test("frees the port once the holding instance leaves live statuses", async () => {
    const store = createTestStore();
    const holderDeployment = await createFixtureDeployment(store, "Port Free Agent", 41903);
    const contenderDeployment = await createFixtureDeployment(store, "Port Reuse Agent", 41904);
    const holder = await store.acquireActivationLease({
      deploymentId: holderDeployment.id,
      kind: "public_request",
      ownerId: "req_free",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(store.reserveRuntimeInstancePort(holder.runtimeInstance.id, 41914)).resolves.toBe(
      true,
    );
    await store.updateRuntimeInstance(holder.runtimeInstance.id, {
      status: "failed",
      error: "fixture",
    });

    const contender = await store.acquireActivationLease({
      deploymentId: contenderDeployment.id,
      kind: "public_request",
      ownerId: "req_reuse",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      store.reserveRuntimeInstancePort(contender.runtimeInstance.id, 41914),
    ).resolves.toBe(true);
  });
});
