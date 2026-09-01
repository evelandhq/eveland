import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "./client.js";
import { createPostgresStore } from "./postgres-store.js";
import { resolvePostgresTestUrl } from "./postgres-integration.test-support.js";

const databaseUrl = resolvePostgresTestUrl();
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => database?.close());

describe.skipIf(!database)("Postgres schedule state", () => {
  test("preserves versions and prevents duplicate runs across concurrent planners", async () => {
    const store = createPostgresStore(database!);
    const project = await store.createProject({
      name: `Schedule integration ${Date.now()}`,
      importKind: "zip",
    });

    try {
      const revision = await store.recordSourceRevision({
        projectId: project.id,
        kind: "zip",
        sourcePath: "/tmp/postgres-schedule",
        summary: {},
        envVars: [],
        files: [],
        schedules: [],
      });
      const [entry] = await store.recordScheduleVersions({
        projectId: project.id,
        sourceRevisionId: revision.id,
        definitions: [
          {
            key: "nested/minute",
            kind: "handler",
            cron: "* * * * *",
            sourcePath: "agent/schedules/nested/minute.ts",
            definitionHash: "a".repeat(64),
          },
        ],
      });
      expect(entry?.schedule.key).toBe("nested/minute");
      const deployment = await store.recordDeployment({
        projectId: project.id,
        sourceRevisionId: revision.id,
        imageTag: "fixture:postgres-schedule",
        containerName: `postgres-schedule-${Date.now()}`,
        internalPort: 3000,
        hostPort: 41989,
        runtimeKind: "docker",
      });
      const activationClaims = await Promise.all([
        store.acquireActivationLease({
          deploymentId: deployment.id,
          kind: "schedule_run",
          ownerId: "srun_postgres_one",
          expiresAt: new Date("2026-07-15T00:10:00.000Z"),
          now: new Date("2026-07-15T00:00:00.000Z"),
        }),
        store.acquireActivationLease({
          deploymentId: deployment.id,
          kind: "public_request",
          ownerId: "req_postgres_one",
          expiresAt: new Date("2026-07-15T00:10:00.000Z"),
          now: new Date("2026-07-15T00:00:00.000Z"),
        }),
      ]);
      expect(activationClaims.filter((claim) => claim.starter)).toHaveLength(1);
      expect(new Set(activationClaims.map((claim) => claim.runtimeInstance.id)).size).toBe(1);
      const activationJobs = await Promise.all(
        activationClaims.map((claim) =>
          store.enqueueDeploymentActivation(project.id, deployment.id, claim.runtimeInstance.id),
        ),
      );
      expect(new Set(activationJobs.map((job) => job.id)).size).toBe(1);
      const renewed = await store.renewActivationLease(
        activationClaims[0]!.lease.id,
        new Date("2026-07-15T00:20:00.000Z"),
        new Date("2026-07-15T00:05:00.000Z"),
      );
      expect(renewed?.expiresAt).toBe("2026-07-15T00:20:00.000Z");
      await store.updateRuntimeInstance(
        activationClaims[0]!.runtimeInstance.id,
        {
          status: "ready",
          endpointHost: "127.0.0.1",
          endpointPort: deployment.hostPort,
        },
        new Date("2026-07-15T00:00:30.000Z"),
      );
      await Promise.all(
        activationClaims.map((claim) =>
          store.releaseActivationLease(claim.lease.id, new Date("2026-07-15T00:20:00.000Z")),
        ),
      );
      await expect(
        store.claimIdleRuntimeInstances({
          now: new Date("2026-07-15T00:20:59.999Z"),
          idleTtlMs: 60_000,
          limit: 10,
        }),
      ).resolves.toEqual([]);
      await expect(
        store.claimIdleRuntimeInstances({
          now: new Date("2026-07-15T00:21:00.000Z"),
          idleTtlMs: 60_000,
          limit: 10,
        }),
      ).resolves.toContainEqual(
        expect.objectContaining({
          id: activationClaims[0]!.runtimeInstance.id,
          status: "draining",
        }),
      );
      await store.updateRuntimeInstance(activationClaims[0]!.runtimeInstance.id, {
        status: "stopped",
      });
      await store.setProjectSchedulerTarget(
        project.id,
        deployment.id,
        new Date("2026-07-15T00:00:30.000Z"),
      );
      await expect(
        store.listUpcomingScheduleTargets({
          after: new Date("2026-07-15T00:00:30.000Z"),
          before: new Date("2026-07-15T00:01:00.000Z"),
          limit: 10,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          scheduleId: entry!.schedule.id,
          projectId: project.id,
          deploymentId: deployment.id,
          nextRunAt: "2026-07-15T00:01:00.000Z",
        }),
      ]);
      const scheduleProtectedClaim = await store.acquireActivationLease({
        deploymentId: deployment.id,
        kind: "public_request",
        ownerId: "req_postgres_schedule_protection",
        expiresAt: new Date("2026-07-15T00:00:31.000Z"),
        now: new Date("2026-07-15T00:00:30.000Z"),
      });
      await store.updateRuntimeInstance(
        scheduleProtectedClaim.runtimeInstance.id,
        {
          status: "ready",
          endpointHost: "127.0.0.1",
          endpointPort: deployment.hostPort,
        },
        new Date("2026-07-15T00:00:30.000Z"),
      );
      await store.releaseActivationLease(
        scheduleProtectedClaim.lease.id,
        new Date("2026-07-15T00:00:31.000Z"),
      );
      await expect(
        store.claimIdleRuntimeInstances({
          now: new Date("2026-07-15T00:00:40.000Z"),
          idleTtlMs: 0,
          schedulePrewarmMs: 20_000,
          limit: 10,
        }),
      ).resolves.toEqual([]);
      await store.updateRuntimeInstance(scheduleProtectedClaim.runtimeInstance.id, {
        status: "stopped",
      });

      const manualDueAt = new Date("2026-07-15T00:00:45.000Z");
      const manualRuns = await Promise.all([
        store.createManualScheduleRun(project.id, entry!.schedule.id, manualDueAt),
        store.createManualScheduleRun(project.id, entry!.schedule.id, manualDueAt),
      ]);
      expect(new Set(manualRuns.map((run) => run.id)).size).toBe(2);

      const results = await Promise.all([
        store.claimDueScheduleRuns({ now: new Date("2026-07-15T00:05:10.000Z"), limit: 10 }),
        store.claimDueScheduleRuns({ now: new Date("2026-07-15T00:05:10.000Z"), limit: 10 }),
      ]);

      expect(results.flat()).toHaveLength(1);
      expect(results.flat()[0]).toMatchObject({
        dueAt: "2026-07-15T00:01:00.000Z",
        missedTicks: 4,
      });
      await expect(
        store.listProjectScheduleVersions(project.id, revision.id),
      ).resolves.toHaveLength(1);
      const run = results.flat()[0]!;
      const runActivationClaims = await Promise.all([
        store.claimScheduleRunActivation(run.id),
        store.claimScheduleRunActivation(run.id),
      ]);
      expect(runActivationClaims.filter(Boolean)).toHaveLength(1);
      const redeemed = await Promise.all([
        store.redeemScheduleRunDispatch(run.id, deployment.id),
        store.redeemScheduleRunDispatch(run.id, deployment.id),
      ]);
      expect(redeemed.filter(Boolean)).toHaveLength(1);
      await expect(
        store.completeScheduleRun(run.id, {
          status: "succeeded",
          eveSessionIds: ["eve_postgres_schedule"],
        }),
      ).resolves.toMatchObject({ status: "running", completedAt: null });
      await expect(store.listSessions(project.id)).resolves.toContainEqual(
        expect.objectContaining({
          eveSessionId: "eve_postgres_schedule",
          scheduleId: run.scheduleId,
          scheduleRunId: run.id,
          trigger: "cron",
        }),
      );
      await expect(store.listProjectScheduleSummaries(project.id)).resolves.toContainEqual(
        expect.objectContaining({
          schedule: expect.objectContaining({ id: run.scheduleId, key: "nested/minute" }),
          version: expect.objectContaining({ id: run.scheduleVersionId }),
          targetDeploymentId: deployment.id,
          latestRunStatus: "running",
        }),
      );
      await expect(
        store.listScheduleRuns(project.id, {
          scheduleId: run.scheduleId,
          trigger: "cron",
          status: "running",
          limit: 10,
        }),
      ).resolves.toMatchObject({
        items: [
          expect.objectContaining({ id: run.id, sessionCount: 1, sessions: [expect.any(Object)] }),
        ],
        nextCursor: null,
      });
      await expect(
        store.listSessionsPage(project.id, { scheduleRunId: run.id, trigger: "cron", limit: 10 }),
      ).resolves.toMatchObject({
        items: [expect.objectContaining({ scheduleRunId: run.id })],
        nextCursor: null,
      });
      await expect(store.getScheduleRunDetail(run.id)).resolves.toMatchObject({
        id: run.id,
        scheduleKey: "nested/minute",
        release: { id: run.releaseId },
        deployment: { id: deployment.id },
        sessions: [expect.objectContaining({ scheduleRunId: run.id })],
      });
    } finally {
      await store.deleteProject(project.id);
    }
  });

  test("adopts an unmanaged deployment exactly once under concurrency and defers to live instances", async () => {
    const store = createPostgresStore(database!);
    const project = await store.createProject({
      name: `Adoption integration ${Date.now()}`,
      importKind: "zip",
    });

    try {
      const revision = await store.recordSourceRevision({
        projectId: project.id,
        kind: "zip",
        sourcePath: "/tmp/postgres-adoption",
        summary: {},
        envVars: [],
        files: [],
        schedules: [],
      });
      const containerName = `postgres-adoption-${Date.now()}`;
      const deployment = await store.recordDeployment({
        projectId: project.id,
        sourceRevisionId: revision.id,
        imageTag: "fixture:postgres-adoption",
        containerName,
        internalPort: 3000,
        hostPort: 41988,
        runtimeKind: "docker",
      });
      await expect(store.getDeploymentByContainerName(containerName)).resolves.toMatchObject({
        id: deployment.id,
      });

      const now = new Date("2026-07-16T10:00:00.000Z");
      const adoptions = await Promise.all([
        store.adoptRuntimeInstance(
          deployment.id,
          { endpointHost: "127.0.0.1", endpointPort: deployment.hostPort },
          now,
        ),
        store.adoptRuntimeInstance(
          deployment.id,
          { endpointHost: "127.0.0.1", endpointPort: deployment.hostPort },
          now,
        ),
      ]);
      const adopted = adoptions.filter(Boolean);
      expect(adopted).toHaveLength(1);
      expect(adopted[0]).toMatchObject({
        status: "ready",
        generation: 1,
        endpointPort: deployment.hostPort,
      });
      await expect(store.listDeploymentRuntimeInstances(deployment.id)).resolves.toHaveLength(1);

      const claim = await store.acquireActivationLease({
        deploymentId: deployment.id,
        kind: "public_request",
        ownerId: "req_postgres_adopted",
        expiresAt: new Date("2026-07-16T10:01:00.000Z"),
        now,
      });
      expect(claim.starter).toBe(false);
      expect(claim.runtimeInstance.id).toBe(adopted[0]!.id);
      await store.releaseActivationLease(claim.lease.id, now);

      await expect(
        store.claimIdleRuntimeInstances({
          now: new Date("2026-07-16T10:05:00.000Z"),
          idleTtlMs: 300_000,
          limit: 10,
        }),
      ).resolves.toContainEqual(
        expect.objectContaining({ id: adopted[0]!.id, status: "draining" }),
      );
      await expect(
        store.adoptRuntimeInstance(
          deployment.id,
          { endpointHost: "127.0.0.1", endpointPort: deployment.hostPort },
          new Date("2026-07-16T10:05:01.000Z"),
        ),
      ).resolves.toBeNull();
      await store.updateRuntimeInstance(adopted[0]!.id, { status: "stopped" });
      await expect(
        store.adoptRuntimeInstance(
          deployment.id,
          { endpointHost: "127.0.0.1", endpointPort: deployment.hostPort },
          new Date("2026-07-16T10:06:00.000Z"),
        ),
      ).resolves.toMatchObject({ generation: 2, status: "ready" });
    } finally {
      await store.deleteProject(project.id);
    }
  });
});
