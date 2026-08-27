import { streamText } from "ai";
import { afterEach, expect, test, vi } from "vitest";
import {
  registerModelGatewayTestCleanup,
  startModelGateway,
  startOpenAiCompatibleUpstream,
  TEST_TOKEN,
} from "./app.test-support.js";
import { createStaticModelRegistry } from "./registry.js";

registerModelGatewayTestCleanup();

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }).AI_SDK_DEFAULT_PROVIDER;
});

/**
 * The whole point of the feature, end to end: agent code writes only
 * `model: "zai/glm-5.3-flash"` (a bare string, exactly what eve passes
 * through to the AI SDK), the platform injects EVELAND_MODEL_GATEWAY_URL +
 * AI_GATEWAY_API_KEY and the preload, and the call lands on the BYOK provider
 * behind the eveland model gateway — never on Vercel.
 */
test("a bare string model resolves through the preload to the eveland model gateway", async () => {
  const upstream = await startOpenAiCompatibleUpstream();
  const registry = createStaticModelRegistry(
    [{ id: "zai", baseURL: `${upstream.origin}/v1`, apiKey: "sk-live-zai" }],
    [{ modelId: "zai/glm-5.3-flash", connectionId: "zai", providerModelId: "glm-5.3-flash" }],
  );
  const { origin } = await startModelGateway({
    authenticate: (token) => token === TEST_TOKEN,
    resolveModel: (modelId) => registry.resolveModel(modelId),
  });

  vi.stubEnv("EVELAND_MODEL_GATEWAY_URL", origin);
  vi.stubEnv("AI_GATEWAY_API_KEY", TEST_TOKEN);
  vi.resetModules();
  await import("@evelandhq/model-gateway-runtime/register");

  const result = streamText({ model: "zai/glm-5.3-flash", prompt: "hello" });

  expect(await result.text).toBe("upstream stream");
  expect(upstream.recording.requests).toHaveLength(1);
  expect(upstream.recording.requests[0]!.headers.authorization).toBe("Bearer sk-live-zai");
});
