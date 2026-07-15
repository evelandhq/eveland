import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./store.js";

describe("schedule persistence", () => {
  test("keeps stable logical identity and immutable versions across source revisions", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Versioned schedules", importKind: "git" });
    const firstRevision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "git",
      sourcePath: "/tmp/v1",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });

    await store.recordScheduleVersions({
      projectId: project.id,
      sourceRevisionId: firstRevision.id,
      definitions: [
        {
          key: "billing/sweep",
          kind: "markdown",
          cron: "0 3 * * *",
          sourcePath: "agent/schedules/billing/sweep.md",
          definitionHash: "hash-v1",
        },
        {
          key: "cleanup",
          kind: "handler",
          cron: "15 4 * * *",
          sourcePath: "agent/schedules/cleanup.ts",
          definitionHash: "cleanup-v1",
        },
        {
          key: "ops/sweep",
          kind: "handler",
          cron: "30 4 * * *",
          sourcePath: "agent/schedules/ops/sweep.ts",
          definitionHash: "ops-sweep-v1",
        },
      ],
    });

    const first = await store.listProjectScheduleVersions(project.id, firstRevision.id);
    const stableId = first.find((entry) => entry.schedule.key === "billing/sweep")?.schedule.id;
    const cleanupId = first.find((entry) => entry.schedule.key === "cleanup")?.schedule.id;
    const nestedSweepIds = first
      .filter((entry) => entry.schedule.key.endsWith("/sweep"))
      .map((entry) => entry.schedule.id);
    expect(first).toHaveLength(3);
    expect(stableId).toMatch(/^sch_/);
    expect(new Set(nestedSweepIds).size).toBe(2);

    const firstDeployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: firstRevision.id,
      imageTag: "fixture:version-one",
      containerName: "fixture-version-one",
      internalPort: 3000,
      hostPort: 41987,
      runtimeKind: "docker",
    });
    await store.setProjectSchedulerTarget(project.id, firstDeployment.id, new Date("2026-07-15T00:00:00.000Z"));
    await expect(store.getProjectSchedule(cleanupId!)).resolves.toMatchObject({ nextRunAt: expect.any(String) });

    const secondRevision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "git",
      sourcePath: "/tmp/v2",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordScheduleVersions({
      projectId: project.id,
      sourceRevisionId: secondRevision.id,
      definitions: [
        {
          key: "billing/sweep",
          kind: "markdown",
          cron: "30 3 * * *",
          sourcePath: "agent/schedules/billing/sweep.md",
          definitionHash: "hash-v2",
        },
      ],
    });

    const second = await store.listProjectScheduleVersions(project.id, secondRevision.id);
    expect(second).toHaveLength(1);
    expect(second[0]?.schedule.id).toBe(stableId);
    expect(second[0]?.version).toMatchObject({ cron: "30 3 * * *", definitionHash: "hash-v2" });
    const secondDeployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: secondRevision.id,
      imageTag: "fixture:version-two",
      containerName: "fixture-version-two",
      internalPort: 3000,
      hostPort: 41988,
      runtimeKind: "docker",
    });
    await store.setProjectSchedulerTarget(project.id, secondDeployment.id, new Date("2026-07-15T01:00:00.000Z"));
    await expect(store.getProjectSchedule(cleanupId!)).resolves.toMatchObject({ nextRunAt: null });
    await expect(store.listProjectScheduleVersions(project.id, firstRevision.id)).resolves.toHaveLength(3);
  });

  test("coalesces due ticks and atomically creates one run and one job under concurrent planners", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Planner race", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    if (!importJob) throw new Error("Expected the fixture import job.");
    await store.completeJob(importJob.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/planner",
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
          key: "minute",
          kind: "handler",
          cron: "* * * * *",
          sourcePath: "agent/schedules/minute.ts",
          definitionHash: "minute-v1",
        },
      ],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:planner",
      containerName: "fixture-planner",
      internalPort: 3000,
      hostPort: 41990,
      runtimeKind: "docker",
    });
    await store.setProjectSchedulerTarget(project.id, deployment.id, new Date("2026-07-15T00:00:30.000Z"));

    const results = await Promise.all([
      store.claimDueScheduleRuns({ now: new Date("2026-07-15T00:05:10.000Z"), limit: 10 }),
      store.claimDueScheduleRuns({ now: new Date("2026-07-15T00:05:10.000Z"), limit: 10 }),
    ]);
    const runs = results.flat();

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      deploymentId: deployment.id,
      releaseId: deployment.releaseId,
      dueAt: "2026-07-15T00:01:00.000Z",
      status: "queued",
      missedTicks: 4,
    });
    await expect(store.claimNextJob("planner-test")).resolves.toMatchObject({
      type: "trigger_schedule",
      payload: { scheduleRunId: runs[0]?.id },
    });
    await expect(store.claimNextJob("planner-test")).resolves.toBeNull();

    const activationClaims = await Promise.all([
      store.claimScheduleRunActivation(runs[0]!.id),
      store.claimScheduleRunActivation(runs[0]!.id),
    ]);
    expect(activationClaims.filter(Boolean)).toHaveLength(1);
    const dispatchClaims = await Promise.all([
      store.redeemScheduleRunDispatch(runs[0]!.id, deployment.id),
      store.redeemScheduleRunDispatch(runs[0]!.id, deployment.id),
    ]);
    expect(dispatchClaims.filter(Boolean)).toHaveLength(1);
    expect(dispatchClaims.filter(Boolean)[0]).toMatchObject({ status: "dispatching", attempt: 1 });

    await expect(
      store.completeScheduleRun(runs[0]!.id, {
        status: "succeeded",
        eveSessionIds: ["eve_schedule_one", "eve_schedule_two"],
      }),
    ).resolves.toMatchObject({ status: "succeeded", completedAt: expect.any(String) });
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        deploymentId: deployment.id,
        eveSessionId: "eve_schedule_one",
        trigger: "cron",
        scheduleId: runs[0]!.scheduleId,
        scheduleRunId: runs[0]!.id,
      }),
      expect.objectContaining({
        deploymentId: deployment.id,
        eveSessionId: "eve_schedule_two",
        trigger: "cron",
        scheduleId: runs[0]!.scheduleId,
        scheduleRunId: runs[0]!.id,
      }),
    ]);
  });

  test("creates manual runs on the explicitly promoted scheduler target and pins provenance", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Manual schedule", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/manual",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const versions = await store.recordScheduleVersions({
      projectId: project.id,
      sourceRevisionId: revision.id,
      definitions: [{
        key: "billing/sweep",
        kind: "handler",
        cron: "0 3 * * *",
        sourcePath: "agent/schedules/billing/sweep.ts",
        definitionHash: "manual-v1",
      }],
    });
    const schedule = versions[0]?.schedule;
    if (!schedule) throw new Error("Expected the schedule version fixture.");
    const preview = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:preview",
      containerName: "fixture-preview",
      internalPort: 3000,
      hostPort: 41991,
      runtimeKind: "docker",
    });
    const production = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:production",
      containerName: "fixture-production",
      internalPort: 3000,
      hostPort: 41992,
      runtimeKind: "docker",
    });
    await store.ensureDeploymentRoutes(project.id, preview.id, "agent.localhost");
    await store.ensureDeploymentRoutes(project.id, production.id, "agent.localhost");
    await store.setProjectSchedulerTarget(project.id, preview.id);

    await store.promoteDeployment(project.id, production.id);
    const run = await store.createManualScheduleRun(project.id, schedule.id, new Date("2026-07-15T01:02:03.000Z"));

    expect(run).toMatchObject({
      scheduleId: schedule.id,
      deploymentId: production.id,
      releaseId: production.releaseId,
      trigger: "manual",
      status: "queued",
      dueAt: "2026-07-15T01:02:03.000Z",
    });
    await expect(store.claimNextJob("manual-run")).resolves.toMatchObject({
      type: "trigger_schedule",
      payload: { scheduleRunId: run.id },
    });

    await store.claimScheduleRunActivation(run.id);
    await store.redeemScheduleRunDispatch(run.id, production.id);
    await expect(store.completeScheduleRun(run.id, { status: "succeeded", eveSessionIds: [] })).resolves.toMatchObject({
      id: run.id,
      status: "succeeded",
    });
    await expect(store.listSessions(project.id)).resolves.toEqual([]);
  });
});
