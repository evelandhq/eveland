import { createTestStore } from "@evelandhq/db/vitest";
import { decryptSecretValue, type EncryptedSecret } from "@evelandhq/core/server/secrets";
import { describe, expect, test, vi } from "vitest";
import { createApp } from "./app.js";

const appSecretKey = "eveland-test-secret-key-00000000";
const json = (body: unknown) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const decrypt = (value: string) =>
  decryptSecretValue(JSON.parse(value) as EncryptedSecret, appSecretKey);

async function projectWithLiveDeployment(store: ReturnType<typeof createTestStore>, name: string) {
  const project = await store.createProject({
    name,
    importKind: "zip",
    sourcePath: `/tmp/${name}`,
  });
  const revision = await store.recordSourceRevision({
    projectId: project.id,
    kind: "zip",
    sourcePath: `/tmp/${name}`,
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
  const deployment = await store.recordDeployment({
    releaseId: `rel_${name}`,
    deploymentId: `dep_${name}`,
    projectId: project.id,
    sourceRevisionId: revision.id,
    imageTag: `eveland/${name}:rel`,
    containerName: `eveland-${name}`,
    internalPort: 3000,
    hostPort: 41000 + name.length,
    runtimeKind: "systemd",
  });
  return { project, deployment };
}

describe("instance Model Gateway routes", () => {
  test("saves the gateway without ever returning its credential", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });

    const empty = await app.request("/api/platform/model-gateway");
    await expect(empty.json()).resolves.toEqual({ gateway: null });

    const saved = await app.request("/api/platform/model-gateway", {
      method: "PUT",
      ...json({
        kind: "litellm",
        baseUrl: "https://llm.example/v1/",
        credential: "sk-admin-secret",
      }),
    });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      gateway: {
        kind: "litellm",
        baseUrl: "https://llm.example/v1",
        credentialConfigured: true,
        revision: 1,
      },
    });
    expect(JSON.stringify(body)).not.toContain("sk-admin-secret");
    const record = await store.getModelGatewayRecord();
    expect(decrypt(record!.encryptedCredential)).toBe("sk-admin-secret");

    const read = await app.request("/api/platform/model-gateway");
    expect(JSON.stringify(await read.json())).not.toContain("sk-admin-secret");
  });

  test("keeps the stored credential when only an unchanged gateway is resaved", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });
    await app.request("/api/platform/model-gateway", {
      method: "PUT",
      ...json({ kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", credential: "sk-or" }),
    });

    const resaved = await app.request("/api/platform/model-gateway", {
      method: "PUT",
      ...json({ kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }),
    });
    expect(resaved.status).toBe(200);
    await expect(resaved.json()).resolves.toMatchObject({ gateway: { revision: 1 }, jobs: [] });

    const moved = await app.request("/api/platform/model-gateway", {
      method: "PUT",
      ...json({ kind: "litellm", baseUrl: "https://llm.example/v1" }),
    });
    expect(moved.status).toBe(400);
    await expect(moved.json()).resolves.toMatchObject({
      error: expect.stringContaining("credential is required"),
    });
  });

  test.each([
    [{ kind: "new-api", baseUrl: "https://x/v1", credential: "k" }, "kind"],
    [{ kind: "litellm", credential: "k" }, "baseUrl"],
    [{ kind: "litellm", baseUrl: "ftp://x", credential: "k" }, "baseUrl"],
    [{ kind: "vercel", baseUrl: "https://x/v1", credential: "k" }, "baseUrl"],
  ])("rejects an invalid gateway %j", async (input, field) => {
    const app = createApp(createTestStore(), { appSecretKey });
    const response = await app.request("/api/platform/model-gateway", {
      method: "PUT",
      ...json(input),
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(field);
  });

  test("restarts the live deployments of every project that uses the gateway when it changes", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });
    const using = await projectWithLiveDeployment(store, "uses-gateway");
    const optedOut = await projectWithLiveDeployment(store, "opted-out");
    await store.saveProjectModelGatewaySettings(optedOut.project.id, { mode: "off" });

    const saved = await app.request("/api/platform/model-gateway", {
      method: "PUT",
      ...json({
        kind: "openai-compatible",
        baseUrl: "https://llm.example/v1",
        credential: "sk-shared",
      }),
    });
    const body = (await saved.json()) as {
      jobs: Array<{ projectId: string; deploymentId: string }>;
    };

    expect(body.jobs.map((job) => job.projectId)).toEqual([using.project.id]);
    expect(body.jobs[0]!.deploymentId).toBe(using.deployment.id);
    const [restart] = await store.listProjectJobs(using.project.id, { type: "restart_deployment" });
    expect(restart!.payload).toMatchObject({ reason: "model_gateway_changed" });

    const removed = await app.request("/api/platform/model-gateway", { method: "DELETE" });
    await expect(removed.json()).resolves.toMatchObject({
      deleted: true,
      jobs: [{ projectId: using.project.id }],
    });
    await expect(store.getModelGatewayRecord()).resolves.toBeNull();
  });

  test("tests a connection with the submitted credential, or the stored one for an unchanged gateway", async () => {
    const store = createTestStore();
    const testModelGatewayConnection = vi.fn(async () => ({ ok: true as const, modelCount: 3 }));
    const app = createApp(store, { appSecretKey, testModelGatewayConnection });

    const fresh = await app.request("/api/platform/model-gateway/test", {
      method: "POST",
      ...json({
        kind: "openai-compatible",
        baseUrl: "https://llm.example/v1",
        credential: "sk-new",
      }),
    });
    await expect(fresh.json()).resolves.toEqual({ result: { ok: true, modelCount: 3 } });
    expect(testModelGatewayConnection).toHaveBeenLastCalledWith({
      kind: "openai-compatible",
      baseUrl: "https://llm.example/v1",
      credential: "sk-new",
    });

    await app.request("/api/platform/model-gateway", {
      method: "PUT",
      ...json({
        kind: "openai-compatible",
        baseUrl: "https://llm.example/v1",
        credential: "sk-stored",
      }),
    });
    await app.request("/api/platform/model-gateway/test", {
      method: "POST",
      ...json({ kind: "openai-compatible", baseUrl: "https://llm.example/v1" }),
    });
    expect(testModelGatewayConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({ credential: "sk-stored" }),
    );

    const elsewhere = await app.request("/api/platform/model-gateway/test", {
      method: "POST",
      ...json({ kind: "openai-compatible", baseUrl: "https://attacker.example/v1" }),
    });
    expect(elsewhere.status).toBe(400);
    expect(testModelGatewayConnection).toHaveBeenCalledTimes(2);
  });
});

