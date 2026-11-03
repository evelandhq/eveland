import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

describe("Model Gateway store", () => {
  test("persists one revisioned instance gateway and reports whether a save changed it", async () => {
    const store = createTestStore();
    await expect(store.getModelGateway()).resolves.toBeNull();

    const created = await store.saveModelGateway({
      kind: "litellm",
      baseUrl: "https://llm.example/v1",
    });
    expect(created).toMatchObject({
      changed: true,
      gateway: { kind: "litellm", baseUrl: "https://llm.example/v1", revision: 1 },
    });

    const unchanged = await store.saveModelGateway({
      kind: "litellm",
      baseUrl: "https://llm.example/v1",
    });
    expect(unchanged).toMatchObject({ changed: false, gateway: { revision: 1 } });

    const updated = await store.saveModelGateway({
      kind: "litellm",
      baseUrl: "https://llm-new.example/v1",
    });
    expect(updated).toMatchObject({ changed: true, gateway: { revision: 2 } });
    await expect(store.getModelGateway()).resolves.toMatchObject({
      baseUrl: "https://llm-new.example/v1",
      revision: 2,
    });

    await expect(store.deleteModelGateway()).resolves.toBe(true);
    await expect(store.getModelGateway()).resolves.toBeNull();
    await expect(store.deleteModelGateway()).resolves.toBe(false);
  });

  test("stores Vercel AI Gateway without a base URL, and switches kinds in place", async () => {
    const store = createTestStore();
    await store.saveModelGateway({ kind: "litellm", baseUrl: "https://llm.example/v1" });

    const switched = await store.saveModelGateway({ kind: "vercel", baseUrl: null });
    expect(switched).toMatchObject({
      changed: true,
      gateway: { kind: "vercel", baseUrl: null, revision: 2 },
    });
    await expect(store.saveModelGateway({ kind: "litellm", baseUrl: null })).rejects.toThrow();
  });

  test("defaults a project to the platform gateway until it opts out", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "gateway-default", importKind: "zip" });

    await expect(store.getProjectModelGateway(project.id)).resolves.toEqual({
      projectId: project.id,
      mode: "platform",
      updatedAt: null,
    });
  });

  test("saves a project's mode and reports whether it changed", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "gateway-mode", importKind: "zip" });

    await expect(store.saveProjectModelGatewayMode(project.id, "platform")).resolves.toMatchObject({
      changed: false,
      setting: { mode: "platform" },
    });
    await expect(store.saveProjectModelGatewayMode(project.id, "off")).resolves.toMatchObject({
      changed: true,
      setting: { mode: "off" },
    });
    await expect(store.saveProjectModelGatewayMode(project.id, "off")).resolves.toMatchObject({
      changed: false,
    });
    await expect(store.getProjectModelGateway(project.id)).resolves.toMatchObject({ mode: "off" });
  });

  test("records on each Release whether it carries the Model Gateway provider", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "gateway-release", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/gateway-release",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const record = (name: string, modelGatewayProvider?: boolean) =>
      store.recordDeployment({
        releaseId: `rel_${name}`,
        projectId: project.id,
        sourceRevisionId: revision.id,
        imageTag: `eveland/${name}:rel`,
        containerName: `eveland-${name}`,
        internalPort: 3000,
        hostPort: 41000 + name.length,
        runtimeKind: "systemd",
        ...(modelGatewayProvider === undefined ? {} : { modelGatewayProvider }),
      });

    await record("with", true);
    await record("without", false);
    // A writer that states nothing -- and every Release built before the
    // provider existed -- has none.
    await record("legacy");
    await expect(store.getRelease("rel_with")).resolves.toMatchObject({
      modelGatewayProvider: true,
    });
    await expect(store.getRelease("rel_without")).resolves.toMatchObject({
      modelGatewayProvider: false,
    });
    await expect(store.getRelease("rel_legacy")).resolves.toMatchObject({
      modelGatewayProvider: false,
    });
  });

  test("lists saved project settings and removes them with the project", async () => {
    const store = createTestStore();
    const kept = await store.createProject({ name: "gateway-kept", importKind: "zip" });
    const deleted = await store.createProject({ name: "gateway-deleted", importKind: "zip" });
    await store.saveProjectModelGatewayMode(kept.id, "off");
    await store.saveProjectModelGatewayMode(deleted.id, "off");

    await store.deleteProject(deleted.id);

    const settings = await store.listProjectModelGateways();
    expect(settings.map((setting) => setting.projectId)).toEqual([kept.id]);
  });
});
