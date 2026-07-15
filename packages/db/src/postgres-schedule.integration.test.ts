import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "./client.js";
import { createPostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.EVELAND_POSTGRES_TEST_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => database?.close());

describe.skipIf(!database)("Postgres schedule state", () => {
  test("preserves versions and prevents duplicate runs across concurrent planners", async () => {
    const store = createPostgresStore(database!);
    const project = await store.createProject({ name: `Schedule integration ${Date.now()}`, importKind: "zip" });

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
            definitionHash: "postgres-minute-v1",
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
      await Promise.all(activationClaims.map((claim) => store.releaseActivationLease(claim.lease.id)));
      await store.setProjectSchedulerTarget(project.id, deployment.id, new Date("2026-07-15T00:00:30.000Z"));

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
      expect(results.flat()[0]).toMatchObject({ dueAt: "2026-07-15T00:01:00.000Z", missedTicks: 4 });
      await expect(store.listProjectScheduleVersions(project.id, revision.id)).resolves.toHaveLength(1);
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
        store.completeScheduleRun(run.id, { status: "succeeded", eveSessionIds: ["eve_postgres_schedule"] }),
      ).resolves.toMatchObject({ status: "succeeded" });
      await expect(store.listSessions(project.id)).resolves.toContainEqual(
        expect.objectContaining({
          eveSessionId: "eve_postgres_schedule",
          scheduleId: run.scheduleId,
          scheduleRunId: run.id,
          trigger: "cron",
        }),
      );
    } finally {
      await store.deleteProject(project.id);
    }
  });
});
