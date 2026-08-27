import { createGateway } from "@ai-sdk/gateway";

/**
 * Deployment preload (`NODE_OPTIONS=--import ...`): points the AI SDK's
 * global default provider at the Eveland Model Gateway, so an agent's string
 * model (`model: "zai/glm-5.3-flash"`) resolves through the platform instead
 * of Vercel's AI Gateway. `AI_SDK_DEFAULT_PROVIDER` is the AI SDK's documented
 * extension point for exactly this (`ai`: `globalThis.AI_SDK_DEFAULT_PROVIDER
 * ?? gateway`).
 *
 * Fail-closed: with no injected gateway URL this module does nothing. A
 * missing runtime token is replaced by a sentinel so a misconfigured
 * deployment gets a clean 401 from the model gateway instead of the gateway
 * client silently falling through to Vercel OIDC authentication.
 */
const gatewayUrl = process.env.EVELAND_MODEL_GATEWAY_URL;

if (gatewayUrl !== undefined && gatewayUrl !== "") {
  const token = process.env.AI_GATEWAY_API_KEY;
  (globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }).AI_SDK_DEFAULT_PROVIDER = createGateway({
    baseURL: `${gatewayUrl.replace(/\/$/, "")}/v4/ai`,
    apiKey: token === undefined || token.trim() === "" ? "eveland-missing-runtime-token" : token,
  });
}
