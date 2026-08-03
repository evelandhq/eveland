import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-integration.test-support.js";
import { createPostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.EVELAND_POSTGRES_TEST_URL;

// Claims and recovers from the global job queue, so it needs its own
// database; see postgres-integration.test-support.ts.
describe.skipIf(!databaseUrl)("Postgres job leases", () => {
  let harness: IsolatedPostgresDatabase;

  beforeAll(async () => {
    harness = await createIsolatedPostgresDatabase(databaseUrl!);
  });
  afterAll(async () => harness?.drop());

  test("recovers a stale job and fences its previous attempt", async () => {
    const store = createPostgresStore(harness.database);
    const project = await store.createProject({
      name: `Lease integration ${Date.now()}`,
      importKind: "zip",
    });
    const first = await store.claimNextJob("worker-a", new Date("2026-07-17T00:00:00.000Z"));
    const firstAttempt = first!.attempts;

    try {
      await expect(
        store.recoverStaleJobs(new Date("2026-07-17T00:01:00.000Z"), 30_000),
      ).resolves.toBe(1);
      const second = await store.claimNextJob("worker-b", new Date("2026-07-17T00:01:01.000Z"));
      expect(second).toMatchObject({ id: first!.id, attempts: 2, status: "running" });
      await expect(store.completeJob(first!.id, firstAttempt)).resolves.toBe(false);
      await expect(store.completeJob(second!.id, second!.attempts)).resolves.toBe(true);
    } finally {
      await store.deleteProject(project.id);
    }
  });

  test("serializes concurrent archive enqueue attempts per deployment", async () => {
    const store = createPostgresStore(harness.database);
    const project = await store.createProject({
      name: `Archive concurrency ${Date.now()}`,
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/archive-concurrency",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "archive-concurrency:release",
      containerName: "archive-concurrency-release",
      internalPort: 3000,
      hostPort: 41920,
      runtimeKind: "systemd",
    });

    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          store.enqueueDeploymentArchive(project.id, deployment.id, {
            automatic: true,
          }),
        ),
      );

      expect(results.filter((result) => result.created)).toHaveLength(1);
      await expect(
        store.listProjectJobs(project.id, {
          type: "archive_deployment",
          limit: 10,
        }),
      ).resolves.toHaveLength(1);
    } finally {
      await store.deleteProject(project.id);
    }
  });
});
