import { createGateway } from "@ai-sdk/gateway";
import { generateText, streamText } from "ai";
import { expect, test } from "vitest";
import {
  registerModelGatewayTestCleanup,
  startModelGateway,
  startOpenAiCompatibleUpstream,
  TEST_TOKEN,
} from "./app.test-support.js";
import { createStaticModelRegistry } from "./registry.js";

registerModelGatewayTestCleanup();

async function startFullChain() {
  const upstream = await startOpenAiCompatibleUpstream();
  const registry = createStaticModelRegistry(
    [{ id: "zai", baseURL: `${upstream.origin}/v1`, apiKey: "sk-live-zai" }],
    [
      {
        modelId: "zai/glm-5.3-flash",
        connectionId: "zai",
        providerModelId: "glm-5.3-flash",
        displayName: "GLM 5.3 Flash",
      },
    ],
  );
  const { baseURL } = await startModelGateway({
    authenticate: (token) => token === TEST_TOKEN,
    resolveModel: (modelId) => registry.resolveModel(modelId),
    listModels: () => registry.listModels(),
  });
  const gateway = createGateway({ baseURL, apiKey: TEST_TOKEN });
  return { upstream, gateway };
}

test("resolveModel returns undefined for a model without a route", () => {
  const registry = createStaticModelRegistry([], []);
  expect(registry.resolveModel("zai/glm-5.3-flash")).toBeUndefined();
});

test("generateText flows through the gateway to the provider with the routed model id", async () => {
  const { upstream, gateway } = await startFullChain();
  const result = await generateText({
    model: gateway.languageModel("zai/glm-5.3-flash"),
    prompt: "hello",
  });
  expect(result.text).toBe("upstream generation");
  expect(upstream.recording.requests).toHaveLength(1);
  const request = upstream.recording.requests[0]!;
  expect((request.body as { model: string }).model).toBe("glm-5.3-flash");
  expect(request.headers.authorization).toBe("Bearer sk-live-zai");
});

test("streamText streams through the whole chain with usage from the upstream", async () => {
  const { upstream, gateway } = await startFullChain();
  const result = streamText({
    model: gateway.languageModel("zai/glm-5.3-flash"),
    prompt: "hello",
  });
  expect(await result.text).toBe("upstream stream");
  const usage = await result.usage;
  expect(usage.inputTokens).toBe(7);
  expect(usage.outputTokens).toBe(2);
  expect((upstream.recording.requests[0]!.body as { stream: boolean }).stream).toBe(true);
});

test("the gateway token never reaches the upstream provider", async () => {
  const { upstream, gateway } = await startFullChain();
  await generateText({
    model: gateway.languageModel("zai/glm-5.3-flash"),
    headers: { "x-custom-agent-header": "leak-me" },
    prompt: "hello",
  });
  const headers = upstream.recording.requests[0]!.headers;
  const serialized = JSON.stringify(headers);
  expect(serialized).not.toContain(TEST_TOKEN);
  expect(headers["x-custom-agent-header"]).toBeUndefined();
});

test("the config endpoint lists routed models for the real client", async () => {
  const { gateway } = await startFullChain();
  const available = await gateway.getAvailableModels();
  expect(available.models).toEqual([
    {
      id: "zai/glm-5.3-flash",
      name: "GLM 5.3 Flash",
      specification: {
        specificationVersion: "v4",
        provider: "zai",
        modelId: "glm-5.3-flash",
      },
      modelType: "language",
    },
  ]);
});
