/**
 * Model Gateway contract shared by the API, Worker, and Dashboard.
 *
 * A Model Gateway is the OpenAI-compatible gateway Agents' string model IDs
 * resolve through (OpenRouter, LiteLLM, or any OpenAI-compatible endpoint),
 * distinct from Eveland's own Agent Gateway. Eveland delivers only where the
 * gateway is: the key is the project's own `AI_GATEWAY_API_KEY`, the variable
 * eve's built-in Vercel AI Gateway provider already reads, and Eveland never
 * supplies one. The runtime half of the contract -- the provider an Agent
 * process installs -- is the published `eveland/model-gateway` module, which
 * reads the variables named here. The Worker's injection tests bundle that
 * module and drive it with these names, so the two sides cannot drift apart
 * silently.
 *
 * Vercel AI Gateway is not a kind: eve reaches it natively with the same
 * `AI_GATEWAY_API_KEY`, so an instance with no Model Gateway already uses it.
 *
 * Browser-safe: no Node imports.
 */

export const MODEL_GATEWAY_KINDS = ["litellm", "openrouter", "openai-compatible"] as const;

export type ModelGatewayKind = (typeof MODEL_GATEWAY_KINDS)[number];

export function isModelGatewayKind(value: unknown): value is ModelGatewayKind {
  return typeof value === "string" && (MODEL_GATEWAY_KINDS as readonly string[]).includes(value);
}

/**
 * The runtime variables the injected provider reads. `kind` and `url` are
 * reserved and set by the Worker; `key` is the project's own variable.
 */
export const MODEL_GATEWAY_ENV = {
  kind: "EVELAND_MODEL_GATEWAY_KIND",
  url: "EVELAND_MODEL_GATEWAY_URL",
  key: "AI_GATEWAY_API_KEY",
} as const;

/**
 * How a project uses the instance's Model Gateway:
 * - `platform`: string model IDs resolve through it;
 * - `off`: no injection at all, the Agent calls models as authored.
 */
export const PROJECT_MODEL_GATEWAY_MODES = ["platform", "off"] as const;

export type ProjectModelGatewayMode = (typeof PROJECT_MODEL_GATEWAY_MODES)[number];

export function isProjectModelGatewayMode(value: unknown): value is ProjectModelGatewayMode {
  return (
    typeof value === "string" && (PROJECT_MODEL_GATEWAY_MODES as readonly string[]).includes(value)
  );
}

export const DEFAULT_PROJECT_MODEL_GATEWAY_MODE: ProjectModelGatewayMode = "platform";

/** The instance's Model Gateway. It holds no credential. */
export type ModelGateway = {
  kind: ModelGatewayKind;
  baseUrl: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type ProjectModelGateway = {
  projectId: string;
  mode: ProjectModelGatewayMode;
  updatedAt: string | null;
};
