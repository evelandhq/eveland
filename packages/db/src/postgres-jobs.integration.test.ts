import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "./client.js";
import { createPostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.EVELAND_POSTGRES_TEST_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => database?.close());

describe.skipIf(!database)("Postgres job leases", () => {
  test("recovers a stale job and fences its previous attempt", async () => {
    const store = createPostgresStore(database!);
    const project = await store.createProject({ name: `Lease integration ${Date.now()}`, importKind: "zip" });
    const first = await store.claimNextJob("worker-a", new Date("2026-07-17T00:00:00.000Z"));
    const firstAttempt = first!.attempts;

    try {
      await expect(store.recoverStaleJobs(new Date("2026-07-17T00:01:00.000Z"), 30_000)).resolves.toBe(1);
      const second = await store.claimNextJob("worker-b", new Date("2026-07-17T00:01:01.000Z"));
      expect(second).toMatchObject({ id: first!.id, attempts: 2, status: "running" });
      await expect(store.completeJob(first!.id, firstAttempt)).resolves.toBe(false);
      await expect(store.completeJob(second!.id, second!.attempts)).resolves.toBe(true);
    } finally {
      await store.deleteProject(project.id);
    }
  });

  test("serializes concurrent archive enqueue attempts per deployment", async () => {
    const store = createPostgresStore(database!);
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
