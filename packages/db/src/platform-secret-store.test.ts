import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./store.js";
import { SHARED_AGENT_ENVIRONMENT_PROFILE_ID } from "@eveland/core/contracts";

describe("platform Secret Profile store", () => {
  test("keeps entry values private and revisions semantic", async () => {
    const store = createMemoryStore();
    const saveProfile = Reflect.get(store, "savePlatformSecretProfile");
    const getProfileRecord = Reflect.get(store, "getPlatformSecretProfileRecord");

    expect(saveProfile).toBeTypeOf("function");
    expect(getProfileRecord).toBeTypeOf("function");

    const created = await saveProfile.call(store, {
      name: "Shared model credentials",
      entries: [
        { key: "MODEL_REGION", kind: "variable", encryptedValue: "encrypted-region" },
        { key: "OPENAI_API_KEY", kind: "secret", encryptedValue: "encrypted-key" },
      ],
    });
    expect(created).toMatchObject({ revision: 1, name: "Shared model credentials" });
    expect(created.entries).toEqual([
      { key: "MODEL_REGION", kind: "variable", configured: true },
      { key: "OPENAI_API_KEY", kind: "secret", configured: true },
    ]);
    expect(JSON.stringify(created)).not.toContain("encrypted-");

    const unchanged = await saveProfile.call(store, {
      id: created.id,
      name: created.name,
      entries: [
        { key: "OPENAI_API_KEY", kind: "secret", encryptedValue: "encrypted-key" },
        { key: "MODEL_REGION", kind: "variable", encryptedValue: "encrypted-region" },
      ],
    });
    expect(unchanged.revision).toBe(1);

    const updated = await saveProfile.call(store, {
      id: created.id,
      name: created.name,
      entries: [
        { key: "MODEL_REGION", kind: "variable", encryptedValue: "encrypted-region" },
        { key: "OPENAI_API_KEY", kind: "secret", encryptedValue: "encrypted-key-v2" },
      ],
    });
    expect(updated.revision).toBe(2);
    await expect(getProfileRecord.call(store, created.id)).resolves.toMatchObject({
      revision: 2,
      entries: expect.arrayContaining([
        { key: "OPENAI_API_KEY", kind: "secret", encryptedValue: "encrypted-key-v2" },
      ]),
    });
  });

  test("keeps one explicit binding per target and consumer", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Profile Binding Agent", importKind: "zip" });
    const firstProfile = await store.savePlatformSecretProfile({
      name: "First profile",
      entries: [{ key: "TOKEN", kind: "secret", encryptedValue: "encrypted-first" }],
    });
    const secondProfile = await store.savePlatformSecretProfile({
      name: "Second profile",
      entries: [{ key: "TOKEN", kind: "secret", encryptedValue: "encrypted-second" }],
    });
    const bindProfile = Reflect.get(store, "bindPlatformSecretProfile");
    const listBindings = Reflect.get(store, "listProjectPlatformSecretBindings");
    const resolveProfiles = Reflect.get(store, "resolvePlatformSecretProfileRecords");

    expect(bindProfile).toBeTypeOf("function");
    expect(listBindings).toBeTypeOf("function");
    expect(resolveProfiles).toBeTypeOf("function");

    const firstBinding = await bindProfile.call(store, {
      profileId: firstProfile.id,
      projectId: project.id,
      deploymentId: null,
      consumer: "agent-runtime",
    });
    const replaced = await bindProfile.call(store, {
      profileId: secondProfile.id,
      projectId: project.id,
      deploymentId: null,
      consumer: "agent-runtime",
    });
    const connectionBinding = await bindProfile.call(store, {
      profileId: firstProfile.id,
      projectId: project.id,
      deploymentId: null,
      consumer: "agent-connection",
    });

    expect(replaced.id).toBe(firstBinding.id);
    expect(replaced).toMatchObject({ profileId: secondProfile.id, profileRevision: 1 });
    expect(connectionBinding.id).not.toBe(firstBinding.id);
    const listed = await listBindings.call(store, project.id);
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain("encrypted-");
    await expect(resolveProfiles.call(store, {
      projectId: project.id,
      deploymentId: null,
      consumer: "agent-runtime",
    })).resolves.toEqual({
      project: expect.objectContaining({ id: secondProfile.id, entries: [
        { key: "TOKEN", kind: "secret", encryptedValue: "encrypted-second" },
      ] }),
      deployment: null,
    });
  });
});

