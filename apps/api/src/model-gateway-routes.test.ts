import { createTestStore } from "@evelandhq/db/vitest";
import { describe, expect, test } from "vitest";
import { createApp } from "./app.js";

const appSecretKey = "eveland-test-secret-key-00000000";
const json = (body: unknown) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

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
  test("saves the gateway's kind and normalized base URL, and nothing else", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });

    const empty = await app.request("/api/platform/model-gateway");
    await expect(empty.json()).resolves.toEqual({ gateway: null });

    const saved = await app.request("/api/platform/model-gateway", {
      method: "PUT",
      ...json({ kind: "litellm", baseUrl: " https://llm.example/v1/ " }),
    });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      gateway: { kind: "litellm", baseUrl: "https://llm.example/v1", revision: 1 },
      jobs: [],
    });

    const read = await app.request("/api/platform/model-gateway");
    await expect(read.json()).resolves.toMatchObject({
      gateway: { kind: "litellm", baseUrl: "https://llm.example/v1" },
    });
  });

  test.each([
    [{ kind: "new-api", baseUrl: "https://x/v1" }, "kind"],
    [{ kind: "vercel", baseUrl: "https://x/v1" }, "kind"],
    [{ kind: "litellm" }, "baseUrl"],
    [{ kind: "litellm", baseUrl: "ftp://x" }, "baseUrl"],
    [{ kind: "litellm", baseUrl: "https://user:sk-secret@x/v1" }, "baseUrl"],
  ])("rejects an invalid gateway %j", async (input, field) => {
    const app = createApp(createTestStore(), { appSecretKey });
    const response = await app.request("/api/platform/model-gateway", {
      method: "PUT",
      ...json(input),
    });
    expect(response.status).toBe(400);
    const body = JSON.stringify(await response.json());
    expect(body).toContain(field);
    expect(body).not.toContain("sk-secret");
  });

  test("restarts the live deployments of every project that uses the gateway when it changes", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });
    const using = await projectWithLiveDeployment(store, "uses-gateway");
    const optedOut = await projectWithLiveDeployment(store, "opted-out");
    await store.saveProjectModelGatewayMode(optedOut.project.id, "off");
    const save = () =>
      app.request("/api/platform/model-gateway", {
        method: "PUT",
        ...json({ kind: "openai-compatible", baseUrl: "https://llm.example/v1" }),
      });

    const body = (await (await save()).json()) as {
      jobs: Array<{ projectId: string; deploymentId: string }>;
    };
    expect(body.jobs.map((job) => job.projectId)).toEqual([using.project.id]);
    expect(body.jobs[0]!.deploymentId).toBe(using.deployment.id);
    const [restart] = await store.listProjectJobs(using.project.id, { type: "restart_deployment" });
    expect(restart!.payload).toMatchObject({ reason: "model_gateway_changed" });

    // Resaving the same gateway changes nothing, so nothing restarts.
    await expect((await save()).json()).resolves.toMatchObject({ jobs: [] });

    const removed = await app.request("/api/platform/model-gateway", { method: "DELETE" });
    await expect(removed.json()).resolves.toMatchObject({
      deleted: true,
      jobs: [{ projectId: using.project.id }],
    });
    await expect(store.getModelGateway()).resolves.toBeNull();
  });
});

describe("project Model Gateway routes", () => {
  test("reads the project's setting with the instance gateway it would use", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });
    const project = await store.createProject({ name: "gateway-read", importKind: "zip" });

    const before = await app.request(`/api/projects/${project.id}/model-gateway`);
    await expect(before.json()).resolves.toEqual({
      settings: { projectId: project.id, mode: "platform", updatedAt: null },
      gateway: null,
    });

    await store.saveModelGateway({ kind: "litellm", baseUrl: "https://llm.example/v1" });
    const after = await app.request(`/api/projects/${project.id}/model-gateway`);
    await expect(after.json()).resolves.toMatchObject({
      gateway: { kind: "litellm", baseUrl: "https://llm.example/v1" },
    });
  });

  test("answers 404 for an unknown project", async () => {
    const app = createApp(createTestStore(), { appSecretKey });
    const response = await app.request("/api/projects/proj_missing0000/model-gateway");
    expect(response.status).toBe(404);
  });

  test("opts a project out, restarting its live deployments only when the mode changes", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });
    const { project, deployment } = await projectWithLiveDeployment(store, "opt-out");
    const save = (mode: unknown) =>
      app.request(`/api/projects/${project.id}/model-gateway`, {
        method: "PUT",
        ...json({ mode }),
      });

    const optedOut = await save("off");
    expect(optedOut.status).toBe(200);
    await expect(optedOut.json()).resolves.toMatchObject({
      settings: { mode: "off" },
      jobs: [{ deploymentId: deployment.id }],
    });
    await expect((await save("off")).json()).resolves.toMatchObject({ jobs: [] });

    const invalid = await save("project-key");
    expect(invalid.status).toBe(400);
    await expect(store.getProjectModelGateway(project.id)).resolves.toMatchObject({ mode: "off" });
  });
});
