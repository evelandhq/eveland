/**
 * Model Gateway contract shared by the API, Worker, and Dashboard.
 *
 * A Model Gateway is the gateway Agents' string model IDs resolve through
 * (LiteLLM, OpenRouter, Vercel AI Gateway, or any OpenAI-compatible
 * endpoint), distinct from Eveland's own Agent Gateway. Eveland delivers only where the
 * gateway is: the key is the project's own `AI_GATEWAY_API_KEY`, the variable
 * eve's built-in Vercel AI Gateway provider already reads, and Eveland never
 * supplies one. The runtime half of the contract -- the provider an Agent
 * process installs -- is the published `eveland/model-gateway` module, which
 * reads the variables named here. The Worker's injection tests bundle that
 * module and drive it with these names, so the two sides cannot drift apart
 * silently.
 *
 * The `vercel` kind is eve's own Vercel AI Gateway provider. Keeping it a kind
 * means moving between Vercel and another gateway changes only the kind,
 * never a project's variables.
 *
 * Browser-safe: no Node imports.
 */

export const MODEL_GATEWAY_KINDS = [
  "litellm",
  "openrouter",
  "vercel",
  "openai-compatible",
] as const;

export type ModelGatewayKind = (typeof MODEL_GATEWAY_KINDS)[number];

export function isModelGatewayKind(value: unknown): value is ModelGatewayKind {
  return typeof value === "string" && (MODEL_GATEWAY_KINDS as readonly string[]).includes(value);
}

/** Kinds that take a base URL. Vercel AI Gateway's address is fixed by Vercel. */
export function modelGatewayNeedsBaseUrl(kind: ModelGatewayKind): boolean {
  return kind !== "vercel";
}

export const VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

/** Where a gateway lists its models: its base URL, or Vercel AI Gateway's fixed one. */
export function modelGatewayModelsBaseUrl(gateway: {
  kind: ModelGatewayKind;
  baseUrl: string | null;
}): string {
  return gateway.kind === "vercel" ? VERCEL_AI_GATEWAY_BASE_URL : (gateway.baseUrl ?? "");
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
  /** Null for `vercel`, whose address is fixed. */
  baseUrl: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type ProjectModelGateway = {
  projectId: string;
  mode: ProjectModelGatewayMode;
  updatedAt: string | null;
};

/**
 * A live Deployment that is set to use the Model Gateway but whose Release
 * has no injected provider -- built before the provider existed -- so it
 * still calls models as authored. A restart reuses that same Release; only a
 * redeploy applies the gateway.
 */
export type ModelGatewayRebuildRequired = {
  projectId: string;
  projectName: string;
  deploymentId: string;
  deploymentKey: string;
};
