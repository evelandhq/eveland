import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

const now = new Date("2026-08-27T05:00:00.000Z");
const later = new Date("2026-08-27T06:00:00.000Z");
const latest = new Date("2026-08-27T07:00:00.000Z");

describe("model gateway registry persistence", () => {
  test("provider connections upsert by providerId and keep one row", async () => {
    const store = createTestStore();
    const created = await store.upsertModelGatewayProviderConnection(
      {
        providerId: "zai",
        name: "Z.ai",
        baseUrl: "https://api.z.ai/api/paas/v4",
        encryptedApiKey: "encrypted-1",
      },
      now,
    );
    expect(created).toMatchObject({ providerId: "zai", name: "Z.ai" });

    const updated = await store.upsertModelGatewayProviderConnection(
      {
        providerId: "zai",
        name: "Z.ai International",
        baseUrl: "https://api.z.ai/api/paas/v4",
        encryptedApiKey: "encrypted-2",
      },
      later,
    );
    expect(updated.id).toBe(created.id);
    expect(updated.encryptedApiKey).toBe("encrypted-2");

    const listed = await store.listModelGatewayProviderConnections();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ providerId: "zai", name: "Z.ai International" });
  });

  test("model routes upsert by canonical model id and join their provider", async () => {
    const store = createTestStore();
    await store.upsertModelGatewayProviderConnection(
      { providerId: "zai", name: "Z.ai", baseUrl: "https://z", encryptedApiKey: "e" },
      now,
    );
    await store.upsertModelGatewayProviderConnection(
      { providerId: "deepseek", name: "DeepSeek", baseUrl: "https://d", encryptedApiKey: "e" },
      now,
    );

    const route = await store.upsertModelGatewayModelRoute(
      {
        modelId: "zai/glm-5.3-flash",
        providerId: "zai",
        providerModelId: "glm-5.3-flash",
        displayName: "GLM 5.3 Flash",
      },
      now,
    );
    expect(route).toMatchObject({ modelId: "zai/glm-5.3-flash", providerId: "zai" });

    // Re-pointing the same canonical model keeps one row.
    await store.upsertModelGatewayModelRoute(
      { modelId: "zai/glm-5.3-flash", providerId: "deepseek", providerModelId: "glm-alias" },
      later,
    );
    const routes = await store.listModelGatewayModelRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ providerId: "deepseek", providerModelId: "glm-alias" });
  });

  test("routing to an unknown provider fails closed", async () => {
    const store = createTestStore();
    await expect(
      store.upsertModelGatewayModelRoute(
        { modelId: "zai/glm-5.3-flash", providerId: "nobody", providerModelId: "x" },
        now,
      ),
    ).rejects.toThrow(/unknown provider/i);
  });

  test("deleting a provider connection cascades its routes", async () => {
    const store = createTestStore();
    await store.upsertModelGatewayProviderConnection(
      { providerId: "zai", name: "Z.ai", baseUrl: "https://z", encryptedApiKey: "e" },
      now,
    );
    await store.upsertModelGatewayModelRoute(
      { modelId: "zai/glm-5.3-flash", providerId: "zai", providerModelId: "glm-5.3-flash" },
      now,
    );
    await store.deleteModelGatewayProviderConnection("zai", later);
    expect(await store.listModelGatewayProviderConnections()).toEqual([]);
    expect(await store.listModelGatewayModelRoutes()).toEqual([]);
  });

  test("every registry mutation leaves an audit event", async () => {
    const store = createTestStore();
    await store.upsertModelGatewayProviderConnection(
      { providerId: "zai", name: "Z.ai", baseUrl: "https://z", encryptedApiKey: "e" },
      now,
    );
    await store.upsertModelGatewayModelRoute(
      { modelId: "zai/glm-5.3-flash", providerId: "zai", providerModelId: "glm-5.3-flash" },
      new Date("2026-08-27T05:30:00.000Z"),
    );
    await store.deleteModelGatewayModelRoute("zai/glm-5.3-flash", later);
    await store.deleteModelGatewayProviderConnection("zai", latest);

    const events = await store.listModelGatewayRegistryEvents(10);
    expect(events.map((event) => [event.kind, event.subject])).toEqual([
      ["provider.deleted", "zai"],
      ["route.deleted", "zai/glm-5.3-flash"],
      ["route.upserted", "zai/glm-5.3-flash"],
      ["provider.upserted", "zai"],
    ]);
    // The audit trail never records the encrypted credential.
    expect(JSON.stringify(events)).not.toContain("encrypted");
  });
});
