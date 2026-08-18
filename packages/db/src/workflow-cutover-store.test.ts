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

    // A lease acquired BEFORE the fence exists must stop renewing after it.
    const preFenceLease = await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_pre_fence",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await store.ensureWorkflowCutoverOperation({
      id: "cut_fence_test",
      kind: "termination",
      scope: {},
    });
    await store.writeWorkflowFences("cut_fence_test", [
      { scopeKind: "deployment", scopeId: deployment.id, reason: "legacy termination" },
    ]);

    await expect(
      store.renewActivationLease(preFenceLease.lease.id, new Date(Date.now() + 120_000)),
    ).resolves.toBeNull();

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
    ).resolves.toHaveProperty("lease");
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

  test("per-run family convergence fails only the named family and tombstones its projection", async () => {
    const store = createTestStore();
    const { project, deployment } = await createTerminationFixture(store);
    await store.createSession({
      projectId: project.id,
      deploymentId: deployment.id,
      trigger: "playground",
      eveSessionId: "eve_family_doomed",
    });
    await store.createSession({
      projectId: project.id,
      deploymentId: deployment.id,
      trigger: "playground",
      eveSessionId: "eve_family_healthy",
    });
    const routes = await store.ensureDeploymentRoutes(project.id, deployment.id, "agent.localhost");
    for (const eveSessionId of ["eve_family_doomed", "eve_family_healthy"]) {
      await store.bindSession({
        projectId: project.id,
        eveSessionId,
        routeId: routes[0]!.id,
        deploymentId: deployment.id,
        trigger: "api",
        variantName: null,
        experimentId: null,
        requestId: `req_${eveSessionId}`,
        remoteIp: null,
        affinityFingerprint: null,
        affinitySource: null,
      });
    }

    const result = await store.convergeWorkflowRunFamilies("cut_family_test", [
      { projectId: project.id, eveSessionId: "eve_family_doomed" },
    ]);
    expect(result).toMatchObject({ failedSessions: 1, tombstonedFamilies: 1 });

    // The named family is failed and fenced against late OTLP resurrection...
    await expect(
      store.getSessionByEveSessionId(project.id, "eve_family_doomed"),
    ).resolves.toMatchObject({ status: "failed" });
    expect(
      await store.getActiveWorkflowFence("session_family", `${project.id}:eve_family_doomed`),
    ).toMatchObject({ operationId: "cut_family_test" });

    // ...while the sibling family on the SAME deployment is untouched.
    await expect(
      store.getSessionByEveSessionId(project.id, "eve_family_healthy"),
    ).resolves.toMatchObject({ status: "running" });
    expect(
      await store.getActiveWorkflowFence("session_family", `${project.id}:eve_family_healthy`),
    ).toBeNull();

    // Idempotent: the retried saga step converges nothing twice.
    const second = await store.convergeWorkflowRunFamilies("cut_family_test", [
      { projectId: project.id, eveSessionId: "eve_family_doomed" },
    ]);
    expect(second).toMatchObject({ failedSessions: 0, tombstonedFamilies: 0 });
  });
});
