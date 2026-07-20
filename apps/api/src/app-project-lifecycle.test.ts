import { execFile } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test, vi } from "vitest";
import { createBuildInfo } from "@eveland/core/build-info";
import { createScheduleDispatchCredential } from "@eveland/core/server/scheduler-dispatch";
import {
  decryptSecretValue,
  type EncryptedSecret,
} from "@eveland/core/server/secrets";
import { createApp } from "./app.js";
import type { Store } from "@eveland/db";
import { createTestStore } from "@eveland/db/vitest";

import {
  createScheduleRunFixture,
  createZipArchiveFixture,
} from "./app.test-support.js";

describe("api app", () => {
  test("syncs the latest git source with deployment and promotion chained", async () => {
    const store = createTestStore();
    const app = createApp(store);
    const createResponse = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "weather-agent",
        importKind: "git",
        gitUrl: "https://example.com/weather.git",
      }),
    });
    const { project } = await createResponse.json();

    const syncResponse = await app.request(
      `/projects/${project.id}/sync-source`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deploy: true, promote: true }),
      },
    );

    expect(syncResponse.status).toBe(202);
    await expect(syncResponse.json()).resolves.toMatchObject({
      job: expect.objectContaining({
        type: "import_source",
        status: "queued",
        payload: expect.objectContaining({
          gitUrl: "https://example.com/weather.git",
          deployAfterImport: true,
          promoteAfterDeploy: true,
        }),
      }),
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

    const syncResponse = await app.request(
      `/projects/${project.id}/sync-source`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deploy: true, promote: false }),
      },
    );

    expect(syncResponse.status).toBe(202);
    await expect(syncResponse.json()).resolves.toMatchObject({
      job: expect.objectContaining({
        type: "import_source",
        payload: expect.objectContaining({
          deployAfterImport: true,
          promoteAfterDeploy: false,
        }),
      }),
    });
  });

  test("rejects promotion when the synced source is not being deployed", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Invalid Promotion Agent",
      importKind: "git",
      gitUrl: "https://example.com/invalid-promotion.git",
    });

    const response = await createApp(store).request(
      `/projects/${project.id}/sync-source`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deploy: false, promote: true }),
      },
    );

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
    await store.failJob(
      buildJob!.id,
      "provider returned a sensitive build detail",
    );

    const response = await createApp(store).request(
      `/projects/${project.id}/jobs`,
    );

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
      `/projects/${project.id}/jobs?include=deployment`,
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

    const syncResponse = await app.request(
      `/projects/${project.id}/sync-source`,
      { method: "POST" },
    );

    expect(syncResponse.status).toBe(202);
    await expect(syncResponse.json()).resolves.toMatchObject({
      job: expect.objectContaining({
        type: "import_source",
        payload: expect.objectContaining({ deployAfterImport: false }),
      }),
    });
  });

  test("rejects a source sync for a zip project", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Zip Agent",
      importKind: "zip",
      sourcePath: "/tmp/zip",
    });
    const app = createApp(store);

    const response = await app.request(`/projects/${project.id}/sync-source`, {
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("git projects"),
    });
  });

  test("returns 404 when syncing a project that does not exist", async () => {
    const app = createApp(createTestStore());
    const response = await app.request("/projects/missing/sync-source", {
      method: "POST",
    });
    expect(response.status).toBe(404);
  });

  test("rejects playground messages when no deployment is running", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Idle Agent",
      importKind: "zip",
    });
    const app = createApp(store);

    const response = await app.request(`/projects/${project.id}/playground`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Hello" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "No running deployment",
    });
  });

  test("returns 404 when deleting a project that does not exist", async () => {
    const app = createApp(createTestStore());

    const response = await app.request("/projects/missing", {
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

    const response = await app.request(`/projects/${project.id}`, {
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

    const duplicate = await app.request(`/projects/${project.id}`, {
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
    const app = createApp(store);
    await app.request(`/projects/${project.id}`, { method: "DELETE" });

    const read = await app.request(`/projects/${project.id}`);
    const mutate = await app.request(`/projects/${project.id}/build-deploy`, {
      method: "POST",
    });

    expect(read.status).toBe(200);
    expect(mutate.status).toBe(409);
    await expect(mutate.json()).resolves.toEqual({
      error: "Project is being deleted",
    });
  });
});
