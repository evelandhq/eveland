import { encryptSecretValue } from "@evelandhq/core/server/secrets";
import { createTestStore } from "@evelandhq/db/vitest";
import { expect, test } from "vitest";
import {
  registerModelGatewayTestCleanup,
  startOpenAiCompatibleUpstream,
} from "./app.test-support.js";
import { createStoreBackedModelRegistry } from "./store-registry.js";

registerModelGatewayTestCleanup();

const SECRET_KEY = "eveland-mg-secret-key-0000000000";
const userPrompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }];

async function seed(store: ReturnType<typeof createTestStore>, baseUrl: string) {
  await store.upsertModelGatewayProviderConnection({
    providerId: "zai",
    name: "Z.ai",
    baseUrl,
    encryptedApiKey: JSON.stringify(encryptSecretValue("sk-live-registry", SECRET_KEY)),
  });
  await store.upsertModelGatewayModelRoute({
    modelId: "zai/glm-5.3-flash",
    providerId: "zai",
    providerModelId: "glm-5.3-flash",
    displayName: "GLM 5.3 Flash",
  });
}

test("resolves a routed model and calls the provider with the decrypted BYOK key", async () => {
  const upstream = await startOpenAiCompatibleUpstream();
  const store = createTestStore();
  await seed(store, `${upstream.origin}/v1`);
  const registry = createStoreBackedModelRegistry({ store, secretKey: SECRET_KEY });

  const model = await registry.resolveModel("zai/glm-5.3-flash");
  expect(model).toBeDefined();
  const result = await model!.doGenerate({ prompt: userPrompt });
  expect(result.content).toEqual([{ type: "text", text: "upstream generation" }]);
  expect(upstream.recording.requests[0]!.headers.authorization).toBe("Bearer sk-live-registry");
  expect((upstream.recording.requests[0]!.body as { model: string }).model).toBe("glm-5.3-flash");
});

test("lists routed models in the config catalog shape", async () => {
  const upstream = await startOpenAiCompatibleUpstream();
  const store = createTestStore();
  await seed(store, `${upstream.origin}/v1`);
  const registry = createStoreBackedModelRegistry({ store, secretKey: SECRET_KEY });

  expect(await registry.listModels()).toEqual([
    {
      id: "zai/glm-5.3-flash",
      name: "GLM 5.3 Flash",
      specification: { specificationVersion: "v4", provider: "zai", modelId: "glm-5.3-flash" },
      modelType: "language",
    },
  ]);
});

test("an unrouted model resolves to nothing, and refresh picks up new routes", async () => {
  const upstream = await startOpenAiCompatibleUpstream();
  const store = createTestStore();
  const registry = createStoreBackedModelRegistry({ store, secretKey: SECRET_KEY });

  expect(await registry.resolveModel("zai/glm-5.3-flash")).toBeUndefined();

  await seed(store, `${upstream.origin}/v1`);
  await registry.refresh();
  expect(await registry.resolveModel("zai/glm-5.3-flash")).toBeDefined();
});

test("a connection with an undecryptable key fails closed for its models only", async () => {
  const upstream = await startOpenAiCompatibleUpstream();
  const store = createTestStore();
  await seed(store, `${upstream.origin}/v1`);
  await store.upsertModelGatewayProviderConnection({
    providerId: "broken",
    name: "Broken",
    baseUrl: `${upstream.origin}/v1`,
    encryptedApiKey: JSON.stringify(encryptSecretValue("sk-x", "another-key-000000000000000000zz")),
  });
  await store.upsertModelGatewayModelRoute({
    modelId: "broken/model",
    providerId: "broken",
    providerModelId: "model",
  });
  const registry = createStoreBackedModelRegistry({ store, secretKey: SECRET_KEY });

  expect(await registry.resolveModel("broken/model")).toBeUndefined();
  expect(await registry.resolveModel("zai/glm-5.3-flash")).toBeDefined();
});
