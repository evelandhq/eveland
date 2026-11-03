import { MODEL_GATEWAY_ENV, modelGatewayKeyAlias } from "@evelandhq/core/model-gateway";
import { decryptSecretValue, encryptSecretValue } from "@evelandhq/core/server/secrets";
import { createTestStore } from "@evelandhq/db/vitest";
import { describe, expect, test, vi } from "vitest";

import {
  resolveModelGatewayEnvironment,
  revokeProjectModelGatewayKey,
  rotateProjectModelGatewayKey,
  type ModelGatewayKeyClient,
} from "./model-gateway-environment.js";
import { parseEncryptedSecret } from "./process-support.js";

const appSecretKey = "eveland-test-secret-key-00000000";
const encrypt = (value: string) => JSON.stringify(encryptSecretValue(value, appSecretKey));
const decrypt = (value: string) => decryptSecretValue(parseEncryptedSecret(value), appSecretKey);

const inactive = {
  [MODEL_GATEWAY_ENV.kind]: "",
  [MODEL_GATEWAY_ENV.url]: "",
  [MODEL_GATEWAY_ENV.key]: "",
};

function fakeClient(overrides: Partial<ModelGatewayKeyClient> = {}): ModelGatewayKeyClient {
  return {
    generate: vi.fn(async () => ({ status: "created" as const })),
    exists: vi.fn(async () => false),
    regenerate: vi.fn(async () => undefined),
    delete: vi.fn(async () => ({ status: "deleted" as const })),
    ...overrides,
  };
}

async function projectWithGateway(kind: "litellm" | "openrouter" | "vercel" = "litellm") {
  const store = createTestStore();
  const project = await store.createProject({ name: `gateway-${kind}`, importKind: "zip" });
  await store.saveModelGateway({
    kind,
    baseUrl: kind === "vercel" ? null : "https://llm.example/v1",
    encryptedCredential: encrypt(kind === "litellm" ? "sk-admin" : "sk-shared"),
  });
  return { store, project };
}

