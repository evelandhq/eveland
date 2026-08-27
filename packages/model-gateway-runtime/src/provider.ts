import { createGateway } from "@ai-sdk/gateway";

/**
 * Points the AI SDK's global default provider at the Eveland Model Gateway,
 * so an agent's string model (`model: "zai/glm-5.3-flash"`) resolves through
 * the platform instead of Vercel's AI Gateway. `AI_SDK_DEFAULT_PROVIDER` is
 * the AI SDK's documented extension point for exactly this
 * (`ai`: `globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway`).
 *
 * Fail-closed: with no injected gateway URL this is a no-op and the AI SDK
 * default stands. A missing runtime token is replaced by a sentinel so a
 * misconfigured deployment gets a clean 401 from the model gateway instead of
 * the gateway client silently falling through to Vercel OIDC authentication.
 */
export function installEvelandModelGatewayProvider(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const gatewayUrl = env.EVELAND_MODEL_GATEWAY_URL;
  if (gatewayUrl === undefined || gatewayUrl === "") return false;
  const token = env.AI_GATEWAY_API_KEY;
  (globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }).AI_SDK_DEFAULT_PROVIDER = createGateway({
    baseURL: `${gatewayUrl.replace(/\/$/, "")}/v4/ai`,
    apiKey: token === undefined || token.trim() === "" ? "eveland-missing-runtime-token" : token,
  });
  return true;
}
