import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

async function createDeployableProject(store: ReturnType<typeof createTestStore>) {
  const project = await store.createProject({ name: "Topology Agent", importKind: "zip" });
  const revision = await store.recordSourceRevision({
    projectId: project.id,
    kind: "zip",
    sourcePath: "/tmp/topology",
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
  return { project, revision };
}

/**
 * Release workflow attestation is immutable build output; Deployment execution
 * topology is mutable runtime state. They are persisted separately, and every
 * caller that does not state provenance gets the conservative `unknown`
 * defaults that block activation rather than a guessed topology.
 */
describe("release workflow attestation and deployment execution topology", () => {
  test("a build that attests the shared world persists the full attestation", async () => {
    const store = createTestStore();
    const { project, revision } = await createDeployableProject(store);

    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "topology:shared",
      containerName: "topology-shared",
      internalPort: 3000,
      hostPort: 41890,
      runtimeKind: "docker",
      workflowWorld: {
        worldKind: "shared",
        worldPackage: "@evelandhq/workflow-world",
        worldVersion: "0.10.1",
        storageSpec: 6,
        dispatchProtocol: 1,
        enqueueCapability: "per_run_queue_v1",
      },
    });

    const release = await store.getRelease(deployment.releaseId);
    expect(release?.workflow).toEqual({
      worldKind: "shared",
      worldPackage: "@evelandhq/workflow-world",
      worldVersion: "0.10.1",
      storageSpec: 6,
      dispatchProtocol: 1,
      enqueueCapability: "per_run_queue_v1",
    });
    // A new shared build starts life already on the external topology.
    expect(deployment.workflowTopology).toMatchObject({
      runnerMode: "external",
      conversionState: "external",
      conversionOperationId: null,
    });
    const fetched = await store.getDeployment(deployment.id);
    expect(fetched?.workflowTopology).toEqual(deployment.workflowTopology);
  });

  test("a recording without attestation stays unknown and unclassified", async () => {
    const store = createTestStore();
    const { project, revision } = await createDeployableProject(store);

    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "topology:unattested",
      containerName: "topology-unattested",
      internalPort: 3000,
      hostPort: 41891,
      runtimeKind: "docker",
    });

    const release = await store.getRelease(deployment.releaseId);
    expect(release?.workflow).toEqual({
      worldKind: "unknown",
      worldPackage: null,
      worldVersion: null,
      storageSpec: null,
      dispatchProtocol: null,
      enqueueCapability: "unknown",
    });
    expect(deployment.workflowTopology).toMatchObject({
      runnerMode: "unknown",
      conversionState: "unclassified",
    });
  });

  test("execution topology can be staged and finalized idempotently under one operation id", async () => {
    const store = createTestStore();
    const { project, revision } = await createDeployableProject(store);
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "topology:converting",
      containerName: "topology-converting",
      internalPort: 3000,
      hostPort: 41892,
      runtimeKind: "docker",
    });

    const staged = await store.updateDeploymentWorkflowTopology(deployment.id, {
      runnerMode: "external",
      conversionState: "converting",
      conversionOperationId: "cut_op_1",
      runnerEvidence: { source: "systemd-environment", capturedAt: "2026-08-18T00:00:00.000Z" },
    });
    expect(staged?.workflowTopology).toMatchObject({
      runnerMode: "external",
      conversionState: "converting",
      conversionOperationId: "cut_op_1",
      runnerEvidence: { source: "systemd-environment", capturedAt: "2026-08-18T00:00:00.000Z" },
    });

    // Re-staging with the same operation id is a no-op, not an error.
    const restaged = await store.updateDeploymentWorkflowTopology(deployment.id, {
      runnerMode: "external",
      conversionState: "converting",
      conversionOperationId: "cut_op_1",
    });
    expect(restaged?.workflowTopology.conversionState).toBe("converting");

    const finalized = await store.updateDeploymentWorkflowTopology(deployment.id, {
      conversionState: "external",
      conversionOperationId: "cut_op_1",
    });
    expect(finalized?.workflowTopology).toMatchObject({
      runnerMode: "external",
      conversionState: "external",
      conversionOperationId: "cut_op_1",
    });

    expect(await store.updateDeploymentWorkflowTopology("dep_missing", {})).toBeNull();
  });
});
