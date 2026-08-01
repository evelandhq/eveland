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
  encryptSecretValue,
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
          kind: "variable",
          value: "sk-test-123456",
        }),
      },
    );

    expect(secretResponse.status).toBe(201);
    const body = await secretResponse.json();
    expect(body.secret).toMatchObject({ key: "OPENAI_API_KEY", kind: "variable" });
    expect(JSON.stringify(body)).not.toContain("sk-test-123456");

    const listResponse = await app.request(`/projects/${project.id}/secrets`);
    expect(JSON.stringify(await listResponse.json())).not.toContain(
      "sk-test-123456",
    );
  });

  test("edits a project environment entry without returning or replacing an omitted value", async () => {
    const store = createTestStore();
    const appSecretKey = "eveland-test-secret-key-00000000";
    const app = createApp(store, { appSecretKey });
    const createProject = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "editable-secret-agent", importKind: "zip" }),
    });
    const { project } = await createProject.json();
    const createdResponse = await app.request(`/projects/${project.id}/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "MODEL_NAME", kind: "variable", value: "gpt-5" }),
    });
    const created = (await createdResponse.json()) as { secret: { id: string } };

    const response = await app.request(`/projects/${project.id}/secrets/${created.secret.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "DEFAULT_MODEL", kind: "secret" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.secret).toMatchObject({ id: created.secret.id, key: "DEFAULT_MODEL", kind: "secret" });
    expect(JSON.stringify(body)).not.toContain("gpt-5");
    const [record] = await store.listSecretRecords(project.id);
    expect(record).toMatchObject({ id: created.secret.id, key: "DEFAULT_MODEL", kind: "secret" });
    expect(decryptSecretValue(JSON.parse(record!.encryptedValue) as EncryptedSecret, appSecretKey)).toBe("gpt-5");
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
    const responseBody = await response.json();
    expect(responseBody.jobs).toHaveLength(2);
    expect(responseBody.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "restart_deployment", payload: {} }),
        expect.objectContaining({ type: "restart_deployment", payload: {} }),
      ]),
    );
    expect(
      responseBody.jobs.every(
        (job: { payload: Record<string, unknown> }) =>
          Object.keys(job.payload).length === 0,
      ),
    ).toBe(true);
    const queuedDeploymentIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const job = await store.claimNextJob("test-worker");
      expect(job).toMatchObject({ type: "restart_deployment" });
      if (job?.type !== "restart_deployment") {
        throw new Error("Expected a restart job.");
      }
      queuedDeploymentIds.push(String(job.payload.deploymentId));
      await store.completeJob(job.id);
    }
    expect(queuedDeploymentIds).toEqual(
      expect.arrayContaining([stable.id, preview.id]),
    );
  });

  test("batch upserts project environment entries and queues each live deployment restart once", async () => {
    const store = createTestStore();
    const appSecretKey = "eveland-test-secret-key-00000000";
    const project = await store.createProject({
      name: "Batch Environment Agent",
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
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "batch-environment:preview",
      containerName: "batch-environment-preview",
      internalPort: 3000,
      hostPort: 41043,
      runtimeKind: "docker",
    });
    await store.upsertSecret(
      project.id,
      "MODEL_NAME",
      JSON.stringify(encryptSecretValue("gpt-old", appSecretKey)),
      "variable",
    );

    const response = await createApp(store, { appSecretKey }).request(
      `/projects/${project.id}/secrets/batch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entries: [
            { key: "MODEL_NAME", kind: "variable", value: "gpt-5.4" },
            { key: "OPENAI_API_KEY", kind: "secret", value: "sk-batch-secret" },
          ],
        }),
      },
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.secrets).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "MODEL_NAME", kind: "variable" }),
      expect.objectContaining({ key: "OPENAI_API_KEY", kind: "secret" }),
    ]));
    expect(body.jobs).toEqual([
      expect.objectContaining({
        type: "restart_deployment",
        payload: {},
      }),
    ]);
    expect(Object.keys(body.jobs[0].payload)).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain("gpt-5.4");
    expect(JSON.stringify(body)).not.toContain("sk-batch-secret");

    const records = await store.listSecretRecords(project.id);
    expect(records).toHaveLength(2);
    expect(decryptSecretValue(
      JSON.parse(records.find((record) => record.key === "MODEL_NAME")!.encryptedValue) as EncryptedSecret,
      appSecretKey,
    )).toBe("gpt-5.4");
    expect(decryptSecretValue(
      JSON.parse(records.find((record) => record.key === "OPENAI_API_KEY")!.encryptedValue) as EncryptedSecret,
      appSecretKey,
    )).toBe("sk-batch-secret");

    const restart = await store.claimNextJob("test-worker");
    expect(restart).toMatchObject({
      type: "restart_deployment",
      payload: expect.objectContaining({ deploymentId: deployment.id }),
    });
    await store.completeJob(restart!.id);
    await expect(store.claimNextJob("test-worker")).resolves.toBeNull();
  });

  test("rejects duplicate batch names before writing any project environment entries", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Duplicate Batch Agent",
      importKind: "zip",
    });

    const response = await createApp(store).request(
      `/projects/${project.id}/secrets/batch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entries: [
            { key: "MODEL_NAME", value: "gpt-5.4" },
            { key: "MODEL_NAME", value: "gpt-5-mini" },
          ],
        }),
      },
    );

    expect(response.status).toBe(400);
    await expect(store.listSecrets(project.id)).resolves.toEqual([]);
  });

  test("enforces the 50-entry project environment cap across existing and imported names", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Capped Batch Agent",
      importKind: "zip",
    });
    for (let index = 0; index < 50; index += 1) {
      await store.upsertSecret(project.id, `KEY_${index}`, "encrypted-placeholder");
    }

    const response = await createApp(store).request(
      `/projects/${project.id}/secrets/batch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entries: [
            { key: "KEY_0", value: "replacement" },
            { key: "OVER_THE_LIMIT", value: "new-value" },
          ],
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(await store.listSecrets(project.id)).toHaveLength(50);
    expect((await store.listSecrets(project.id)).some((entry) => entry.key === "OVER_THE_LIMIT")).toBe(false);
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
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({
      deleted: true,
      jobs: [
        expect.objectContaining({
          type: "restart_deployment",
          payload: {},
        }),
      ],
    });
    expect(responseBody.jobs[0].payload).toEqual({});
    const restart = await store.claimNextJob("test-worker");
    expect(restart).toMatchObject({
      type: "restart_deployment",
      payload: expect.objectContaining({ deploymentId: deployment.id }),
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
