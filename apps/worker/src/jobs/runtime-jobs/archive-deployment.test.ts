import type { DeploymentRecord } from "@evelandhq/core/contracts";
import { sharedWorkflowWorldAttestation } from "../process.test-support.js";
import type { Store } from "@evelandhq/db";
import { createTestStore } from "@evelandhq/db/vitest";
import { describe, expect, test, vi } from "vitest";
import type { RuntimeAdapter } from "../../runtime/types.js";
import { handleArchiveDeploymentJob } from "./archive-deployment.js";
import type { RuntimeJob } from "./types.js";

async function createArchiveFixture(store: Store) {
  const project = await store.createProject({
    name: `Archive Agent ${Date.now()}`,
    importKind: "zip",
  });
  const importJob = await store.claimNextJob("fixture-import");
  await store.completeJob(importJob!.id);
  const revision = await store.recordSourceRevision({
    projectId: project.id,
    kind: "zip",
    sourcePath: "/tmp/archive-agent",
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
  // Four deployments so the oldest falls outside the keep-recent-3 window.
  const deployments: DeploymentRecord[] = [];
  for (let index = 0; index < 4; index += 1) {
    deployments.push(
      await store.recordDeployment({
        projectId: project.id,
        sourceRevisionId: revision.id,
        imageTag: `fixture:archive-${index}`,
        containerName: `fixture-archive-${index}`,
        internalPort: 3000,
        hostPort: 42_100 + index,
        runtimeKind: "docker",
        workflowWorld: sharedWorkflowWorldAttestation,
      }),
    );
  }
  const target = deployments[0]!;
  await store.updateDeploymentStatus(target.id, "stopped");
  return { project, deployments, target };
}

function archiveJob(
  projectId: string,
  deploymentId: string,
  automatic = false,
): RuntimeJob<"archive_deployment"> {
  return {
    id: "job_archive_test",
    projectId,
    type: "archive_deployment",
    status: "running",
    payload: { deploymentId, ...(automatic ? { automatic: true } : {}) },
    attempts: 1,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("handleArchiveDeploymentJob", () => {
  test("removes artifacts only while holding the archiving claim", async () => {
    const store = createTestStore();
    const { project, target } = await createArchiveFixture(store);
    const statusDuringRemoval: string[] = [];
    const runtime = {
      name: "docker",
      stopProcess: vi.fn(),
      removeRelease: vi.fn(async () => {
        statusDuringRemoval.push((await store.getDeployment(target.id))!.status);
      }),
    } as unknown as RuntimeAdapter;

    await handleArchiveDeploymentJob(store, archiveJob(project.id, target.id), {
      runtime,
      dataDir: "/tmp/eveland-archive-claim-test",
    });

    expect(statusDuringRemoval).toEqual(["archiving"]);
    await expect(store.getDeployment(target.id)).resolves.toMatchObject({
      status: "archived",
    });
  });

  test("reverts to the prior status when artifact removal fails mid-claim", async () => {
    const store = createTestStore();
    const { project, target } = await createArchiveFixture(store);
    const statusDuringRemoval: string[] = [];
    const runtime = {
      name: "docker",
      stopProcess: vi.fn(),
      removeRelease: vi.fn(async () => {
        statusDuringRemoval.push((await store.getDeployment(target.id))!.status);
        throw new Error("registry unavailable");
      }),
    } as unknown as RuntimeAdapter;

    await expect(
      handleArchiveDeploymentJob(store, archiveJob(project.id, target.id), {
        runtime,
        dataDir: "/tmp/eveland-archive-claim-test",
      }),
    ).rejects.toThrow("registry unavailable");

    expect(statusDuringRemoval).toEqual(["archiving"]);
    await expect(store.getDeployment(target.id)).resolves.toMatchObject({
      status: "stopped",
    });
  });

  test("a protected deployment keeps its status and loses no artifacts", async () => {
    const store = createTestStore();
    const { project, deployments } = await createArchiveFixture(store);
    const newest = deployments[3]!;
    await store.updateDeploymentStatus(newest.id, "stopped");
    const runtime = {
      name: "docker",
      stopProcess: vi.fn(),
      removeRelease: vi.fn(),
    } as unknown as RuntimeAdapter;

    await expect(
      handleArchiveDeploymentJob(store, archiveJob(project.id, newest.id), {
        runtime,
        dataDir: "/tmp/eveland-archive-claim-test",
      }),
    ).rejects.toThrow(/protected/i);

    await expect(store.getDeployment(newest.id)).resolves.toMatchObject({
      status: "stopped",
    });
    expect(runtime.stopProcess).not.toHaveBeenCalled();
    expect(runtime.removeRelease).not.toHaveBeenCalled();
  });

  test("an unclassified topology keeps its artifact until the cutover classifies it", async () => {
    const store = createTestStore();
    const { project, revisionId } = await (async () => {
      const fixture = await createArchiveFixture(store);
      const release = await store.getRelease(fixture.target.releaseId);
      return { project: fixture.project, revisionId: release!.sourceRevisionId };
    })();
    // A historical deployment with no attestation, outside the retention
    // window and stopped — archivable in every way except its topology.
    const unclassified = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revisionId,
      imageTag: "fixture:archive-unknown",
      containerName: "fixture-archive-unknown",
      internalPort: 3000,
      hostPort: 42_110,
      runtimeKind: "docker",
    });
    for (let index = 0; index < 3; index += 1) {
      await store.recordDeployment({
        projectId: project.id,
        sourceRevisionId: revisionId,
        imageTag: `fixture:archive-newer-${index}`,
        containerName: `fixture-archive-newer-${index}`,
        internalPort: 3000,
        hostPort: 42_120 + index,
        runtimeKind: "docker",
        workflowWorld: sharedWorkflowWorldAttestation,
      });
    }
    await store.updateDeploymentStatus(unclassified.id, "stopped");
    const runtime = {
      name: "docker",
      stopProcess: vi.fn(),
      removeRelease: vi.fn(),
    } as unknown as RuntimeAdapter;

    // The automatic sweep skips it quietly; a manual archive gets the reason.
    await handleArchiveDeploymentJob(store, archiveJob(project.id, unclassified.id, true), {
      runtime,
      dataDir: "/tmp/eveland-archive-claim-test",
    });
    await expect(
      handleArchiveDeploymentJob(store, archiveJob(project.id, unclassified.id), {
        runtime,
        dataDir: "/tmp/eveland-archive-claim-test",
      }),
    ).rejects.toThrow(/finish converting or be managed-terminated/);

    expect(runtime.stopProcess).not.toHaveBeenCalled();
    expect(runtime.removeRelease).not.toHaveBeenCalled();
    await expect(store.getDeployment(unclassified.id)).resolves.toMatchObject({
      status: "stopped",
    });
  });

  test("an already archived deployment is left alone", async () => {
    const store = createTestStore();
    const { project, target } = await createArchiveFixture(store);
    await store.updateDeploymentStatus(target.id, "archived");
    const runtime = {
      name: "docker",
      stopProcess: vi.fn(),
      removeRelease: vi.fn(),
    } as unknown as RuntimeAdapter;

    await handleArchiveDeploymentJob(store, archiveJob(project.id, target.id), {
      runtime,
      dataDir: "/tmp/eveland-archive-claim-test",
    });

    expect(runtime.stopProcess).not.toHaveBeenCalled();
    expect(runtime.removeRelease).not.toHaveBeenCalled();
    await expect(store.getDeployment(target.id)).resolves.toMatchObject({
      status: "archived",
    });
  });
});
