import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

describe("source revision provenance", () => {
  test("records where a revision came from and reads it back per release", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Provenance Agent",
      importKind: "git",
      gitUrl: "https://example.com/agent.git",
    });

    const synced = await store.recordSourceRevision({
      projectId: project.id,
      kind: "git",
      commitSha: "c".repeat(40),
      origin: "git-sync",
      sourcePath: "/tmp/synced",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const uploaded = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      origin: "cli-upload",
      baseCommitSha: "c".repeat(40),
      dirty: true,
      uploadedBy: "user_a",
      sourcePath: "/tmp/uploaded",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    // A revision recorded without provenance (older worker, plain directory)
    // reads back as unknown rather than failing or inventing an origin.
    const legacy = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/legacy",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });

    expect(synced).toMatchObject({
      origin: "git-sync",
      commitSha: "c".repeat(40),
      baseCommitSha: null,
      dirty: null,
      uploadedBy: null,
    });
    expect(uploaded).toMatchObject({
      kind: "zip",
      origin: "cli-upload",
      commitSha: null,
      baseCommitSha: "c".repeat(40),
      dirty: true,
      uploadedBy: "user_a",
    });
    expect(legacy).toMatchObject({ origin: null, baseCommitSha: null, dirty: null });
    await expect(store.getSourceRevision(uploaded.id)).resolves.toMatchObject({
      origin: "cli-upload",
      dirty: true,
      uploadedBy: "user_a",
    });

    const deployments = [];
    for (const [index, revision] of [synced, uploaded, legacy].entries()) {
      deployments.push(
        await store.recordDeployment({
          projectId: project.id,
          sourceRevisionId: revision.id,
          imageTag: `provenance-${index}`,
          containerName: `provenance-${index}`,
          internalPort: 3000,
          hostPort: 41_400 + index,
          runtimeKind: "docker",
        }),
      );
    }

    const sources = await store.listReleaseSources(project.id);
    expect(sources[deployments[0]!.releaseId]).toEqual({
      revisionId: synced.id,
      kind: "git",
      origin: "git-sync",
      commitSha: "c".repeat(40),
      baseCommitSha: null,
      dirty: null,
      uploadedBy: null,
      recordedAt: synced.createdAt,
    });
    // The uploader comes back with display fields, not just an id.
    expect(sources[deployments[1]!.releaseId]).toMatchObject({
      revisionId: uploaded.id,
      kind: "zip",
      origin: "cli-upload",
      baseCommitSha: "c".repeat(40),
      dirty: true,
      uploadedBy: { id: "user_a", email: "user-a@example.com", name: "Test User A" },
    });
    expect(sources[deployments[2]!.releaseId]).toMatchObject({
      revisionId: legacy.id,
      origin: null,
      uploadedBy: null,
    });
  });

  test("refuses an origin outside the recorded vocabulary", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Bad Origin Agent", importKind: "zip" });
    await expect(
      store.recordSourceRevision({
        projectId: project.id,
        kind: "zip",
        origin: "carrier-pigeon" as never,
        sourcePath: "/tmp/bad",
        summary: {},
        envVars: [],
        files: [],
        schedules: [],
      }),
    ).rejects.toThrow(/Failed query: insert into "source_revisions"/);
  });
});

describe("hotfix drift", () => {
  async function deploy(
    store: ReturnType<typeof createTestStore>,
    projectId: string,
    sourceRevisionId: string,
    index: number,
  ) {
    const deployment = await store.recordDeployment({
      projectId,
      sourceRevisionId,
      imageTag: `drift-${index}`,
      containerName: `drift-${index}`,
      internalPort: 3000,
      hostPort: 41_500 + index,
      runtimeKind: "docker",
    });
    await store.ensureDeploymentRoutes(projectId, deployment.id, "agent.localhost");
    return deployment;
  }

  test("is derived from the promoted deployment's revision origin on a git project", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Drift Agent",
      importKind: "git",
      gitUrl: "https://example.com/drift.git",
    });
    const synced = await store.recordSourceRevision({
      projectId: project.id,
      kind: "git",
      commitSha: "a".repeat(40),
      origin: "git-sync",
      sourcePath: "/tmp/synced",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    // The first deployment of a project becomes its production deployment
    // without an explicit promote.
    const syncedDeployment = await deploy(store, project.id, synced.id, 0);
    await expect(store.getProjectHotfixDrift(project.id)).resolves.toBeNull();

    const uploaded = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      origin: "cli-upload",
      baseCommitSha: "a".repeat(40),
      dirty: true,
      uploadedBy: "user_a",
      sourcePath: "/tmp/uploaded",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const hotfix = await deploy(store, project.id, uploaded.id, 1);
    // A preview of an upload is not drift: production still runs the commit.
    await expect(store.getProjectHotfixDrift(project.id)).resolves.toBeNull();

    await store.promoteDeployment(project.id, hotfix.id);
    await expect(store.getProjectHotfixDrift(project.id)).resolves.toEqual({
      deploymentId: hotfix.id,
      deploymentKey: hotfix.deploymentKey,
      releaseId: hotfix.releaseId,
      source: {
        revisionId: uploaded.id,
        kind: "zip",
        origin: "cli-upload",
        commitSha: null,
        baseCommitSha: "a".repeat(40),
        dirty: true,
        uploadedBy: { id: "user_a", email: "user-a@example.com", name: "Test User A" },
        recordedAt: uploaded.createdAt,
      },
    });

    // Drift clears the moment a git-sync revision is promoted again -- a
    // rollback included. Nothing compares tree contents.
    await store.promoteDeployment(project.id, syncedDeployment.id);
    await expect(store.getProjectHotfixDrift(project.id)).resolves.toBeNull();
  });

  test("never reports drift for zip projects or revisions without a recorded origin", async () => {
    const store = createTestStore();
    const zipProject = await store.createProject({ name: "Zip Drift Agent", importKind: "zip" });
    const zipUpload = await store.recordSourceRevision({
      projectId: zipProject.id,
      kind: "zip",
      origin: "cli-upload",
      uploadedBy: "user_a",
      sourcePath: "/tmp/zip-upload",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await deploy(store, zipProject.id, zipUpload.id, 0);
    await expect(store.getProjectHotfixDrift(zipProject.id)).resolves.toBeNull();

    const gitProject = await store.createProject({
      name: "Legacy Drift Agent",
      importKind: "git",
      gitUrl: "https://example.com/legacy.git",
    });
    // Recorded before provenance existed: its origin is unknown, and an
    // unknown origin is not evidence of a hotfix.
    const legacy = await store.recordSourceRevision({
      projectId: gitProject.id,
      kind: "zip",
      sourcePath: "/tmp/legacy",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await deploy(store, gitProject.id, legacy.id, 1);
    await expect(store.getProjectHotfixDrift(gitProject.id)).resolves.toBeNull();
    await expect(store.getProjectHotfixDrift("proj_missing")).resolves.toBeNull();
  });
});
