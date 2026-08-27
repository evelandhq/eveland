import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

async function createDeployment(store: ReturnType<typeof createTestStore>, hostPort: number) {
  const project = await store.createProject({ name: `MG Agent ${hostPort}`, importKind: "zip" });
  const importJob = await store.claimNextJob("fixture-import");
  await store.completeJob(importJob!.id);
  const revision = await store.recordSourceRevision({
    projectId: project.id,
    kind: "zip",
    sourcePath: "/tmp/mg-agent",
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
  const deployment = await store.recordDeployment({
    projectId: project.id,
    sourceRevisionId: revision.id,
    imageTag: "fixture:mg",
    containerName: `fixture-mg-${hostPort}`,
    internalPort: 3000,
    hostPort,
    runtimeKind: "docker",
  });
  return { project, deployment };
}

describe("model gateway token persistence", () => {
  test("a token hash assigned at start is resolvable while the instance is live and dies with it", async () => {
    const store = createTestStore();
    const { project, deployment } = await createDeployment(store, 42101);
    const claim = await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_mg",
      expiresAt: new Date("2026-08-27T02:01:00.000Z"),
      now: new Date("2026-08-27T02:00:00.000Z"),
    });
    const tokenHash = "a".repeat(64);

    await store.updateRuntimeInstance(claim.runtimeInstance.id, {
      status: "starting",
      modelGatewayTokenHash: tokenHash,
    });

    const starting = await store.findLiveRuntimeInstanceByModelGatewayTokenHash(tokenHash);
    expect(starting).toMatchObject({
      runtimeInstanceId: claim.runtimeInstance.id,
      deploymentId: deployment.id,
      projectId: project.id,
    });

    await store.updateRuntimeInstance(claim.runtimeInstance.id, {
      status: "ready",
      endpointHost: "127.0.0.1",
      endpointPort: deployment.hostPort,
    });
    expect(await store.findLiveRuntimeInstanceByModelGatewayTokenHash(tokenHash)).not.toBeNull();

    await store.updateRuntimeInstance(claim.runtimeInstance.id, {
      status: "stopped",
      endpointHost: null,
      endpointPort: null,
    });
    expect(await store.findLiveRuntimeInstanceByModelGatewayTokenHash(tokenHash)).toBeNull();
  });

  test("a failed instance revokes its token", async () => {
    const store = createTestStore();
    const { deployment } = await createDeployment(store, 42102);
    const claim = await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_mg_fail",
      expiresAt: new Date("2026-08-27T02:01:00.000Z"),
    });
    const tokenHash = "b".repeat(64);
    await store.updateRuntimeInstance(claim.runtimeInstance.id, {
      status: "starting",
      modelGatewayTokenHash: tokenHash,
    });
    await store.updateRuntimeInstance(claim.runtimeInstance.id, {
      status: "failed",
      error: "boom",
    });
    expect(await store.findLiveRuntimeInstanceByModelGatewayTokenHash(tokenHash)).toBeNull();
  });

  test("adoption can bind a token hash for restart-launched processes", async () => {
    const store = createTestStore();
    const { project, deployment } = await createDeployment(store, 42103);
    const tokenHash = "c".repeat(64);

    const adopted = await store.adoptRuntimeInstance(
      deployment.id,
      { endpointHost: "127.0.0.1", endpointPort: deployment.hostPort },
      new Date("2026-08-27T02:00:00.000Z"),
      { modelGatewayTokenHash: tokenHash },
    );
    expect(adopted).not.toBeNull();

    const found = await store.findLiveRuntimeInstanceByModelGatewayTokenHash(tokenHash);
    expect(found).toMatchObject({
      runtimeInstanceId: adopted!.id,
      deploymentId: deployment.id,
      projectId: project.id,
    });
  });

  test("an unknown hash resolves to nothing", async () => {
    const store = createTestStore();
    expect(await store.findLiveRuntimeInstanceByModelGatewayTokenHash("f".repeat(64))).toBeNull();
  });
});
