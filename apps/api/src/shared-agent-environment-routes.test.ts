import { createTestStore } from "@evelandhq/db/vitest";
import { decryptSecretValue, type EncryptedSecret } from "@evelandhq/core/server/secrets";
import { describe, expect, test } from "vitest";
import { createApp } from "./app.js";

const appSecretKey = "eveland-test-secret-key-00000000";

describe("shared Agent environment routes", () => {
  test("reads and saves the singleton environment", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });

    const emptyResponse = await app.request("/platform/shared-agent-environment");
    expect(emptyResponse.status).toBe(200);
    await expect(emptyResponse.json()).resolves.toEqual({ environment: null });

    const savedResponse = await app.request("/platform/shared-agent-environment", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entries: [
          { key: "MODEL_REGION", kind: "variable", value: "us-east-1" },
          { key: "OPENAI_API_KEY", kind: "secret", value: "sk-shared-secret" },
        ],
      }),
    });
    expect(savedResponse.status).toBe(200);
    const saved = (await savedResponse.json()) as Record<string, unknown>;
    expect(saved).toMatchObject({
      environment: {
        revision: 1,
        entries: [
          { key: "MODEL_REGION", kind: "variable", configured: true },
          { key: "OPENAI_API_KEY", kind: "secret", configured: true },
        ],
      },
      jobs: [],
    });
    expect(JSON.stringify(saved)).not.toContain("us-east-1");
    expect(JSON.stringify(saved)).not.toContain("sk-shared-secret");

    const record = await store.getSharedAgentEnvironmentRecord();
    const encrypted = JSON.parse(
      record!.entries.find((entry) => entry.key === "OPENAI_API_KEY")!.encryptedValue,
    ) as EncryptedSecret;
    expect(decryptSecretValue(encrypted, appSecretKey)).toBe("sk-shared-secret");
  });

  test("restarts every live Deployment when the global environment changes", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });
    const firstProject = await store.createProject({
      name: "Shared Environment Restart Agent",
      importKind: "zip",
    });
    const firstRevision = await store.recordSourceRevision({
      projectId: firstProject.id,
      kind: "zip",
      sourcePath: "/tmp/shared-environment-restart-source",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const firstDeployment = await store.recordDeployment({
      projectId: firstProject.id,
      sourceRevisionId: firstRevision.id,
      imageTag: "shared:first",
      containerName: "shared-first",
      internalPort: 3000,
      hostPort: 42001,
      runtimeKind: "docker",
    });
    const secondDeployment = await store.recordDeployment({
      projectId: firstProject.id,
      sourceRevisionId: firstRevision.id,
      imageTag: "shared:second",
      containerName: "shared-second",
      internalPort: 3000,
      hostPort: 42002,
      runtimeKind: "docker",
    });
    const secondProject = await store.createProject({
      name: "Other Shared Environment Agent",
      importKind: "zip",
    });
    const secondRevision = await store.recordSourceRevision({
      projectId: secondProject.id,
      kind: "zip",
      sourcePath: "/tmp/other-shared-environment-source",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const otherLiveDeployment = await store.recordDeployment({
      projectId: secondProject.id,
      sourceRevisionId: secondRevision.id,
      imageTag: "shared:other-live",
      containerName: "shared-other-live",
      internalPort: 3000,
      hostPort: 42003,
      runtimeKind: "docker",
    });
    const stoppedDeployment = await store.recordDeployment({
      projectId: secondProject.id,
      sourceRevisionId: secondRevision.id,
      imageTag: "shared:stopped",
      containerName: "shared-stopped",
      internalPort: 3000,
      hostPort: 42004,
      runtimeKind: "docker",
    });
    await store.updateDeploymentStatus(stoppedDeployment.id, "stopped");

    const savedResponse = await app.request("/platform/shared-agent-environment", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entries: [{ key: "OPENAI_API_KEY", kind: "secret", value: "shared-key" }],
      }),
    });
    expect(savedResponse.status).toBe(200);
    const saved = (await savedResponse.json()) as {
      jobs: Array<{ id: string; payload: Record<string, never> }>;
    };
    expect(saved.jobs).toHaveLength(3);
    expect(saved.jobs.every((job) => Object.keys(job.payload).length === 0)).toBe(true);
    const savedIds = new Set(saved.jobs.map((job) => job.id));
    const savedInternalJobs = [
      ...(await store.listProjectJobs(firstProject.id, { type: "restart_deployment" })),
      ...(await store.listProjectJobs(secondProject.id, { type: "restart_deployment" })),
    ].filter((job) => savedIds.has(job.id));
    expect(savedInternalJobs.map((job) => job.payload.deploymentId).sort()).toEqual(
      [firstDeployment.id, secondDeployment.id, otherLiveDeployment.id].sort(),
    );
    expect(
      savedInternalJobs.every((job) => job.payload.reason === "shared_agent_environment_changed"),
    ).toBe(true);

    const unchangedResponse = await app.request("/platform/shared-agent-environment", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries: [{ key: "OPENAI_API_KEY", kind: "secret" }] }),
    });
    expect(unchangedResponse.status).toBe(200);
    await expect(unchangedResponse.json()).resolves.toMatchObject({ jobs: [] });

    const rotatedResponse = await app.request("/platform/shared-agent-environment", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entries: [{ key: "OPENAI_API_KEY", kind: "secret", value: "shared-key-v2" }],
      }),
    });
    expect(rotatedResponse.status).toBe(200);
    const rotated = (await rotatedResponse.json()) as {
      jobs: Array<{ id: string; payload: Record<string, never> }>;
    };
    expect(rotated.jobs).toHaveLength(3);
    expect(rotated.jobs.every((job) => Object.keys(job.payload).length === 0)).toBe(true);
    const rotatedIds = new Set(rotated.jobs.map((job) => job.id));
    const rotatedInternalJobs = [
      ...(await store.listProjectJobs(firstProject.id, { type: "restart_deployment" })),
      ...(await store.listProjectJobs(secondProject.id, { type: "restart_deployment" })),
    ].filter((job) => rotatedIds.has(job.id));
    expect(rotatedInternalJobs.map((job) => job.payload.deploymentId).sort()).toEqual(
      [firstDeployment.id, secondDeployment.id, otherLiveDeployment.id].sort(),
    );
    expect(
      rotatedInternalJobs.every((job) => job.payload.reason === "shared_agent_environment_changed"),
    ).toBe(true);
  });
});
