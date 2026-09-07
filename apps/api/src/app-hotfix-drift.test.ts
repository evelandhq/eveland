import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { Store } from "@evelandhq/db";
import { createTestStore } from "@evelandhq/db/vitest";
import { createApp } from "./app.js";
import { createZipArchiveFixture } from "./app.test-support.js";

/**
 * Hotfix drift: a git project whose production runs an uploaded revision.
 * These tests cover how the API reports it and what it refuses while it lasts.
 */

const BASE_COMMIT = "b".repeat(40);

async function createGitProject(store: Store) {
  const project = await store.createProject({
    name: "Drift Agent",
    importKind: "git",
    gitUrl: "https://example.com/drift.git",
  });
  // The initial import queued by createProject is not under test here.
  const initialImport = await store.claimNextJob("fixture-import");
  await store.completeJob(initialImport!.id);
  return project;
}

async function recordRevision(
  store: Store,
  projectId: string,
  source: "git-sync" | "cli-upload",
  suffix: string,
) {
  return store.recordSourceRevision({
    projectId,
    kind: source === "git-sync" ? "git" : "zip",
    origin: source,
    ...(source === "git-sync"
      ? { commitSha: BASE_COMMIT }
      : { baseCommitSha: BASE_COMMIT, dirty: true, uploadedBy: "user_a" }),
    sourcePath: `/tmp/drift-${suffix}`,
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
}

let hostPort = 41_600;
async function deployAndPromote(store: Store, projectId: string, sourceRevisionId: string) {
  hostPort += 1;
  const deployment = await store.recordDeployment({
    projectId,
    sourceRevisionId,
    imageTag: `drift-${hostPort}`,
    containerName: `drift-${hostPort}`,
    internalPort: 3000,
    hostPort,
    runtimeKind: "docker",
  });
  await store.ensureDeploymentRoutes(projectId, deployment.id, "agent.localhost");
  await store.promoteDeployment(projectId, deployment.id);
  return deployment;
}

/** Production on an uploaded revision: the project is now in drift. */
async function promoteHotfix(store: Store, projectId: string) {
  const uploaded = await recordRevision(store, projectId, "cli-upload", "hotfix");
  const deployment = await deployAndPromote(store, projectId, uploaded.id);
  return { uploaded, deployment };
}

function jsonPost(app: ReturnType<typeof createApp>, url: string, body: unknown) {
  return app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function zipUploadForm(fields: Record<string, string>): Promise<FormData> {
  const form = new FormData();
  form.set("archive", new File([await readFile(await createZipArchiveFixture())], "source.zip"));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

describe("hotfix drift", () => {
  test("is reported on the project and on the deployment overview", async () => {
    const store = createTestStore();
    const app = createApp(store);
    const project = await createGitProject(store);
    const synced = await recordRevision(store, project.id, "git-sync", "synced");
    await deployAndPromote(store, project.id, synced.id);

    const clean = await app.request(`/api/projects/${project.id}`);
    await expect(clean.json()).resolves.toMatchObject({
      project: { id: project.id },
      hotfixDrift: null,
    });

    const { uploaded, deployment } = await promoteHotfix(store, project.id);
    const drifted = await app.request(`/api/projects/${project.id}`);
    expect(drifted.status).toBe(200);
    await expect(drifted.json()).resolves.toMatchObject({
      project: { id: project.id, deploymentId: deployment.id },
      hotfixDrift: {
        deploymentId: deployment.id,
        deploymentKey: deployment.deploymentKey,
        releaseId: deployment.releaseId,
        source: {
          revisionId: uploaded.id,
          origin: "cli-upload",
          baseCommitSha: BASE_COMMIT,
          dirty: true,
          uploadedBy: { id: "user_a", name: "Test User A", email: "user-a@example.com" },
        },
      },
    });

    const overview = await app.request(`/api/projects/${project.id}/deployments`);
    await expect(overview.json()).resolves.toMatchObject({
      hotfixDrift: { deploymentId: deployment.id, source: { revisionId: uploaded.id } },
    });
  });

  test("accepts promoting an upload onto a git project when the request asks for it", async () => {
    const store = createTestStore();
    const app = createApp(store);
    const project = await createGitProject(store);

    const response = await app.request(`/api/projects/${project.id}/sync-source`, {
      method: "POST",
      body: await zipUploadForm({ deploy: "true", promote: "true", baseCommitSha: BASE_COMMIT }),
    });
    expect(response.status).toBe(202);
    const [job] = await store.listProjectJobs(project.id, { type: "import_source", limit: 1 });
    expect(job?.payload).toMatchObject({
      importKind: "zip",
      deployAfterImport: true,
      promoteAfterDeploy: true,
      origin: "dashboard-upload",
      baseCommitSha: BASE_COMMIT,
    });
  });

  test("refuses to sync-and-promote over a hotfix unless the caller replaces it explicitly", async () => {
    const store = createTestStore();
    const app = createApp(store);
    const project = await createGitProject(store);
    const { uploaded, deployment } = await promoteHotfix(store, project.id);
    const jobsBefore = (await store.listProjectJobs(project.id)).length;

    const refused = await jsonPost(app, `/api/projects/${project.id}/sync-source`, {
      deploy: true,
      promote: true,
    });
    expect(refused.status).toBe(400);
    const body = await refused.json();
    // The refusal names what would be lost: uploader, time, base commit.
    expect(body.code).toBe("hotfix_drift");
    expect(body.error).toContain("Test User A");
    expect(body.error).toContain(BASE_COMMIT.slice(0, 12));
    expect(body.error).toContain(uploaded.createdAt.slice(0, 10));
    expect(body.error).toContain("replaceHotfix");
    expect(body.hotfixDrift).toMatchObject({ deploymentId: deployment.id });
    expect(await store.listProjectJobs(project.id)).toHaveLength(jobsBefore);

    // A preview sync replaces nothing in production and needs no confirmation.
    const preview = await jsonPost(app, `/api/projects/${project.id}/sync-source`, {
      deploy: true,
    });
    expect(preview.status).toBe(202);

    const replaced = await jsonPost(app, `/api/projects/${project.id}/sync-source`, {
      deploy: true,
      promote: true,
      replaceHotfix: true,
    });
    expect(replaced.status).toBe(202);
    const [job] = await store.listProjectJobs(project.id, { type: "import_source", limit: 1 });
    expect(job?.payload).toMatchObject({
      origin: "git-sync",
      deployAfterImport: true,
      promoteAfterDeploy: true,
    });
  });

  test("guards build-and-promote only when the current revision came from git", async () => {
    const store = createTestStore();
    const app = createApp(store);
    const project = await createGitProject(store);
    await promoteHotfix(store, project.id);

    // The current revision IS the hotfix: rebuilding and promoting it
    // replaces the hotfix with itself.
    const rebuild = await jsonPost(app, `/api/projects/${project.id}/build-deploy`, {
      promote: true,
    });
    expect(rebuild.status).toBe(202);

    // A preview sync since then made a git-sync revision current; promoting
    // that would silently retire the hotfix.
    await recordRevision(store, project.id, "git-sync", "later");
    const refused = await jsonPost(app, `/api/projects/${project.id}/build-deploy`, {
      promote: true,
    });
    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toMatchObject({ code: "hotfix_drift" });

    const preview = await jsonPost(app, `/api/projects/${project.id}/build-deploy`, {
      promote: false,
    });
    expect(preview.status).toBe(202);

    const replaced = await jsonPost(app, `/api/projects/${project.id}/build-deploy`, {
      promote: true,
      replaceHotfix: true,
    });
    expect(replaced.status).toBe(202);
    const builds = await store.listProjectJobs(project.id, { type: "build_deploy" });
    expect(builds.map((job) => job.payload.promoteAfterDeploy)).toEqual([true, false, true]);
  });
});
