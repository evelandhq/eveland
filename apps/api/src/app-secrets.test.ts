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
  test("stores secrets without returning secret values", async () => {
    const app = createApp(createTestStore());
    const createProject = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "secret-agent", importKind: "zip" }),
    });
    const { project } = await createProject.json();

    const secretResponse = await app.request(
      `/projects/${project.id}/secrets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: "OPENAI_API_KEY",
          value: "sk-test-123456",
        }),
      },
    );

    expect(secretResponse.status).toBe(201);
    const body = await secretResponse.json();
    expect(body.secret).toMatchObject({ key: "OPENAI_API_KEY" });
    expect(JSON.stringify(body)).not.toContain("sk-test-123456");

    const listResponse = await app.request(`/projects/${project.id}/secrets`);
    expect(JSON.stringify(await listResponse.json())).not.toContain(
      "sk-test-123456",
    );
  });

  test("queues a targeted restart for every live deployment after saving a secret", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Secret Refresh Agent",
      importKind: "zip",
      sourcePath: "/tmp/source",
    });
    const importJob = await store.claimNextJob("test-worker");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: {},
      envVars: ["DEEPSEEK_API_KEY"],
      files: [],
      schedules: [],
    });
    const stable = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "secret-refresh:stable",
      containerName: "secret-refresh-stable",
      internalPort: 3000,
      hostPort: 41040,
      runtimeKind: "docker",
    });
    const preview = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "secret-refresh:preview",
      containerName: "secret-refresh-preview",
      internalPort: 3000,
      hostPort: 41041,
      runtimeKind: "docker",
    });

    const response = await createApp(store).request(
      `/projects/${project.id}/secrets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: "DEEPSEEK_API_KEY",
          value: "sk-test-deepseek",
        }),
      },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      jobs: expect.arrayContaining([
        expect.objectContaining({
          type: "restart_deployment",
          payload: expect.objectContaining({ deploymentId: stable.id }),
        }),
        expect.objectContaining({
          type: "restart_deployment",
          payload: expect.objectContaining({ deploymentId: preview.id }),
        }),
      ]),
    });
    const queuedDeploymentIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const job = await store.claimNextJob("test-worker");
      expect(job).toMatchObject({ type: "restart_deployment" });
      queuedDeploymentIds.push(String(job!.payload.deploymentId));
      await store.completeJob(job!.id);
    }
    expect(queuedDeploymentIds).toEqual(
      expect.arrayContaining([stable.id, preview.id]),
    );
  });

  test("queues live deployment secret refreshes only when a secret was deleted", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Secret Delete Agent",
      importKind: "zip",
      sourcePath: "/tmp/source",
    });
    const importJob = await store.claimNextJob("test-worker");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: {},
      envVars: ["DEEPSEEK_API_KEY"],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "secret-delete:stable",
      containerName: "secret-delete-stable",
      internalPort: 3000,
      hostPort: 41042,
      runtimeKind: "docker",
    });
    const secret = await store.upsertSecret(
      project.id,
      "DEEPSEEK_API_KEY",
      "encrypted-placeholder",
    );
    const app = createApp(store);

    const missing = await app.request(
      `/projects/${project.id}/secrets/secret_missing`,
      { method: "DELETE" },
    );
    await expect(missing.json()).resolves.toMatchObject({
      deleted: false,
      jobs: [],
    });
    await expect(store.claimNextJob("test-worker")).resolves.toBeNull();

    const response = await app.request(
      `/projects/${project.id}/secrets/${secret.id}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deleted: true,
      jobs: [
        expect.objectContaining({
          type: "restart_deployment",
          payload: expect.objectContaining({ deploymentId: deployment.id }),
        }),
      ],
    });
  });

  test("rejects an invalid secret encryption key when the API starts", () => {
    expect(() =>
      createApp(createTestStore(), {
        appSecretKey: "1234567890123456789012345678901",
      }),
    ).toThrow(
      "APP_SECRET_KEY must be 32 bytes or a base64 encoded 32-byte value.",
    );
  });

  test("returns current source revision and files", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Source Agent",
      importKind: "zip",
    });
    await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: { instructions: ["agent/instructions.md"] },
      envVars: ["OPENAI_API_KEY"],
      files: [{ path: "agent/instructions.md", content: "You are concise." }],
      schedules: [],
    });
    const app = createApp(store);

    await expect(
      (await app.request(`/projects/${project.id}/source/revision`)).json(),
    ).resolves.toMatchObject({
      revision: expect.objectContaining({
        sourcePath: "/tmp/source",
        envVars: ["OPENAI_API_KEY"],
      }),
    });
    await expect(
      (await app.request(`/projects/${project.id}/source/files`)).json(),
    ).resolves.toMatchObject({
      files: [expect.objectContaining({ path: "agent/instructions.md" })],
    });
    await expect(
      (
        await app.request(
          `/projects/${project.id}/source/file?path=agent%2Finstructions.md`,
        )
      ).json(),
    ).resolves.toMatchObject({
      file: expect.objectContaining({ content: "You are concise." }),
    });
  });
});
