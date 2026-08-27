import { decryptSecretValue, type EncryptedSecret } from "@evelandhq/core/server/secrets";
import { createTestStore } from "@evelandhq/db/vitest";
import { describe, expect, test, vi } from "vitest";
import { createApp } from "./app.js";
import { createAuthApp, signIn } from "./auth-routes.test-support.js";

const SECRET_KEY = "eveland-mg-secret-key-0000000000";

function jsonRequest(method: string, body: unknown) {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("model gateway admin registry routes", () => {
  test("saving a provider verifies the key, encrypts it, and never echoes it", async () => {
    const store = createTestStore();
    const verify = vi.fn(async () => true);
    const app = createApp(store, {
      appSecretKey: "eveland-test-secret-key-00000000",
      modelGatewaySecretKey: SECRET_KEY,
      modelGatewayVerifyProviderKey: verify,
    });

    const response = await app.request(
      "/system/model-gateway/providers/zai",
      jsonRequest("PUT", {
        name: "Z.ai",
        baseUrl: "https://api.z.ai/api/paas/v4",
        apiKey: "sk-live-secret",
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { provider: Record<string, unknown> };
    expect(body.provider).toMatchObject({ providerId: "zai", name: "Z.ai" });
    expect(JSON.stringify(body)).not.toContain("sk-live-secret");
    expect(verify).toHaveBeenCalledWith({
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "sk-live-secret",
    });

    const stored = await store.listModelGatewayProviderConnections();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.encryptedApiKey).not.toContain("sk-live-secret");
    expect(
      decryptSecretValue(JSON.parse(stored[0]!.encryptedApiKey) as EncryptedSecret, SECRET_KEY),
    ).toBe("sk-live-secret");
  });

  test("a provider key that fails verification is not stored (fail-closed)", async () => {
    const store = createTestStore();
    const app = createApp(store, {
      appSecretKey: "eveland-test-secret-key-00000000",
      modelGatewaySecretKey: SECRET_KEY,
      modelGatewayVerifyProviderKey: async () => false,
    });
    const response = await app.request(
      "/system/model-gateway/providers/zai",
      jsonRequest("PUT", { name: "Z.ai", baseUrl: "https://api.z.ai", apiKey: "sk-bad" }),
    );
    expect(response.status).toBe(400);
    expect(await store.listModelGatewayProviderConnections()).toEqual([]);
  });

  test("routes CRUD round-trips and the member catalog lists them", async () => {
    const store = createTestStore();
    const app = createApp(store, {
      appSecretKey: "eveland-test-secret-key-00000000",
      modelGatewaySecretKey: SECRET_KEY,
      modelGatewayVerifyProviderKey: async () => true,
    });
    await app.request(
      "/system/model-gateway/providers/zai",
      jsonRequest("PUT", { name: "Z.ai", baseUrl: "https://z", apiKey: "sk" }),
    );

    const upsert = await app.request(
      "/system/model-gateway/models",
      jsonRequest("PUT", {
        modelId: "zai/glm-5.3-flash",
        providerId: "zai",
        providerModelId: "glm-5.3-flash",
        displayName: "GLM 5.3 Flash",
      }),
    );
    expect(upsert.status).toBe(200);

    const unknownProvider = await app.request(
      "/system/model-gateway/models",
      jsonRequest("PUT", { modelId: "x/y", providerId: "nobody", providerModelId: "y" }),
    );
    expect(unknownProvider.status).toBe(400);

    const catalog = await app.request("/model-gateway/models");
    expect(catalog.status).toBe(200);
    await expect(catalog.json()).resolves.toEqual({
      models: [
        expect.objectContaining({
          modelId: "zai/glm-5.3-flash",
          providerId: "zai",
          displayName: "GLM 5.3 Flash",
        }),
      ],
    });

    const remove = await app.request(
      "/system/model-gateway/models",
      jsonRequest("DELETE", { modelId: "zai/glm-5.3-flash" }),
    );
    expect(remove.status).toBe(200);
    const removeProvider = await app.request("/system/model-gateway/providers/zai", {
      method: "DELETE",
    });
    expect(removeProvider.status).toBe(200);
    const missing = await app.request("/system/model-gateway/providers/zai", {
      method: "DELETE",
    });
    expect(missing.status).toBe(404);
  });

  test("registry events are listed for the audit view", async () => {
    const store = createTestStore();
    const app = createApp(store, {
      appSecretKey: "eveland-test-secret-key-00000000",
      modelGatewaySecretKey: SECRET_KEY,
      modelGatewayVerifyProviderKey: async () => true,
    });
    await app.request(
      "/system/model-gateway/providers/zai",
      jsonRequest("PUT", { name: "Z.ai", baseUrl: "https://z", apiKey: "sk" }),
    );
    const events = await app.request("/system/model-gateway/registry-events");
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toEqual({
      events: [expect.objectContaining({ kind: "provider.upserted", subject: "zai" })],
    });
  });
});

describe("model gateway personal api keys", () => {
  test("a signed-in member mints, lists, and revokes their own key", async () => {
    const { app, store } = await createAuthApp();
    const { cookie } = await signIn(app);

    const minted = await app.request("/model-gateway/api-keys", {
      ...jsonRequest("POST", { name: "local eve dev" }),
      headers: { "content-type": "application/json", cookie },
    });
    expect(minted.status).toBe(200);
    const mintedBody = (await minted.json()) as {
      token: string;
      key: { id: string; name: string };
    };
    expect(mintedBody.token).toMatch(/^emk_[A-Za-z0-9_-]{40,}$/);
    expect(mintedBody.key.name).toBe("local eve dev");

    const listed = await app.request("/model-gateway/api-keys", { headers: { cookie } });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { keys: Array<{ id: string }> };
    expect(listedBody.keys).toHaveLength(1);
    expect(JSON.stringify(listedBody)).not.toContain(mintedBody.token);

    const revoked = await app.request(`/model-gateway/api-keys/${mintedBody.key.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(revoked.status).toBe(200);
    const keys = await store.listModelGatewayApiKeys();
    expect(keys[0]!.revokedAt).not.toBeNull();
  });

  test("minting requires a session", async () => {
    const { app } = await createAuthApp();
    const response = await app.request(
      "/model-gateway/api-keys",
      jsonRequest("POST", { name: "anon" }),
    );
    expect(response.status).toBe(401);
  });
});
