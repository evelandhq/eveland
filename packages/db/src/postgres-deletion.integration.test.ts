import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
} from "./postgres-integration.test-support.js";
import { createPostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.EVELAND_POSTGRES_TEST_URL;

// Claims from the global job queue, so it needs its own database; see
// postgres-integration.test-support.ts.
describe.skipIf(!databaseUrl)("Postgres project deletion", () => {
  let harness: IsolatedPostgresDatabase;

  beforeAll(async () => {
    harness = await createIsolatedPostgresDatabase(databaseUrl!);
  });
  afterAll(async () => harness?.drop());

  test("persists the deleting state and atomically replaces queued work with one deletion job", async () => {
    const store = createPostgresStore(harness.database);
    const pendingSourcePath = "/data/uploads/zip-postgres-pending/source";
    const project = await store.createProject({
      name: `Delete integration ${Date.now()}`,
      importKind: "zip",
      sourcePath: pendingSourcePath,
    });
    await store.enqueueJob(project.id, "build_deploy");

    try {
      const requestProjectDeletion = Reflect.get(store, "requestProjectDeletion");

      expect(requestProjectDeletion).toBeTypeOf("function");
      await expect(requestProjectDeletion.call(store, project.id)).resolves.toMatchObject({
        outcome: "queued",
        job: {
          projectId: project.id,
          type: "delete_project",
          status: "queued",
          payload: { sourcePaths: [pendingSourcePath] },
        },
      });
      await expect(store.getProject(project.id)).resolves.toMatchObject({
        deletionStatus: "deleting",
        deletionError: null,
      });
      await expect(requestProjectDeletion.call(store, project.id)).resolves.toEqual({
        outcome: "already_deleting",
      });
    } finally {
      await store.deleteProject(project.id);
    }
  });

  test("does not claim a deletion job while another worker is running project work", async () => {
    const store = createPostgresStore(harness.database);
    const project = await store.createProject({
      name: `Busy delete integration ${Date.now()}`,
      importKind: "zip",
    });
    const running = await store.claimNextJob("worker-a");
    await store.requestProjectDeletion(project.id);
    const otherProject = await store.createProject({
      name: `Other integration ${Date.now()}`,
      importKind: "zip",
    });

    try {
      const whileBusy = await store.claimNextJob("worker-b");

      expect(running).toMatchObject({ projectId: project.id, type: "import_source" });
      expect(whileBusy).toMatchObject({ projectId: otherProject.id, type: "import_source" });
      await store.completeJob(running!.id);
      await expect(store.claimNextJob("worker-c")).resolves.toMatchObject({
        projectId: project.id,
        type: "delete_project",
      });
    } finally {
      await store.deleteProject(project.id);
      await store.deleteProject(otherProject.id);
    }
  });
});