describe("project Model Gateway routes", () => {
  test("reads the project's settings with the instance gateway's kind", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });
    const project = await store.createProject({ name: "gateway-read", importKind: "zip" });

    const before = await app.request(`/api/projects/${project.id}/model-gateway`);
    await expect(before.json()).resolves.toEqual({
      settings: {
        projectId: project.id,
        mode: "platform",
        projectKeyConfigured: false,
        issuedKey: null,
        updatedAt: null,
      },
      gateway: null,
    });

    await store.saveModelGateway({
      kind: "litellm",
      baseUrl: "https://llm.example/v1",
      encryptedCredential: "x",
    });
    const after = await app.request(`/api/projects/${project.id}/model-gateway`);
    await expect(after.json()).resolves.toMatchObject({
      gateway: { kind: "litellm", issuesProjectKeys: true },
    });
  });

  test("answers 404 for an unknown project", async () => {
    const app = createApp(createTestStore(), { appSecretKey });
    const response = await app.request("/api/projects/proj_missing0000/model-gateway");
    expect(response.status).toBe(404);
  });

  test("saves the project's own key encrypted and restarts its live deployments", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });
    const { project, deployment } = await projectWithLiveDeployment(store, "own-key");

    const saved = await app.request(`/api/projects/${project.id}/model-gateway`, {
      method: "PUT",
      ...json({ mode: "project-key", projectKey: "sk-project-own" }),
    });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      settings: { mode: "project-key", projectKeyConfigured: true },
      jobs: [{ deploymentId: deployment.id }],
    });
    expect(JSON.stringify(body)).not.toContain("sk-project-own");
    const record = await store.getProjectModelGatewayRecord(project.id);
    expect(decrypt(record.encryptedProjectKey!)).toBe("sk-project-own");
  });

  test("requires a key before a project can switch to its own key", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });
    const project = await store.createProject({ name: "own-key-missing", importKind: "zip" });

    const response = await app.request(`/api/projects/${project.id}/model-gateway`, {
      method: "PUT",
      ...json({ mode: "project-key" }),
    });
    expect(response.status).toBe(400);
  });

  test("clears the project's own key when it leaves that mode", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });
    const project = await store.createProject({ name: "own-key-cleared", importKind: "zip" });
    await app.request(`/api/projects/${project.id}/model-gateway`, {
      method: "PUT",
      ...json({ mode: "project-key", projectKey: "sk-project-own" }),
    });

    await app.request(`/api/projects/${project.id}/model-gateway`, {
      method: "PUT",
      ...json({ mode: "off" }),
    });
    await expect(store.getProjectModelGatewayRecord(project.id)).resolves.toMatchObject({
      mode: "off",
      encryptedProjectKey: null,
    });
  });

  test("queues a key rotation only for a project holding an issued key", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });
    const project = await store.createProject({ name: "rotate", importKind: "zip" });

    const refused = await app.request(`/api/projects/${project.id}/model-gateway/rotate`, {
      method: "POST",
    });
    expect(refused.status).toBe(409);

    await store.saveModelGateway({
      kind: "litellm",
      baseUrl: "https://llm.example/v1",
      encryptedCredential: "x",
    });
    await store.saveIssuedModelGatewayKey(project.id, {
      alias: `eveland-${project.id}`,
      encryptedKey: "y",
      gatewayIdentity: "litellm:https://llm.example/v1",
      state: "registered",
      issuedAt: "2026-11-03T00:00:00.000Z",
    });
    const queued = await app.request(`/api/projects/${project.id}/model-gateway/rotate`, {
      method: "POST",
    });
    expect(queued.status).toBe(202);
    await expect(queued.json()).resolves.toMatchObject({
      job: { type: "rotate_model_gateway_key" },
    });
  });
});