describe("resolveModelGatewayEnvironment", () => {
  test("reserves the names with empty values when no Model Gateway is configured", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "no-gateway", importKind: "zip" });

    await expect(
      resolveModelGatewayEnvironment(store, project.id, { appSecretKey, client: fakeClient() }),
    ).resolves.toEqual({ env: inactive, secretValues: [] });
  });

  test("reserves empty values for a project that opted out", async () => {
    const { store, project } = await projectWithGateway();
    await store.saveProjectModelGatewaySettings(project.id, { mode: "off" });
    const client = fakeClient();

    await expect(
      resolveModelGatewayEnvironment(store, project.id, { appSecretKey, client }),
    ).resolves.toEqual({ env: inactive, secretValues: [] });
    expect(client.generate).not.toHaveBeenCalled();
  });

  test("hands every project the shared key of a gateway that cannot issue keys", async () => {
    const { store, project } = await projectWithGateway("openrouter");

    await expect(
      resolveModelGatewayEnvironment(store, project.id, { appSecretKey, client: fakeClient() }),
    ).resolves.toEqual({
      env: {
        [MODEL_GATEWAY_ENV.kind]: "openrouter",
        [MODEL_GATEWAY_ENV.url]: "https://llm.example/v1",
        [MODEL_GATEWAY_ENV.key]: "sk-shared",
      },
      secretValues: ["sk-shared"],
    });
  });

  test("delivers the project's own key when it chose one", async () => {
    const { store, project } = await projectWithGateway();
    await store.saveProjectModelGatewaySettings(project.id, {
      mode: "project-key",
      encryptedProjectKey: encrypt("sk-own"),
    });
    const client = fakeClient();

    const resolved = await resolveModelGatewayEnvironment(store, project.id, {
      appSecretKey,
      client,
    });

    expect(resolved.env[MODEL_GATEWAY_ENV.key]).toBe("sk-own");
    expect(client.generate).not.toHaveBeenCalled();
  });

  test("fails closed when the project chose its own key but none is stored", async () => {
    const { store, project } = await projectWithGateway();
    await store.saveProjectModelGatewaySettings(project.id, { mode: "project-key" });

    await expect(
      resolveModelGatewayEnvironment(store, project.id, { appSecretKey, client: fakeClient() }),
    ).rejects.toThrow(/its own Model Gateway key, but none is configured/);
  });

  test("issues a LiteLLM key once: stored before it is registered, then reused", async () => {
    const { store, project } = await projectWithGateway();
    const stored: string[] = [];
    const client = fakeClient({
      generate: vi.fn(async (input) => {
        // The value must already be in the database when the gateway sees it.
        const record = await store.getProjectModelGatewayRecord(project.id);
        stored.push(decrypt(record.issuedKey!.encryptedKey));
        expect(record.issuedKey?.state).toBe("pending");
        expect(input.key).toBe(stored[0]);
        return { status: "created" as const };
      }),
    });

    const first = await resolveModelGatewayEnvironment(store, project.id, { appSecretKey, client });

    const key = first.env[MODEL_GATEWAY_ENV.key]!;
    expect(key).toMatch(/^sk-eveland-[A-Za-z0-9_-]{32,}$/);
    expect(first.env[MODEL_GATEWAY_ENV.kind]).toBe("litellm");
    expect(first.secretValues).toEqual([key]);
    expect(first.env[MODEL_GATEWAY_ENV.key]).not.toBe("sk-admin");
    expect(client.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://llm.example/v1",
        adminKey: "sk-admin",
        key,
        alias: modelGatewayKeyAlias(project.id),
        metadata: { eveland_project_id: project.id },
      }),
    );
    await expect(store.getProjectModelGatewayRecord(project.id)).resolves.toMatchObject({
      issuedKey: { state: "registered", alias: modelGatewayKeyAlias(project.id) },
    });

    const second = await resolveModelGatewayEnvironment(store, project.id, {
      appSecretKey,
      client,
    });
    expect(second.env[MODEL_GATEWAY_ENV.key]).toBe(key);
    expect(client.generate).toHaveBeenCalledTimes(1);
  });

  test("finishes a registration a crash interrupted, without minting a second key", async () => {
    const { store, project } = await projectWithGateway();
    const crashing = fakeClient({
      generate: vi.fn(async () => {
        throw new Error("connection reset");
      }),
    });
    await expect(
      resolveModelGatewayEnvironment(store, project.id, { appSecretKey, client: crashing }),
    ).rejects.toThrow(/connection reset/);
    const pending = await store.getProjectModelGatewayRecord(project.id);
    const pendingKey = decrypt(pending.issuedKey!.encryptedKey);

    // The gateway did accept it before the connection dropped.
    const retry = fakeClient({
      generate: vi.fn(async () => ({ status: "alias-taken" as const })),
      exists: vi.fn(async () => true),
    });
    const resolved = await resolveModelGatewayEnvironment(store, project.id, {
      appSecretKey,
      client: retry,
    });

    expect(resolved.env[MODEL_GATEWAY_ENV.key]).toBe(pendingKey);
    expect(retry.exists).toHaveBeenCalledWith(expect.objectContaining({ key: pendingKey }));
    await expect(store.getProjectModelGatewayRecord(project.id)).resolves.toMatchObject({
      issuedKey: { state: "registered" },
    });
  });

  test("fails closed, never falling back to a shared key, when another key holds the alias", async () => {
    const { store, project } = await projectWithGateway();
    const client = fakeClient({
      generate: vi.fn(async () => ({ status: "alias-taken" as const })),
      exists: vi.fn(async () => false),
    });

    await expect(
      resolveModelGatewayEnvironment(store, project.id, { appSecretKey, client }),
    ).rejects.toThrow(new RegExp(`alias ${modelGatewayKeyAlias(project.id)} .* another key`));
  });

  test("issues a new key after the instance moved to a different gateway", async () => {
    const { store, project } = await projectWithGateway();
    const client = fakeClient();
    const first = await resolveModelGatewayEnvironment(store, project.id, { appSecretKey, client });

    await store.saveModelGateway({
      kind: "litellm",
      baseUrl: "https://llm-new.example/v1",
      encryptedCredential: encrypt("sk-admin-new"),
    });
    const second = await resolveModelGatewayEnvironment(store, project.id, {
      appSecretKey,
      client,
    });

    expect(second.env[MODEL_GATEWAY_ENV.key]).not.toBe(first.env[MODEL_GATEWAY_ENV.key]);
    expect(second.env[MODEL_GATEWAY_ENV.url]).toBe("https://llm-new.example/v1");
    expect(client.generate).toHaveBeenCalledTimes(2);
  });
});

