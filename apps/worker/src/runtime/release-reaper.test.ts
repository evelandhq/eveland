import type { DeploymentRecord } from "@eveland/core/contracts";
import { createTestStore } from "@eveland/db/vitest";
import { describe, expect, test } from "vitest";
import { sweepReleaseRetention } from "./release-reaper.js";

describe("sweepReleaseRetention", () => {
  test("enqueues one archive job for each stopped deployment beyond retention without duplicating active jobs", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Release Sweep Agent",
      importKind: "zip",
    });
    const importJob = await store.claimNextJob("release-sweep-fixture");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/release-sweep",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployments: DeploymentRecord[] = [];
    for (let index = 0; index < 5; index += 1) {
      const deployment = await store.recordDeployment({
        projectId: project.id,
        sourceRevisionId: revision.id,
        imageTag: `release-sweep:${index}`,
        containerName: `release-sweep-${index}`,
        internalPort: 3000,
        hostPort: 41800 + index,
        runtimeKind: "systemd",
      });
      await store.updateDeploymentStatus(deployment.id, "stopped");
      deployments.push(deployment);
    }

    await expect(
      sweepReleaseRetention(store, { keepRecent: 3, limit: 25 }),
    ).resolves.toBe(2);
    await expect(
      sweepReleaseRetention(store, { keepRecent: 3, limit: 25 }),
    ).resolves.toBe(0);

    const archiveJobs = await store.listProjectJobs(project.id, {
      type: "archive_deployment",
      limit: 10,
    });
    expect(archiveJobs).toHaveLength(2);
    expect(
      archiveJobs.map((job) => job.payload.deploymentId).sort(),
    ).toEqual(deployments.slice(0, 2).map((deployment) => deployment.id).sort());
  });

  test("falls back to the minimum retention when configuration is invalid", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Invalid Retention Agent",
      importKind: "zip",
    });
    const importJob = await store.claimNextJob("invalid-retention-fixture");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/invalid-retention",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    for (let index = 0; index < 5; index += 1) {
      const deployment = await store.recordDeployment({
        projectId: project.id,
        sourceRevisionId: revision.id,
        imageTag: `invalid-retention:${index}`,
        containerName: `invalid-retention-${index}`,
        internalPort: 3000,
        hostPort: 41820 + index,
        runtimeKind: "systemd",
      });
      await store.updateDeploymentStatus(deployment.id, "stopped");
    }

    await expect(
      sweepReleaseRetention(store, { keepRecent: Number.NaN, limit: 25 }),
    ).resolves.toBe(2);
  });

  test("does not enqueue archive work while a project is deleting", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Deleting Release Agent",
      importKind: "zip",
    });
    const importJob = await store.claimNextJob("deleting-release-fixture");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/deleting-release",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    for (let index = 0; index < 4; index += 1) {
      const deployment = await store.recordDeployment({
        projectId: project.id,
        sourceRevisionId: revision.id,
        imageTag: `deleting-release:${index}`,
        containerName: `deleting-release-${index}`,
        internalPort: 3000,
        hostPort: 41840 + index,
        runtimeKind: "systemd",
      });
      await store.updateDeploymentStatus(deployment.id, "stopped");
    }
    await store.requestProjectDeletion(project.id);

    await expect(sweepReleaseRetention(store)).resolves.toBe(0);
    await expect(
      store.listProjectJobs(project.id, {
        type: "archive_deployment",
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  test("archives an old stopped deployment after its Playground binding expires", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Expired Playground Sweep Agent",
      importKind: "zip",
    });
    const importJob = await store.claimNextJob("expired-playground-fixture");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/expired-playground-sweep",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployments: DeploymentRecord[] = [];
    for (let index = 0; index < 4; index += 1) {
      const deployment = await store.recordDeployment({
        projectId: project.id,
        sourceRevisionId: revision.id,
        imageTag: `expired-playground:${index}`,
        containerName: `expired-playground-${index}`,
        internalPort: 3000,
        hostPort: 41860 + index,
        runtimeKind: "systemd",
      });
      await store.updateDeploymentStatus(deployment.id, "stopped");
      deployments.push(deployment);
    }
    const [projectRoute] = await store.ensureDeploymentRoutes(
      project.id,
      deployments[3]!.id,
      "agent.localhost",
    );
    await store.bindSession({
      projectId: project.id,
      eveSessionId: "eve_expired_playground_sweep",
      continuationToken: "continue_expired_playground_sweep",
      routeId: projectRoute!.id,
      deploymentId: deployments[0]!.id,
      trigger: "playground",
      variantName: null,
      experimentId: null,
      requestId: "request_expired_playground_sweep",
      remoteIp: null,
      affinityFingerprint: null,
      affinitySource: null,
    });

    await expect(
      sweepReleaseRetention(store, {
        keepRecent: 3,
        limit: 25,
        now: new Date("2026-07-30T12:00:00.000Z"),
        playgroundIdleTtlMs: 86_400_000,
        apiIdleTtlMs: 604_800_000,
      }),
    ).resolves.toBe(1);
  });
});
