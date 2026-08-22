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
 * Release workflow attestation is immutable build output. Every caller that
 * does not state provenance gets the conservative `unknown` defaults that
 * block activation rather than a guessed topology.
 */
describe("release workflow attestation", () => {
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
        worldVersion: "0.11.0",
        storageSpec: 6,
        dispatchProtocol: 1,
        enqueueCapability: "per_run_queue_v1",
      },
    });

    const release = await store.getRelease(deployment.releaseId);
    expect(release?.workflow).toEqual({
      worldKind: "shared",
      worldPackage: "@evelandhq/workflow-world",
      worldVersion: "0.11.0",
      storageSpec: 6,
      dispatchProtocol: 1,
      enqueueCapability: "per_run_queue_v1",
    });
  });

  test("a recording without attestation stays unknown", async () => {
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
  });
});
