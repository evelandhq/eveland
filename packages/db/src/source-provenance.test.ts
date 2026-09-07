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
    // The single-release read is the same projection.
    await expect(store.getReleaseSource(deployments[1]!.releaseId)).resolves.toEqual(
      sources[deployments[1]!.releaseId],
    );
    await expect(store.getReleaseSource("rel_missing")).resolves.toBeNull();
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