describe("rotateProjectModelGatewayKey", () => {
  test("stores the replacement first, regenerates it on the gateway, then makes it current", async () => {
    const { store, project } = await projectWithGateway();
    const issuing = await resolveModelGatewayEnvironment(store, project.id, {
      appSecretKey,
      client: fakeClient(),
    });
    const oldKey = issuing.env[MODEL_GATEWAY_ENV.key]!;
    let pendingAtCall: string | undefined;
    const client = fakeClient({
      regenerate: vi.fn(async () => {
        const record = await store.getProjectModelGatewayRecord(project.id);
        pendingAtCall = record.encryptedPendingRotationKey ?? undefined;
      }),
    });

    await expect(
      rotateProjectModelGatewayKey(store, project.id, { appSecretKey, client }),
    ).resolves.toEqual({
      status: "rotated",
    });

    const record = await store.getProjectModelGatewayRecord(project.id);
    const newKey = decrypt(record.issuedKey!.encryptedKey);
    expect(newKey).not.toBe(oldKey);
    expect(pendingAtCall && decrypt(pendingAtCall)).toBe(newKey);
    expect(record.encryptedPendingRotationKey).toBeNull();
    expect(client.regenerate).toHaveBeenCalledWith(
      expect.objectContaining({ key: oldKey, newKey, gracePeriod: "1h" }),
    );
  });

  test("resumes an interrupted rotation with the replacement it already stored", async () => {
    const { store, project } = await projectWithGateway();
    await resolveModelGatewayEnvironment(store, project.id, { appSecretKey, client: fakeClient() });
    const failing = fakeClient({
      regenerate: vi.fn(async () => {
        throw new Error("timeout");
      }),
    });
    await expect(
      rotateProjectModelGatewayKey(store, project.id, { appSecretKey, client: failing }),
    ).rejects.toThrow(/timeout/);
    const pending = decrypt(
      (await store.getProjectModelGatewayRecord(project.id)).encryptedPendingRotationKey!,
    );

    // The gateway had already swapped the key before the timeout.
    const client = fakeClient({ exists: vi.fn(async (input) => input.key === pending) });
    await rotateProjectModelGatewayKey(store, project.id, { appSecretKey, client });

    expect(client.regenerate).not.toHaveBeenCalled();
    const record = await store.getProjectModelGatewayRecord(project.id);
    expect(decrypt(record.issuedKey!.encryptedKey)).toBe(pending);
    expect(record.encryptedPendingRotationKey).toBeNull();
  });

  test("has nothing to rotate for a project without an issued key", async () => {
    const { store, project } = await projectWithGateway();
    await expect(
      rotateProjectModelGatewayKey(store, project.id, { appSecretKey, client: fakeClient() }),
    ).resolves.toEqual({ status: "nothing-to-rotate" });
  });
});

describe("revokeProjectModelGatewayKey", () => {
  test("revokes the issued key on the gateway it was issued on", async () => {
    const { store, project } = await projectWithGateway();
    const issuing = await resolveModelGatewayEnvironment(store, project.id, {
      appSecretKey,
      client: fakeClient(),
    });
    const client = fakeClient();

    await expect(
      revokeProjectModelGatewayKey(store, project.id, { appSecretKey, client }),
    ).resolves.toEqual({
      status: "revoked",
    });
    expect(client.delete).toHaveBeenCalledWith(
      expect.objectContaining({ adminKey: "sk-admin", key: issuing.env[MODEL_GATEWAY_ENV.key] }),
    );
    await expect(store.getProjectModelGatewayRecord(project.id)).resolves.toMatchObject({
      issuedKey: null,
    });
  });

  test("leaves a key issued on a gateway the instance no longer uses, and says so", async () => {
    const { store, project } = await projectWithGateway();
    await resolveModelGatewayEnvironment(store, project.id, { appSecretKey, client: fakeClient() });
    await store.deleteModelGateway();
    const client = fakeClient();

    await expect(
      revokeProjectModelGatewayKey(store, project.id, { appSecretKey, client }),
    ).resolves.toEqual({
      status: "orphaned",
      alias: modelGatewayKeyAlias(project.id),
    });
    expect(client.delete).not.toHaveBeenCalled();
  });

  test("has nothing to revoke without an issued key", async () => {
    const { store, project } = await projectWithGateway();
    await expect(
      revokeProjectModelGatewayKey(store, project.id, { appSecretKey, client: fakeClient() }),
    ).resolves.toEqual({ status: "none" });
  });
});
