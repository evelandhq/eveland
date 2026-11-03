import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

describe("Model Gateway store", () => {
  test("persists one revisioned instance gateway and reports whether a save changed it", async () => {
    const store = createTestStore();
    await expect(store.getModelGatewayRecord()).resolves.toBeNull();

    const created = await store.saveModelGateway({
      kind: "litellm",
      baseUrl: "https://llm.example/v1",
      encryptedCredential: "encrypted-admin",
    });
    expect(created).toMatchObject({
      changed: true,
      gateway: {
        kind: "litellm",
        baseUrl: "https://llm.example/v1",
        credentialConfigured: true,
        revision: 1,
      },
    });
    expect(JSON.stringify(created)).not.toContain("encrypted-");

    const unchanged = await store.saveModelGateway({
      kind: "litellm",
      baseUrl: "https://llm.example/v1",
      encryptedCredential: "encrypted-admin",
    });
    expect(unchanged).toMatchObject({ changed: false, gateway: { revision: 1 } });

    const updated = await store.saveModelGateway({
      kind: "litellm",
      baseUrl: "https://llm.example/v1",
      encryptedCredential: "encrypted-admin-v2",
    });
    expect(updated).toMatchObject({ changed: true, gateway: { revision: 2 } });
    await expect(store.getModelGatewayRecord()).resolves.toMatchObject({
      kind: "litellm",
      encryptedCredential: "encrypted-admin-v2",
      revision: 2,
    });

    await expect(store.deleteModelGateway()).resolves.toBe(true);
    await expect(store.getModelGatewayRecord()).resolves.toBeNull();
    await expect(store.deleteModelGateway()).resolves.toBe(false);
  });

  test("defaults a project to the platform gateway until it chooses otherwise", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "gateway-default", importKind: "zip" });

    await expect(store.getProjectModelGatewayRecord(project.id)).resolves.toEqual({
      projectId: project.id,
      mode: "platform",
      encryptedProjectKey: null,
      issuedKey: null,
      encryptedPendingRotationKey: null,
      updatedAt: null,
    });
  });

  test("keeps the project's own key unless it is replaced or cleared", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "gateway-own-key", importKind: "zip" });

    await store.saveProjectModelGatewaySettings(project.id, {
      mode: "project-key",
      encryptedProjectKey: "encrypted-own",
    });
    await store.saveProjectModelGatewaySettings(project.id, { mode: "project-key" });
    await expect(store.getProjectModelGatewayRecord(project.id)).resolves.toMatchObject({
      mode: "project-key",
      encryptedProjectKey: "encrypted-own",
    });

    await store.saveProjectModelGatewaySettings(project.id, {
      mode: "off",
      encryptedProjectKey: null,
    });
    await expect(store.getProjectModelGatewayRecord(project.id)).resolves.toMatchObject({
      mode: "off",
      encryptedProjectKey: null,
    });
  });

  test("records an issued key through pending, registered, and rotation", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "gateway-issued", importKind: "zip" });
    const issued = {
      alias: `eveland-${project.id}`,
      encryptedKey: "encrypted-k1",
      gatewayIdentity: "litellm:https://llm.example/v1",
      state: "pending" as const,
      issuedAt: "2026-11-03T00:00:00.000Z",
    };

    await store.saveIssuedModelGatewayKey(project.id, issued);
    await store.saveIssuedModelGatewayKey(project.id, { ...issued, state: "registered" });
    await store.savePendingModelGatewayRotationKey(project.id, "encrypted-k2");
    await expect(store.getProjectModelGatewayRecord(project.id)).resolves.toMatchObject({
      mode: "platform",
      issuedKey: { ...issued, state: "registered" },
      encryptedPendingRotationKey: "encrypted-k2",
    });

    await store.saveIssuedModelGatewayKey(project.id, {
      ...issued,
      encryptedKey: "encrypted-k2",
      state: "registered",
    });
    await store.savePendingModelGatewayRotationKey(project.id, null);
    await expect(store.getProjectModelGatewayRecord(project.id)).resolves.toMatchObject({
      issuedKey: { encryptedKey: "encrypted-k2" },
      encryptedPendingRotationKey: null,
    });

    await store.saveIssuedModelGatewayKey(project.id, null);
    await expect(store.getProjectModelGatewayRecord(project.id)).resolves.toMatchObject({
      issuedKey: null,
    });
  });

  test("lists the projects holding an issued key", async () => {
    const store = createTestStore();
    const holder = await store.createProject({ name: "gateway-holder", importKind: "zip" });
    const other = await store.createProject({ name: "gateway-other", importKind: "zip" });
    await store.saveProjectModelGatewaySettings(other.id, { mode: "off" });
    await store.saveIssuedModelGatewayKey(holder.id, {
      alias: `eveland-${holder.id}`,
      encryptedKey: "encrypted-k1",
      gatewayIdentity: "litellm:https://llm.example/v1",
      state: "registered",
      issuedAt: "2026-11-03T00:00:00.000Z",
    });

    const records = await store.listProjectModelGatewayRecords();
    expect(records.map((record) => record.projectId).sort()).toEqual([holder.id, other.id].sort());
  });

  test("removes a project's gateway settings and issued key with the project", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "gateway-deleted", importKind: "zip" });
    await store.saveProjectModelGatewaySettings(project.id, {
      mode: "project-key",
      encryptedProjectKey: "encrypted-own",
    });

    await store.deleteProject(project.id);

    await expect(store.listProjectModelGatewayRecords()).resolves.toEqual([]);
  });
});
