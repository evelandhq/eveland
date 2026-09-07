import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import type { AuthPrincipal } from "@evelandhq/core/contracts";
import { createApp } from "./app.js";
import { createTestStore } from "@evelandhq/db/vitest";
import { registerProjectLifecycleRoutes } from "./app-project-lifecycle-routes.js";
import { createZipArchiveFixture } from "./app.test-support.js";

async function zipUploadForm(fields: Record<string, string> = {}): Promise<FormData> {
  const archivePath = await createZipArchiveFixture();
  const form = new FormData();
  form.set("archive", new File([await readFile(archivePath)], "source.zip"));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

describe("api app", () => {
  test("syncs the latest git source with deployment and promotion chained", async () => {
    const store = createTestStore();
    const app = createApp(store);
    const createResponse = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "weather-agent",
        importKind: "git",
        gitUrl: "https://example.com/weather.git",
      }),
    });
    const { project } = await createResponse.json();

    const syncResponse = await app.request(`/api/projects/${project.id}/sync-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deploy: true, promote: true }),
    });

    expect(syncResponse.status).toBe(202);
    const syncBody = await syncResponse.json();
    expect(syncBody).toMatchObject({
      job: expect.objectContaining({
        type: "import_source",
        status: "queued",
      }),
    });
    expect(syncBody.job.payload).toEqual({});
    const [persistedSyncJob] = await store.listProjectJobs(project.id, {
      type: "import_source",
    });
    expect(persistedSyncJob?.payload).toMatchObject({
      gitUrl: "https://example.com/weather.git",
      origin: "git-sync",
      deployAfterImport: true,
      promoteAfterDeploy: true,
    });
  });

  test("replaces a zip project's source from a multipart upload", async () => {
    const store = createTestStore();
    const app = createApp(store);
    const project = await store.createProject({
      name: "Zip Agent",
      importKind: "zip",
      sourcePath: "/tmp/original",
    });

    const response = await app.request(`/api/projects/${project.id}/sync-source`, {
      method: "POST",
      body: await zipUploadForm({ deploy: "true", promote: "true" }),
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      job: expect.objectContaining({ type: "import_source", status: "queued" }),
    });
    const jobs = await store.listProjectJobs(project.id, { type: "import_source" });
    const uploaded = jobs.find((job) => job.payload.sourcePath !== "/tmp/original");
    expect(uploaded?.payload).toMatchObject({
      importKind: "zip",
      deployAfterImport: true,
      promoteAfterDeploy: true,
      // No auth configured: the local-dev app is the Dashboard, and the
      // upload reported no git checkout.
      origin: "dashboard-upload",
      uploadedBy: "user_local_admin",
      baseCommitSha: null,
      dirty: null,
    });
    expect(String(uploaded?.payload.sourcePath)).toContain("uploads");
  });

  test("uploads onto a git project as a preview and records what the upload was based on", async () => {
    const store = createTestStore();
    const app = createApp(store);
    const gitProject = await store.createProject({
      name: "Git Agent",
      importKind: "git",
      gitUrl: "https://example.com/agent.git",
    });

    const upload = await app.request(`/api/projects/${gitProject.id}/sync-source`, {
      method: "POST",
      body: await zipUploadForm({ deploy: "true", baseCommitSha: "a".repeat(40), dirty: "true" }),
    });
    expect(upload.status).toBe(202);
    const [job] = await store.listProjectJobs(gitProject.id, { type: "import_source", limit: 1 });
    expect(job?.payload).toMatchObject({
      importKind: "zip",
      deployAfterImport: true,
      promoteAfterDeploy: false,
      origin: "dashboard-upload",
      uploadedBy: "user_local_admin",
      baseCommitSha: "a".repeat(40),
      dirty: true,
    });
    // The upload must not disturb where the JSON sync clones from.
    await expect(store.getProject(gitProject.id)).resolves.toMatchObject({
      importKind: "git",
      gitUrl: "https://example.com/agent.git",
    });

    // Promoting an upload is what makes the next sync's replacement a
    // production regression, so a git project refuses it for now.
    const promoted = await app.request(`/api/projects/${gitProject.id}/sync-source`, {
      method: "POST",
      body: await zipUploadForm({ deploy: "true", promote: "true" }),
    });
    expect(promoted.status).toBe(400);
    await expect(promoted.json()).resolves.toEqual({
      error: expect.stringMatching(/^Uploads to a git project deploy as previews only\./),
    });
    await expect(
      store.listProjectJobs(gitProject.id, { type: "import_source" }),
    ).resolves.toHaveLength(2);
  });

  test("an upload from a CLI token is recorded as a CLI upload by that user", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "CLI Upload Agent",
      importKind: "zip",
      sourcePath: "/tmp/original",
    });
    const app = new Hono<{ Variables: { principal: AuthPrincipal } }>();
    app.use("*", async (c, next) => {
      c.set("principal", {
        userId: "user_a",
        email: "user-a@example.com",
        name: "Test User A",
        role: "member",
        image: null,
        displayTimezone: null,
        tokenScopes: ["deploy", "observe"],
      } as unknown as AuthPrincipal);
      await next();
    });
    registerProjectLifecycleRoutes({
      app,
      store,
      dataDir: await mkdtemp(path.join(os.tmpdir(), "eveland-cli-upload-")),
    });

    const response = await app.request(`/api/projects/${project.id}/sync-source`, {
      method: "POST",
      body: await zipUploadForm({ deploy: "true", baseCommitSha: "c".repeat(40), dirty: "false" }),
    });
    expect(response.status).toBe(202);
    const [job] = await store.listProjectJobs(project.id, { type: "import_source", limit: 1 });
    expect(job?.payload).toMatchObject({
      origin: "cli-upload",
      uploadedBy: "user_a",
      baseCommitSha: "c".repeat(40),
      dirty: false,
    });
  });

  test("refuses provenance it cannot trust: short hashes, dirty without a base", async () => {
    const store = createTestStore();
    const app = createApp(store);
    const project = await store.createProject({
      name: "Provenance Guard Agent",
      importKind: "zip",
      sourcePath: "/tmp/original",
    });

    const shortHash = await app.request(`/api/projects/${project.id}/sync-source`, {
      method: "POST",
      body: await zipUploadForm({ deploy: "true", baseCommitSha: "abc123" }),
    });
    expect(shortHash.status).toBe(400);
    await expect(shortHash.json()).resolves.toMatchObject({
      error: "Invalid source provenance",
      issues: [expect.objectContaining({ path: ["baseCommitSha"] })],
    });

    const orphanDirty = await app.request(`/api/projects/${project.id}/sync-source`, {
      method: "POST",
      body: await zipUploadForm({ deploy: "true", dirty: "true" }),
    });
    expect(orphanDirty.status).toBe(400);
    await expect(orphanDirty.json()).resolves.toMatchObject({
      error: "Invalid source provenance",
      issues: [expect.objectContaining({ path: ["dirty"] })],
    });

    const garbageDirty = await app.request(`/api/projects/${project.id}/sync-source`, {
      method: "POST",
      body: await zipUploadForm({ deploy: "true", baseCommitSha: "a".repeat(40), dirty: "maybe" }),
    });
    expect(garbageDirty.status).toBe(400);
    await expect(
      store.listProjectJobs(project.id, { type: "import_source" }),
    ).resolves.toHaveLength(1);
  });

  test("zip source upload guards: promote-without-deploy, empty archives", async () => {
    const store = createTestStore();
    const app = createApp(store);

    const zipProject = await store.createProject({
      name: "Zip Guard Agent",
      importKind: "zip",
      sourcePath: "/tmp/original",
    });
    const promoteOnly = await app.request(`/api/projects/${zipProject.id}/sync-source`, {
      method: "POST",
      body: await zipUploadForm({ promote: "true" }),
    });
    expect(promoteOnly.status).toBe(400);
    await expect(promoteOnly.json()).resolves.toEqual({
      error: "A synced source must be deployed before it can be promoted.",
    });

    const emptyForm = new FormData();
    emptyForm.set("deploy", "true");
    const missingArchive = await app.request(`/api/projects/${zipProject.id}/sync-source`, {
      method: "POST",
      body: emptyForm,
    });
    expect(missingArchive.status).toBe(400);
    await expect(missingArchive.json()).resolves.toMatchObject({ error: "Invalid zip upload" });
  });

  test("syncs the latest git source into a preview without promotion", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Preview Agent",
      importKind: "git",
      gitUrl: "https://example.com/preview.git",
    });
    const app = createApp(store);

    const syncResponse = await app.request(`/api/projects/${project.id}/sync-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deploy: true, promote: false }),
    });

    expect(syncResponse.status).toBe(202);
    const syncBody = await syncResponse.json();
    expect(syncBody).toMatchObject({
      job: expect.objectContaining({
        type: "import_source",
      }),
    });
    expect(syncBody.job.payload).toEqual({});
    const [persistedSyncJob] = await store.listProjectJobs(project.id, {
      type: "import_source",
    });
    expect(persistedSyncJob?.payload).toMatchObject({
      deployAfterImport: true,
      promoteAfterDeploy: false,
    });
  });

  test("builds the current source and promotes the exact new deployment", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Current Source Agent",
      importKind: "git",
      gitUrl: "https://example.com/current.git",
    });
    const app = createApp(store);

    const response = await app.request(`/api/projects/${project.id}/build-deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ promote: true }),
    });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      job: expect.objectContaining({ type: "build_deploy" }),
    });
    expect(body.job.payload).toEqual({});
    const [persistedBuildJob] = await store.listProjectJobs(project.id, {
      type: "build_deploy",
    });
    expect(persistedBuildJob?.payload).toEqual({ promoteAfterDeploy: true });
  });

  test("rejects invalid current-source deployment options", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Invalid Deploy Agent",
      importKind: "zip",
      sourcePath: "/tmp/invalid-deploy",
    });

    const response = await createApp(store).request(`/api/projects/${project.id}/build-deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ promote: "yes" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid deployment options",
    });
  });

  test("rejects promotion when the synced source is not being deployed", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Invalid Promotion Agent",
      importKind: "git",
      gitUrl: "https://example.com/invalid-promotion.git",
    });

    const response = await createApp(store).request(`/api/projects/${project.id}/sync-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deploy: false, promote: true }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid source sync options",
    });
  });

  test("returns project job status without exposing job payloads", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Visible Import Job",
      importKind: "git",
      gitUrl: "https://token@example.com/agent.git",
    });
    const job = await store.claimNextJob("worker-a");
    await store.failJob(job!.id, "Repository fetch timed out after 120000ms.");
    await store.enqueueJob(project.id, "build_deploy");
    const buildJob = await store.claimNextJob("worker-a");
    await store.failJob(buildJob!.id, "provider returned a sensitive build detail");

    const response = await createApp(store).request(`/api/projects/${project.id}/jobs`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jobs: [
        expect.objectContaining({
          id: job!.id,
          projectId: project.id,
          type: "import_source",
          status: "failed",
          payload: {},
          lastError: "Repository fetch timed out after 120000ms.",
        }),
      ],
    });

    const deploymentResponse = await createApp(store).request(
      `/api/projects/${project.id}/jobs?include=deployment`,
    );
    await expect(deploymentResponse.json()).resolves.toEqual({
      jobs: [
        expect.objectContaining({
          id: buildJob!.id,
          type: "build_deploy",
          payload: {},
        }),
        expect.objectContaining({
          id: job!.id,
          type: "import_source",
          payload: {},
        }),
      ],
    });
  });

  test("syncs a git source without deploying when no deploy flag is sent", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Sync Agent",
      importKind: "git",
      gitUrl: "https://example.com/agent.git",
    });
    const app = createApp(store);

    const syncResponse = await app.request(`/api/projects/${project.id}/sync-source`, {
      method: "POST",
    });

    expect(syncResponse.status).toBe(202);
    const syncBody = await syncResponse.json();
    expect(syncBody).toMatchObject({
      job: expect.objectContaining({
        type: "import_source",
      }),
    });
    expect(syncBody.job.payload).toEqual({});
    const [persistedSyncJob] = await store.listProjectJobs(project.id, {
      type: "import_source",
    });
    expect(persistedSyncJob?.payload.deployAfterImport).toBe(false);
  });

  test("rejects a source sync for a zip project", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Zip Agent",
      importKind: "zip",
      sourcePath: "/tmp/zip",
    });
    const app = createApp(store);

    const response = await app.request(`/api/projects/${project.id}/sync-source`, {
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("git projects"),
    });
  });

  test("returns 404 when syncing a project that does not exist", async () => {
    const app = createApp(createTestStore());
    const response = await app.request("/api/projects/missing/sync-source", {
      method: "POST",
    });
    expect(response.status).toBe(404);
  });

  test("returns 404 when deleting a project that does not exist", async () => {
    const app = createApp(createTestStore());

    const response = await app.request("/api/projects/missing", {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Project not found",
    });
  });

  test("marks a project as deleting, enqueues one deletion job, and rejects duplicate requests", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Delete Me Agent",
      importKind: "zip",
      sourcePath: "/tmp/delete-me",
    });
    const app = createApp(store);

    const response = await app.request(`/api/projects/${project.id}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      job: expect.objectContaining({
        type: "delete_project",
        status: "queued",
        projectId: project.id,
      }),
    });
    expect(JSON.stringify(body)).not.toContain("/tmp/delete-me");
    // The delete only happens once the worker processes the job; the DELETE
    // request itself must keep a visible, persisted deleting state.
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      id: project.id,
      deletionStatus: "deleting",
      deletionError: null,
    });

    const duplicate = await app.request(`/api/projects/${project.id}`, {
      method: "DELETE",
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toEqual({
      error: "Project is being deleted",
    });
  });

  test("keeps reads available while rejecting project mutations during deletion", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Deleting Agent",
      importKind: "zip",
    });
    const playgroundProxy = vi.fn();
    const app = createApp(store, { playgroundProxy });
    await app.request(`/api/projects/${project.id}`, { method: "DELETE" });

    const read = await app.request(`/api/projects/${project.id}`);
    const mutate = await app.request(`/api/projects/${project.id}/build-deploy`, {
      method: "POST",
    });
    const canonicalPlayground = await app.request(
      `/api/projects/${project.id}/playground/eve/v1/session`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Do not enter the Gateway" }),
      },
    );

    expect(read.status).toBe(200);
    expect(mutate.status).toBe(409);
    await expect(mutate.json()).resolves.toEqual({
      error: "Project is being deleted",
    });
    expect(canonicalPlayground.status).toBe(409);
    await expect(canonicalPlayground.json()).resolves.toEqual({
      error: "Project is being deleted",
    });
    expect(playgroundProxy).not.toHaveBeenCalled();
  });
});
