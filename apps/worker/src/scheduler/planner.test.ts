import type { Store } from "@evelandhq/db";
import { createTestStore } from "@evelandhq/db/vitest";
import { describe, expect, test, vi } from "vitest";
import { planDueSchedules } from "./planner.js";

describe("planDueSchedules", () => {
  test("does not prewarm the next tick while the current tick is already queued for the same Deployment", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Due Scheduler Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/due-scheduler-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordScheduleVersions({
      projectId: project.id,
      sourceRevisionId: revision.id,
      definitions: [
        {
          key: "heartbeat",
          kind: "handler",
          cron: "* * * * *",
          sourcePath: "agent/schedules/heartbeat.ts",
          definitionHash: "a".repeat(64),
        },
      ],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:due-scheduler",
      containerName: "fixture-due-scheduler",
      internalPort: 3000,
      hostPort: 41986,
      runtimeKind: "docker",
    });
    await store.updateDeploymentStatus(deployment.id, "stopped");
    await store.setProjectSchedulerTarget(
      project.id,
      deployment.id,
      new Date("2026-07-16T03:00:00.000Z"),
    );

    await expect(
      planDueSchedules(store, {
        now: new Date("2026-07-16T03:01:00.000Z"),
        limit: 10,
        prewarmMs: 60_000,
        activationLeaseTtlMs: 70_000,
      }),
    ).resolves.toBe(1);

    const scheduleJob = await store.claimNextJob("due-worker");
    expect(scheduleJob).toMatchObject({
      type: "trigger_schedule",
      payload: { scheduleRunId: expect.any(String) },
    });
    await expect(store.listDeploymentRuntimeInstances(deployment.id)).resolves.toEqual([]);
  });

  test("prewarms a stopped scheduler target before its next run becomes due", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Prewarm Scheduler Agent",
      importKind: "zip",
    });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/prewarm-scheduler-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordScheduleVersions({
      projectId: project.id,
      sourceRevisionId: revision.id,
      definitions: [
        {
          key: "heartbeat",
          kind: "handler",
          cron: "* * * * *",
          sourcePath: "agent/schedules/heartbeat.ts",
          definitionHash: "a".repeat(64),
        },
      ],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:prewarm-scheduler",
      containerName: "fixture-prewarm-scheduler",
      internalPort: 3000,
      hostPort: 41987,
      runtimeKind: "docker",
    });
    await store.updateDeploymentStatus(deployment.id, "stopped");
    await store.setProjectSchedulerTarget(
      project.id,
      deployment.id,
      new Date("2026-07-16T03:00:00.000Z"),
    );

    await expect(
      planDueSchedules(store, {
        now: new Date("2026-07-16T03:00:10.000Z"),
        limit: 10,
        prewarmMs: 60_000,
        activationLeaseTtlMs: 70_000,
      }),
    ).resolves.toBe(0);

    const activationJob = await store.claimNextJob("prewarm-worker");
    expect(activationJob).toMatchObject({
      projectId: project.id,
      type: "ensure_deployment_running",
      payload: { deploymentId: deployment.id },
    });
    if (activationJob?.type !== "ensure_deployment_running") {
      throw new Error("Expected an activation job.");
    }
    const runtimeInstanceId = activationJob.payload.runtimeInstanceId;
    expect(typeof runtimeInstanceId).toBe("string");
    await expect(store.getRuntimeInstance(String(runtimeInstanceId))).resolves.toMatchObject({
      deploymentId: deployment.id,
      status: "starting",
    });
  });

  test("uses the durable bounded Store claim as the complete planning transaction", async () => {
    const claimDueScheduleRuns = vi
      .fn()
      .mockResolvedValue([{ id: "srun_one" }, { id: "srun_two" }]);
    const now = new Date("2026-07-15T03:04:05.000Z");

    await expect(
      planDueSchedules({ claimDueScheduleRuns } as unknown as Store, { now, limit: 25 }),
    ).resolves.toBe(2);
    expect(claimDueScheduleRuns).toHaveBeenCalledWith({ now, limit: 25 });
  });
});
