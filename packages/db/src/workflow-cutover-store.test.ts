import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

async function createTerminationFixture(store: ReturnType<typeof createTestStore>) {
  const project = await store.createProject({ name: "Termination Agent", importKind: "zip" });
  const importJob = await store.claimNextJob("fixture-import");
  await store.completeJob(importJob!.id);
  const revision = await store.recordSourceRevision({
    projectId: project.id,
    kind: "zip",
    sourcePath: "/tmp/termination",
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
  const deployment = await store.recordDeployment({
    projectId: project.id,
    sourceRevisionId: revision.id,
    imageTag: "fixture:termination",
    containerName: "fixture-termination",
    internalPort: 3000,
    hostPort: 42_500,
    runtimeKind: "docker",
  });
  return { project, deployment };
}

describe("workflow cutover operations", () => {
  test("phases advance monotonically with idempotent checkpoints and never regress", async () => {
    const store = createTestStore();
    const created = await store.ensureWorkflowCutoverOperation({
      id: "cut_op_test",
      kind: "termination",
      scope: { deploymentIds: ["dep_x"] },
    });
    expect(created).toMatchObject({ phase: "pending", checkpoints: {} });

    // Re-ensuring resumes the same operation instead of duplicating it.
    const resumed = await store.ensureWorkflowCutoverOperation({
      id: "cut_op_test",
      kind: "termination",
      scope: { deploymentIds: ["ignored"] },
    });
    expect(resumed.scope).toEqual({ deploymentIds: ["dep_x"] });

    const fenced = await store.advanceWorkflowCutoverOperation("cut_op_test", {
      phase: "fenced",
      checkpoint: { key: "fences", value: 1 },
    });
    expect(fenced).toMatchObject({ phase: "fenced", checkpoints: { fences: 1 } });

    const safe = await store.advanceWorkflowCutoverOperation("cut_op_test", {
      phase: "workflow_safe",
      checkpoint: { key: "terminatedRuns", value: 2 },
    });
    expect(safe?.checkpoints).toEqual({ fences: 1, terminatedRuns: 2 });

    // A failed step records the error and holds its ground.
    const held = await store.advanceWorkflowCutoverOperation("cut_op_test", {
      lastError: "legacy database unreachable",
    });
    expect(held).toMatchObject({
      phase: "workflow_safe",
      lastError: "legacy database unreachable",
    });

    // A re-run reporting an earlier phase holds its ground instead of
    // reopening the operation.
    await expect(
      store.advanceWorkflowCutoverOperation("cut_op_test", { phase: "pending" }),
    ).resolves.toMatchObject({ phase: "workflow_safe" });
    expect(await store.advanceWorkflowCutoverOperation("cut_missing", {})).toBeNull();
  });

  test("a deployment fence blocks every activation path until an operator resolves it", async () => {
    const store = createTestStore();
    const { deployment } = await createTerminationFixture(store);
    await store.updateDeploymentStatus(deployment.id, "stopped");

    await store.ensureWorkflowCutoverOperation({
      id: "cut_fence_test",
      kind: "termination",
      scope: {},
    });
    await store.writeWorkflowFences("cut_fence_test", [
      { scopeKind: "deployment", scopeId: deployment.id, reason: "legacy termination" },
    ]);

    await expect(
      store.acquireActivationLease({
        deploymentId: deployment.id,
        kind: "public_request",
        ownerId: "req_fenced",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow(/workflow_unavailable/);

    // Fences survive re-writes idempotently and only close by explicit resolution.
    await store.writeWorkflowFences("cut_fence_test", [
      { scopeKind: "deployment", scopeId: deployment.id, reason: "legacy termination" },
    ]);
    expect(await store.getActiveWorkflowFence("deployment", deployment.id)).toMatchObject({
      operationId: "cut_fence_test",
    });
    await store.resolveWorkflowFence("deployment", deployment.id, "operator-test");
    expect(await store.getActiveWorkflowFence("deployment", deployment.id)).toBeNull();

    await expect(
      store.acquireActivationLease({
        deploymentId: deployment.id,
        kind: "public_request",
        ownerId: "req_unfenced",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toMatchObject({ starter: true });
  });

  test("control-plane convergence fails sessions, removes bindings, releases leases, idempotently", async () => {
    const store = createTestStore();
    const { project, deployment } = await createTerminationFixture(store);
    const session = await store.createSession({
      projectId: project.id,
      deploymentId: deployment.id,
      trigger: "playground",
      eveSessionId: "eve_terminated_1",
    });
    const routes = await store.ensureDeploymentRoutes(project.id, deployment.id, "agent.localhost");
    await store.bindSession({
      projectId: project.id,
      eveSessionId: "eve_terminated_1",
      routeId: routes[0]!.id,
      deploymentId: deployment.id,
      trigger: "api",
      variantName: null,
      experimentId: null,
      requestId: "req_terminated",
      remoteIp: null,
      affinityFingerprint: null,
      affinitySource: null,
    });
    await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_terminated",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const first = await store.convergeWorkflowTermination("cut_conv_test", [deployment.id]);
    expect(first).toMatchObject({
      failedSessions: 1,
      removedSessionBindings: 1,
      releasedLeases: 1,
    });
    await expect(
      store.getSessionByEveSessionId(project.id, "eve_terminated_1"),
    ).resolves.toMatchObject({ id: session.id, status: "failed" });

    // Idempotent: a retried saga step converges nothing twice.
    const second = await store.convergeWorkflowTermination("cut_conv_test", [deployment.id]);
    expect(second).toMatchObject({
      failedSessions: 0,
      removedSessionBindings: 0,
      releasedLeases: 0,
    });
  });
});
