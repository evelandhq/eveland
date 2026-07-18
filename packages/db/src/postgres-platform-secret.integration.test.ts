import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "./client.js";
import { createPostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.EVELAND_POSTGRES_TEST_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => database?.close());

describe.skipIf(!database)("Postgres platform Secret Profiles", () => {
  test("persists the singleton global shared Agent environment", async () => {
    const store = createPostgresStore(database!);
    const suffix = Date.now().toString();
    const environment = await store.saveSharedAgentEnvironment({
      entries: [{ key: "OPENAI_API_KEY", kind: "secret", encryptedValue: `encrypted-${suffix}` }],
    });
    expect(environment.entries).toEqual([
      { key: "OPENAI_API_KEY", kind: "secret", configured: true },
    ]);
    expect(environment).not.toHaveProperty("id");
    expect(environment).not.toHaveProperty("name");
    await expect(store.getSharedAgentEnvironmentRecord()).resolves.toMatchObject({
      entries: [{ key: "OPENAI_API_KEY", kind: "secret", encryptedValue: `encrypted-${suffix}` }],
    });
  });

  test("serializes concurrent writes to the shared Agent environment", async () => {
    const store = createPostgresStore(database!);
    const suffix = Date.now().toString();
    const results = await Promise.all([
      store.saveSharedAgentEnvironment({
        entries: [{ key: "MODEL_ACCOUNT", kind: "variable", encryptedValue: `account-a-${suffix}` }],
      }),
      store.saveSharedAgentEnvironment({
        entries: [{ key: "MODEL_ACCOUNT", kind: "variable", encryptedValue: `account-b-${suffix}` }],
      }),
    ]);

    expect(results).toHaveLength(2);
    await expect(store.getSharedAgentEnvironmentRecord()).resolves.toMatchObject({
      entries: [expect.objectContaining({ key: "MODEL_ACCOUNT" })],
    });
  });

  test("persists encrypted entries and exposes only configured metadata", async () => {
    const store = createPostgresStore(database!);
    const saveProfile = Reflect.get(store, "savePlatformSecretProfile");
    const getProfileRecord = Reflect.get(store, "getPlatformSecretProfileRecord");

    expect(saveProfile).toBeTypeOf("function");
    expect(getProfileRecord).toBeTypeOf("function");

    const created = await saveProfile.call(store, {
      name: `Shared credentials ${Date.now()}`,
      entries: [{ key: "OPENAI_API_KEY", kind: "secret", encryptedValue: "encrypted-postgres-key" }],
    });

    expect(created).toMatchObject({ revision: 1 });
    expect(created.entries).toEqual([{ key: "OPENAI_API_KEY", kind: "secret", configured: true }]);
    expect(JSON.stringify(created)).not.toContain("encrypted-postgres-key");
    await expect(getProfileRecord.call(store, created.id)).resolves.toMatchObject({
      entries: [{ key: "OPENAI_API_KEY", kind: "secret", encryptedValue: "encrypted-postgres-key" }],
    });
  });

  test("replaces a binding atomically per project and consumer", async () => {
    const store = createPostgresStore(database!);
    const project = await store.createProject({ name: `profile-binding-${Date.now()}`, importKind: "zip" });
    const first = await store.savePlatformSecretProfile({
      name: `Binding first ${Date.now()}`,
      entries: [{ key: "TOKEN", kind: "secret", encryptedValue: "encrypted-first" }],
    });
    const second = await store.savePlatformSecretProfile({
      name: `Binding second ${Date.now()}`,
      entries: [{ key: "TOKEN", kind: "secret", encryptedValue: "encrypted-second" }],
    });
    const bindProfile = Reflect.get(store, "bindPlatformSecretProfile");
    const listBindings = Reflect.get(store, "listProjectPlatformSecretBindings");
    const listProfileBindings = Reflect.get(store, "listPlatformSecretProfileBindings");
    const resolveProfiles = Reflect.get(store, "resolvePlatformSecretProfileRecords");
    const deleteBinding = Reflect.get(store, "deletePlatformSecretProfileBinding");
    const deleteProfile = Reflect.get(store, "deletePlatformSecretProfile");

    expect(bindProfile).toBeTypeOf("function");
    expect(listBindings).toBeTypeOf("function");
    expect(listProfileBindings).toBeTypeOf("function");
    expect(resolveProfiles).toBeTypeOf("function");
    expect(deleteBinding).toBeTypeOf("function");
    expect(deleteProfile).toBeTypeOf("function");
    const created = await bindProfile.call(store, {
      profileId: first.id,
      projectId: project.id,
      deploymentId: null,
      consumer: "agent-runtime",
    });
    const replaced = await bindProfile.call(store, {
      profileId: second.id,
      projectId: project.id,
      deploymentId: null,
      consumer: "agent-runtime",
    });

    expect(replaced.id).toBe(created.id);
    await expect(listBindings.call(store, project.id)).resolves.toEqual([
      expect.objectContaining({ profileId: second.id, profileRevision: 1, consumer: "agent-runtime" }),
    ]);
    await expect(listProfileBindings.call(store, second.id)).resolves.toEqual([
      expect.objectContaining({ projectId: project.id, profileId: second.id }),
    ]);
    await expect(resolveProfiles.call(store, {
      projectId: project.id,
      deploymentId: null,
      consumer: "agent-runtime",
    })).resolves.toEqual({
      project: expect.objectContaining({ id: second.id }),
      deployment: null,
    });
    await expect(deleteBinding.call(store, project.id, replaced.id)).resolves.toMatchObject({ id: replaced.id });
    await expect(listBindings.call(store, project.id)).resolves.toEqual([]);
    await expect(deleteProfile.call(store, second.id)).resolves.toBe(true);
    await expect(store.getPlatformSecretProfileRecord(second.id)).resolves.toBeNull();
  });
});