describe("shared Agent environment store", () => {
  test("stores one revisioned environment without exposing encrypted values", async () => {
    const store = createMemoryStore();
    const saveEnvironment = Reflect.get(store, "saveSharedAgentEnvironment");
    const getEnvironmentRecord = Reflect.get(store, "getSharedAgentEnvironmentRecord");

    expect(saveEnvironment).toBeTypeOf("function");
    expect(getEnvironmentRecord).toBeTypeOf("function");

    const created = await saveEnvironment.call(store, {
      entries: [
        { key: "MODEL_REGION", kind: "variable", encryptedValue: "encrypted-region" },
        { key: "OPENAI_API_KEY", kind: "secret", encryptedValue: "encrypted-key" },
      ],
    });
    expect(created).toMatchObject({
      revision: 1,
      entries: [
        { key: "MODEL_REGION", kind: "variable", configured: true },
        { key: "OPENAI_API_KEY", kind: "secret", configured: true },
      ],
    });
    expect(created).not.toHaveProperty("id");
    expect(created).not.toHaveProperty("name");
    expect(JSON.stringify(created)).not.toContain("encrypted-");

    const unchanged = await saveEnvironment.call(store, {
      entries: [
        { key: "OPENAI_API_KEY", kind: "secret", encryptedValue: "encrypted-key" },
        { key: "MODEL_REGION", kind: "variable", encryptedValue: "encrypted-region" },
      ],
    });
    expect(unchanged.revision).toBe(1);

    const updated = await saveEnvironment.call(store, {
      entries: [
        { key: "OPENAI_API_KEY", kind: "secret", encryptedValue: "encrypted-key-v2" },
      ],
    });
    expect(updated.revision).toBe(2);
    await expect(getEnvironmentRecord.call(store)).resolves.toMatchObject({
      revision: 2,
      entries: [
        { key: "OPENAI_API_KEY", kind: "secret", encryptedValue: "encrypted-key-v2" },
      ],
    });
  });

  test("binds the shared environment without exposing Profile concepts", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Shared Environment Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/shared-environment-source",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "shared:environment",
      containerName: "shared-environment",
      internalPort: 3000,
      hostPort: 42001,
      runtimeKind: "docker",
    });
    await Reflect.get(store, "saveSharedAgentEnvironment").call(store, {
      entries: [{ key: "OPENAI_API_KEY", kind: "secret", encryptedValue: "encrypted-key" }],
    });
    const bindEnvironment = Reflect.get(store, "bindSharedAgentEnvironment");
    const listProjectBindings = Reflect.get(store, "listProjectSharedAgentEnvironmentBindings");
    const listAllBindings = Reflect.get(store, "listSharedAgentEnvironmentBindings");
    const resolveEnvironment = Reflect.get(store, "resolveSharedAgentEnvironmentRecords");
    const deleteBinding = Reflect.get(store, "deleteSharedAgentEnvironmentBinding");

    expect(bindEnvironment).toBeTypeOf("function");
    expect(listProjectBindings).toBeTypeOf("function");
    expect(listAllBindings).toBeTypeOf("function");
    expect(resolveEnvironment).toBeTypeOf("function");
    expect(deleteBinding).toBeTypeOf("function");

    await expect(store.bindPlatformSecretProfile({
      profileId: SHARED_AGENT_ENVIRONMENT_PROFILE_ID,
      projectId: project.id,
      deploymentId: null,
      consumer: "agent-connection",
    })).rejects.toThrow("cannot be used for Agent Connection credentials");

    const projectBinding = await bindEnvironment.call(store, {
      projectId: project.id,
      deploymentId: null,
    });
    const deploymentBinding = await bindEnvironment.call(store, {
      projectId: project.id,
      deploymentId: deployment.id,
    });
    expect(projectBinding).toMatchObject({
      projectId: project.id,
      deploymentId: null,
      environmentRevision: 1,
    });
    expect(projectBinding).not.toHaveProperty("profileId");
    expect(projectBinding).not.toHaveProperty("profileName");
    expect(projectBinding).not.toHaveProperty("consumer");
    await expect(listProjectBindings.call(store, project.id)).resolves.toHaveLength(2);
    await expect(listAllBindings.call(store)).resolves.toHaveLength(2);
    await expect(resolveEnvironment.call(store, {
      projectId: project.id,
      deploymentId: deployment.id,
    })).resolves.toEqual({
      project: expect.objectContaining({ revision: 1 }),
      deployment: expect.objectContaining({ revision: 1 }),
    });
    await expect(deleteBinding.call(store, project.id, deploymentBinding.id)).resolves.toMatchObject({
      id: deploymentBinding.id,
      deploymentId: deployment.id,
    });
    await expect(listProjectBindings.call(store, project.id)).resolves.toEqual([
      expect.objectContaining({ id: projectBinding.id }),
    ]);
  });
});
