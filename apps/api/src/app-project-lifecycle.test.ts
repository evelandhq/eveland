import { describe, expect, test, vi } from "vitest";
import { createApp } from "./app.js";
import { createTestStore } from "@evelandhq/db/vitest";

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
      deployAfterImport: true,
      promoteAfterDeploy: true,
    });
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
