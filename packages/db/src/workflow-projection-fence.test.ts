import type { AgentEventObservation } from "@evelandhq/core/observability";
import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

async function createProjectionFixture() {
  const store = createTestStore();
  const project = await store.createProject({ name: "Late OTLP Agent", importKind: "zip" });
  const importJob = await store.claimNextJob("fixture-import");
  await store.completeJob(importJob!.id);
  const revision = await store.recordSourceRevision({
    projectId: project.id,
    kind: "zip",
    sourcePath: "/tmp/late-otlp",
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
  const deployment = await store.recordDeployment({
    projectId: project.id,
    sourceRevisionId: revision.id,
    imageTag: "fixture:late-otlp",
    containerName: "fixture-late-otlp",
    internalPort: 3000,
    hostPort: 42_700,
    runtimeKind: "docker",
  });
  const retired = await store.recordDeployment({
    projectId: project.id,
    sourceRevisionId: revision.id,
    imageTag: "fixture:late-otlp-retired",
    containerName: "fixture-late-otlp-retired",
    internalPort: 3000,
    hostPort: 42_701,
    runtimeKind: "docker",
  });
  return { store, project, deployment, retired };
}

function envelope(
  deploymentId: string,
  overrides: Partial<AgentEventObservation> = {},
): AgentEventObservation {
  return {
    telemetryEventId: "evt_1",
    eventFingerprint: `fingerprint_${overrides.telemetryEventId ?? "evt_1"}`,
    deploymentId,
    eveSessionId: "eve_late_root",
    parentEveSessionId: null,
    sourceSequence: 1,
    agent: { id: null, name: "root", nodeId: "root" },
    channelKind: "http",
    eventAt: "2026-08-18T00:00:00.000Z",
    event: { type: "session.started", data: {} },
    ...overrides,
  };
}

describe("late OTLP projection fences", () => {
  test("a replayed batch after managed termination never reopens the session family", async () => {
    const { store, project, deployment } = await createProjectionFixture();
    // The family exists and was observed running before the termination.
    await store.ingestAgentEvent(envelope(deployment.id));
    const [session] = await store.listSessions(project.id);
    expect(session?.status).toBe("running");

    // Managed termination converges the control plane and tombstones the family.
    await store.ensureWorkflowCutoverOperation({
      id: "cut_otlp_test",
      kind: "termination",
      scope: {},
    });
    const converged = await store.convergeWorkflowTermination("cut_otlp_test", [deployment.id]);
    expect(converged.failedSessions).toBe(1);

    // The same batch redelivered — and a late child-before-parent batch —
    // both stay terminal instead of re-materializing a running Session.
    await expect(store.ingestAgentEvent(envelope(deployment.id))).rejects.toMatchObject({
      name: "WorkflowProjectionFencedError",
    });
    await expect(
      store.ingestAgentEvent(
        envelope(deployment.id, {
          telemetryEventId: "evt_child",
          eveSessionId: "eve_late_child",
          parentEveSessionId: "eve_late_root",
        }),
      ),
    ).rejects.toMatchObject({ name: "WorkflowProjectionFencedError" });

    const [after] = await store.listSessions(project.id);
    expect(after?.status).toBe("failed");
    // The node converged with its family — nothing reads as live work.
    const nodes = await store.listSessionNodes(after!.id);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.status).toBe("failed");
  });

  test("a retired deployment's projection fence blocks history the projector never saw", async () => {
    const { store, project, retired, deployment } = await createProjectionFixture();
    await store.ensureWorkflowCutoverOperation({
      id: "cut_otlp_retired",
      kind: "termination",
      scope: {},
    });
    await store.writeWorkflowFences("cut_otlp_retired", [
      { scopeKind: "deployment", scopeId: retired.id, reason: "legacy deployment retired" },
    ]);

    // A root event that was never materialized before retirement must not
    // create a running Session now.
    await expect(
      store.ingestAgentEvent(
        envelope(retired.id, { telemetryEventId: "evt_never_seen", eveSessionId: "eve_never" }),
      ),
    ).rejects.toMatchObject({ name: "WorkflowProjectionFencedError" });
    expect(await store.listSessions(project.id)).toHaveLength(0);

    // The converted sibling deployment keeps projecting its legitimate
    // telemetry — the fence is deployment-scoped, not project-wide.
    await expect(store.ingestAgentEvent(envelope(deployment.id))).resolves.toMatchObject({
      duplicate: false,
    });
  });
});
