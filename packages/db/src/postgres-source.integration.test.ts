import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "./client.js";
import { createPostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.EVELAND_POSTGRES_TEST_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => database?.close());

describe.skipIf(!database)("Postgres source revisions", () => {
  test("advances current source without replacing an existing deployment", async () => {
    const store = createPostgresStore(database!);
    const project = await store.createProject({ name: `Resync integration ${Date.now()}`, importKind: "git" });

    try {
      const initialRevision = await store.recordSourceRevision({
        projectId: project.id,
        kind: "git",
        commitSha: "old-commit",
        sourcePath: "/tmp/source-old",
        summary: {},
        envVars: [],
        files: [
          { path: "agent/instructions.md", content: "Old instructions" },
          { path: "package.json", content: JSON.stringify({ dependencies: { eve: "0.22.6" } }) },
        ],
        schedules: [],
      });
      const deployment = await store.recordDeployment({
        projectId: project.id,
        sourceRevisionId: initialRevision.id,
        imageTag: "eveland/resync:old",
        containerName: `eveland-resync-${Date.now()}`,
        internalPort: 3000,
        hostPort: 41995,
        runtimeKind: "docker",
      });

      const nextRevision = await store.recordSourceRevision({
        projectId: project.id,
        kind: "git",
        commitSha: "new-commit",
        sourcePath: "/tmp/source-new",
        summary: {},
        envVars: [],
        files: [{ path: "agent/instructions.md", content: "New instructions" }],
        schedules: [],
      });

      await expect(store.getProject(project.id)).resolves.toMatchObject({
        status: "deployed",
        deploymentStatus: "running",
        deploymentId: deployment.id,
        sourceRevisionId: nextRevision.id,
      });
      await expect(store.getCurrentSourceRevision(project.id)).resolves.toMatchObject({
        id: nextRevision.id,
        commitSha: "new-commit",
      });
      await expect(store.getSourceFile(project.id, "agent/instructions.md")).resolves.toMatchObject({
        content: "New instructions",
      });
      await expect(store.getDeploymentEveVersion(deployment.id)).resolves.toEqual({
        version: "0.22.6",
        expected: "0.25.x, 0.26.x, or 0.27.x",
        supportedRanges: ["0.25.x", "0.26.x", "0.27.x"],
        supported: false,
        sourceRevisionId: initialRevision.id,
      });
    } finally {
      await store.deleteProject(project.id);
    }
  });
});
