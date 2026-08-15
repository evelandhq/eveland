import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";
import { calculateScheduleAdvance } from "./postgres-schedule-store.js";

describe("schedule persistence", () => {
  test("isolates a corrupt legacy cron row from the rest of the planner batch", () => {
    expect(
      calculateScheduleAdvance(
        "not cron",
        new Date("2026-07-15T00:01:00.000Z"),
        new Date("2026-07-15T00:05:10.000Z"),
      ),
    ).toBeUndefined();
    expect(
      calculateScheduleAdvance(
        "* * * * *",
        new Date("2026-07-15T00:01:00.000Z"),
        new Date("2026-07-15T00:05:10.000Z"),
      ),
    ).toEqual({
      nextRunAt: new Date("2026-07-15T00:06:00.000Z"),
      missedTicks: 4,
    });
  });

  test.each([
    [
      "invalid cron",
      {
        key: "sync",
        cron: "not cron",
        sourcePath: "agent/schedules/sync.ts",
        definitionHash: "a".repeat(64),
      },
    ],
    [
      "empty key",
      {
        key: "",
        cron: "0 2 * * *",
        sourcePath: "agent/schedules/sync.ts",
        definitionHash: "a".repeat(64),
      },
    ],
    [
      "escaping source path",
      {
        key: "sync",
        cron: "0 2 * * *",
        sourcePath: "../sync.ts",
        definitionHash: "a".repeat(64),
      },
    ],
    [
      "escaping key",
      {
        key: "../sync",
        cron: "0 2 * * *",
        sourcePath: "agent/schedules/sync.ts",
        definitionHash: "a".repeat(64),
      },
    ],
    [
      "malformed definition hash",
      {
        key: "sync",
        cron: "0 2 * * *",
        sourcePath: "agent/schedules/sync.ts",
        definitionHash: "hash",
      },
    ],
    [
      "empty definition hash",
      { key: "sync", cron: "0 2 * * *", sourcePath: "agent/schedules/sync.ts", definitionHash: "" },
    ],
  ])("rejects %s before persisting an immutable schedule version", async (_label, invalid) => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Invalid schedule", importKind: "git" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "git",
      sourcePath: "/tmp/invalid",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });

    await expect(
      store.recordScheduleVersions({
        projectId: project.id,
        sourceRevisionId: revision.id,
        definitions: [{ ...invalid, kind: "handler" }],
      }),
    ).rejects.toThrow();
    await expect(store.listProjectScheduleVersions(project.id, revision.id)).resolves.toEqual([]);
  });

  test("keeps stable logical identity and immutable versions across source revisions", async () => {
    const store = createTestStore();
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
          definitionHash: "a".repeat(64),
        },
        {
          key: "cleanup",
          kind: "handler",
          cron: "15 4 * * *",
          sourcePath: "agent/schedules/cleanup.ts",
          definitionHash: "b".repeat(64),
        },
        {
          key: "ops/sweep",
          kind: "handler",
          cron: "30 4 * * *",
          sourcePath: "agent/schedules/ops/sweep.ts",
          definitionHash: "c".repeat(64),
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
    await store.setProjectSchedulerTarget(
      project.id,
      firstDeployment.id,
      new Date("2026-07-15T00:00:00.000Z"),
    );
    await expect(store.getProjectSchedule(cleanupId!)).resolves.toMatchObject({
      nextRunAt: expect.any(String),
    });

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
          definitionHash: "d".repeat(64),
        },
      ],
    });

    const second = await store.listProjectScheduleVersions(project.id, secondRevision.id);
    expect(second).toHaveLength(1);
    expect(second[0]?.schedule.id).toBe(stableId);
    expect(second[0]?.version).toMatchObject({
      cron: "30 3 * * *",
      definitionHash: "d".repeat(64),
    });
    const secondDeployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: secondRevision.id,
      imageTag: "fixture:version-two",
      containerName: "fixture-version-two",
      internalPort: 3000,
      hostPort: 41988,
      runtimeKind: "docker",
    });
    await store.setProjectSchedulerTarget(
      project.id,
      secondDeployment.id,
      new Date("2026-07-15T01:00:00.000Z"),
    );
    await expect(store.getProjectSchedule(cleanupId!)).resolves.toMatchObject({ nextRunAt: null });
    await expect(
      store.listProjectScheduleVersions(project.id, firstRevision.id),
    ).resolves.toHaveLength(3);
  });

  test("coalesces due ticks and atomically creates one run and one job under concurrent planners", async () => {
    const store = createTestStore();
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
          definitionHash: "a".repeat(64),
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
    await store.setProjectSchedulerTarget(
      project.id,
      deployment.id,
      new Date("2026-07-15T00:00:30.000Z"),
    );

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
    ).resolves.toMatchObject({ status: "running", completedAt: null });
    const scheduledSessions = await store.listSessions(project.id);
    expect(scheduledSessions).toHaveLength(2);
    expect(scheduledSessions).toEqual(
      expect.arrayContaining([
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
      ]),
    );
  });

  test("creates manual runs on the explicitly promoted scheduler target and pins provenance", async () => {
    const store = createTestStore();
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
      definitions: [
        {
          key: "billing/sweep",
          kind: "handler",
          cron: "0 3 * * *",
          sourcePath: "agent/schedules/billing/sweep.ts",
          definitionHash: "a".repeat(64),
        },
      ],
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
    const run = await store.createManualScheduleRun(
      project.id,
      schedule.id,
      new Date("2026-07-15T01:02:03.000Z"),
    );

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
    await expect(
      store.completeScheduleRun(run.id, { status: "succeeded", eveSessionIds: [] }),
    ).resolves.toMatchObject({
      id: run.id,
      status: "succeeded",
    });
    await expect(store.listSessions(project.id)).resolves.toEqual([]);
  });

  test("keeps a successful dispatch running while its returned Session is active", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Running schedule execution",
      importKind: "zip",
    });
    await store.completeJob((await store.claimNextJob("fixture-import"))!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/running-schedule-execution",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const [recorded] = await store.recordScheduleVersions({
      projectId: project.id,
      sourceRevisionId: revision.id,
      definitions: [
        {
          key: "daily-topics",
          kind: "markdown",
          cron: "0 2 * * *",
          sourcePath: "agent/schedules/daily-topics.md",
          definitionHash: "a".repeat(64),
        },
      ],
    });
    if (!recorded) throw new Error("Expected schedule fixture.");
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:running-schedule",
      containerName: "fixture-running-schedule",
      internalPort: 3000,
      hostPort: 41995,
      runtimeKind: "docker",
    });
    await store.setProjectSchedulerTarget(project.id, deployment.id);
    const run = await store.createManualScheduleRun(
      project.id,
      recorded.schedule.id,
      new Date("2026-07-28T02:21:14.000Z"),
    );
    await store.claimScheduleRunActivation(run.id);
    await store.redeemScheduleRunDispatch(run.id, deployment.id);

    const dispatched = await store.completeScheduleRun(run.id, {
      status: "succeeded",
      eveSessionIds: ["eve_long_running_schedule"],
    });

    expect(dispatched).toMatchObject({
      id: run.id,
      status: "running",
      completedAt: null,
    });
    await expect(store.listSessions(project.id)).resolves.toContainEqual(
      expect.objectContaining({
        eveSessionId: "eve_long_running_schedule",
        scheduleRunId: run.id,
        status: "running",
      }),
    );
  });

  test("paginates filtered run and Session history with zero-Session runs and aggregate usage", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Schedule history", importKind: "zip" });
    await store.completeJob((await store.claimNextJob("fixture-import"))!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/schedule-history",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const recorded = await store.recordScheduleVersions({
      projectId: project.id,
      sourceRevisionId: revision.id,
      definitions: [
        {
          key: "billing/sweep",
          kind: "handler",
          cron: "0 3 * * *",
          sourcePath: "agent/schedules/billing/sweep.ts",
          definitionHash: "a".repeat(64),
        },
      ],
    });
    const entry = recorded[0];
    if (!entry) throw new Error("Expected schedule history fixture.");
    const { schedule, version } = entry;
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:history",
      containerName: "fixture-history",
      internalPort: 3000,
      hostPort: 41994,
      runtimeKind: "docker",
    });
    await store.setProjectSchedulerTarget(
      project.id,
      deployment.id,
      new Date("2026-07-15T00:00:00.000Z"),
    );
    const zeroSessionRun = await store.createManualScheduleRun(
      project.id,
      schedule.id,
      new Date("2026-07-15T01:00:00.000Z"),
    );
    await store.completeScheduleRun(zeroSessionRun.id, { status: "succeeded", eveSessionIds: [] });
    const usedRun = await store.createManualScheduleRun(
      project.id,
      schedule.id,
      new Date("2026-07-15T02:00:00.000Z"),
    );
    await store.completeScheduleRun(usedRun.id, {
      status: "succeeded",
      eveSessionIds: ["eve_history_one", "eve_history_two"],
    });
    const linked = await store.listSessions(project.id);
    await store.recordModelUsage(linked[0]!.id, {
      eveSessionId: linked[0]!.eveSessionId!,
      turnId: "turn_1",
      stepIndex: 0,
      inputTokens: 8,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
      finishReason: "stop",
      usageReported: true,
    });
    await store.recordModelUsage(linked[1]!.id, {
      eveSessionId: linked[1]!.eveSessionId!,
      turnId: "turn_2",
      stepIndex: 0,
      inputTokens: 3,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
      finishReason: "stop",
      usageReported: true,
    });

    await expect(store.listProjectScheduleSummaries(project.id)).resolves.toEqual([
      {
        schedule: expect.objectContaining({ id: schedule.id, key: "billing/sweep" }),
        version,
        targetDeploymentId: deployment.id,
      },
    ]);
    const firstPage = await store.listScheduleRuns(project.id, {
      scheduleId: schedule.id,
      trigger: "manual",
      limit: 1,
    });
    expect(firstPage).toMatchObject({
      items: [
        expect.objectContaining({
          id: usedRun.id,
          scheduleKey: "billing/sweep",
          sessionCount: 2,
          usage: expect.objectContaining({ inputTokens: 11, outputTokens: 7 }),
        }),
      ],
      nextCursor: usedRun.id,
    });
    await expect(
      store.listScheduleRuns(project.id, {
        scheduleId: schedule.id,
        cursor: firstPage.nextCursor!,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          id: zeroSessionRun.id,
          sessionCount: 0,
          usage: expect.objectContaining({ status: "none" }),
        }),
      ],
      nextCursor: null,
    });
    await expect(
      store.listSessionsPage(project.id, {
        scheduleRunId: usedRun.id,
        trigger: "manual",
        limit: 10,
      }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({ scheduleRunId: usedRun.id }),
        expect.objectContaining({ scheduleRunId: usedRun.id }),
      ],
      nextCursor: null,
    });
    await expect(store.getScheduleRunDetail(usedRun.id)).resolves.toMatchObject({
      id: usedRun.id,
      scheduleKey: "billing/sweep",
      version: { id: version.id },
      release: { id: deployment.releaseId },
      deployment: { id: deployment.id },
      sessionCount: 2,
      usage: expect.objectContaining({ inputTokens: 11, outputTokens: 7 }),
      sessions: [expect.any(Object), expect.any(Object)],
    });
  });
});
