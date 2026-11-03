import { createOpenAICompatible, type MetadataExtractor } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4, ProviderV4, SharedV4ProviderMetadata } from "@ai-sdk/provider";

/**
 * Eveland Model Gateway: the default AI SDK provider for string model IDs.
 *
 * Eve resolves a string model as
 * `(globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway).languageModel(id)`, so an
 * Agent that writes `model: "anthropic/claude-sonnet-4.5"` reaches whatever
 * provider sits in that global by its first model call. Eveland injects this
 * module into every eve 1.0 Release and delivers the gateway's kind and
 * address through reserved runtime variables; an Agent can import the same
 * module from its own instrumentation to get identical behavior under
 * `eve dev`.
 *
 * Contract:
 * - With no `EVELAND_MODEL_GATEWAY_KIND`, nothing happens.
 * - The key is the project's own `AI_GATEWAY_API_KEY`, the variable eve's
 *   built-in AI Gateway provider reads, so it means "the key for the gateway
 *   this project's models go through" either way. Eveland never supplies a
 *   key: without one the provider is still installed and the call fails at
 *   the configured gateway, not somewhere else.
 * - A provider the Agent installed itself is never replaced.
 * - Model IDs are forwarded verbatim; aliases live on the gateway.
 * - A gateway-reported USD cost is recorded at `providerMetadata.gateway.cost`,
 *   the only place eve reads cost from. A gateway that reports none leaves
 *   cost missing; nothing here estimates it.
 *
 * The Worker bundles this file into Releases, so it must stay free of any
 * dependency on `eve` or on an Eveland workspace package.
 */

export const MODEL_GATEWAY_KINDS = ["litellm", "openrouter", "openai-compatible"] as const;

export type ModelGatewayKind = (typeof MODEL_GATEWAY_KINDS)[number];

export const MODEL_GATEWAY_ENV = {
  kind: "EVELAND_MODEL_GATEWAY_KIND",
  url: "EVELAND_MODEL_GATEWAY_URL",
  key: "AI_GATEWAY_API_KEY",
} as const;

export type ModelGatewayConfig = {
  readonly kind: ModelGatewayKind;
  readonly baseURL: string;
  readonly apiKey: string | undefined;
};

export type ModelGatewayInstallResult =
  | { readonly status: "not-configured" }
  | { readonly status: "kept-existing" }
  | { readonly status: "installed"; readonly kind: ModelGatewayKind };

const DEFAULT_PROVIDER_GLOBAL = "AI_SDK_DEFAULT_PROVIDER";

type Environment = Readonly<Record<string, string | undefined>>;

function isModelGatewayKind(value: string): value is ModelGatewayKind {
  return (MODEL_GATEWAY_KINDS as readonly string[]).includes(value);
}

/**
 * Reads the Model Gateway configuration from the environment. Returns
 * undefined when none is configured and throws on an invalid one: a
 * misconfigured gateway must stop startup loudly rather than send model
 * traffic somewhere unintended. A missing key is not invalid; it is the
 * project's to set. Error messages name variables, never their values.
 */
export function readModelGatewayConfig(
  env: Environment = process.env,
): ModelGatewayConfig | undefined {
  const kind = env[MODEL_GATEWAY_ENV.kind]?.trim();
  if (!kind) return undefined;
  if (!isModelGatewayKind(kind)) {
    throw new Error(
      `Eveland: unsupported Model Gateway kind "${kind}" in ${MODEL_GATEWAY_ENV.kind}; expected one of ${MODEL_GATEWAY_KINDS.join(", ")}.`,
    );
  }
  const baseURL = env[MODEL_GATEWAY_ENV.url]?.trim();
  if (!baseURL || !isHttpUrl(baseURL)) {
    throw new Error(
      `Eveland: the ${kind} Model Gateway needs an http(s) base URL in ${MODEL_GATEWAY_ENV.url}.`,
    );
  }
  const apiKey = env[MODEL_GATEWAY_ENV.key]?.trim() || undefined;
  return { kind, baseURL: trimTrailingSlashes(baseURL), apiKey };
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Builds the provider for a Model Gateway configuration. */
export function createModelGatewayProvider(config: ModelGatewayConfig): ProviderV4 {
  const reportsCost = config.kind === "litellm" || config.kind === "openrouter";
  const provider = createOpenAICompatible({
    name: config.kind,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    // Without this, @ai-sdk/openai-compatible omits stream_options and a
    // streamed call reports no token usage at all.
    includeUsage: true,
    ...(reportsCost ? { metadataExtractor: usageCostExtractor } : {}),
  });
  if (config.kind !== "litellm") return provider;

  return {
    specificationVersion: "v4",
    languageModel: (modelId) => withLiteLlmResponseCostHeader(provider.languageModel(modelId)),
    embeddingModel: (modelId) => provider.embeddingModel(modelId),
    imageModel: (modelId) => provider.imageModel(modelId),
  };
}

/**
 * Installs the Model Gateway provider as the AI SDK default, unless none is
 * configured or the Agent already installed its own.
 */
export function installModelGateway(
  options: { env?: Environment; target?: object } = {},
): ModelGatewayInstallResult {
  const config = readModelGatewayConfig(options.env ?? process.env);
  if (config === undefined) return { status: "not-configured" };
  const target = options.target ?? globalThis;
  if (Reflect.get(target, DEFAULT_PROVIDER_GLOBAL) != null) return { status: "kept-existing" };
  Reflect.set(target, DEFAULT_PROVIDER_GLOBAL, createModelGatewayProvider(config));
  return { status: "installed", kind: config.kind };
}

function readUsageCost(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const usage = (body as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  return finiteCost((usage as { cost?: unknown }).cost);
}

function finiteCost(value: unknown): number | undefined {
  const cost = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

function gatewayCostMetadata(cost: number | undefined): SharedV4ProviderMetadata | undefined {
  return cost === undefined ? undefined : { gateway: { cost } };
}

/**
 * OpenRouter and LiteLLM report the request's USD cost as `usage.cost`: in
 * the body of a complete response, and in the final chunk of a stream that
 * asked for usage.
 */
const usageCostExtractor: MetadataExtractor = {
  extractMetadata: async ({ parsedBody }) => gatewayCostMetadata(readUsageCost(parsedBody)),
  createStreamExtractor: () => {
    let cost: number | undefined;
    return {
      processChunk(parsedChunk) {
        cost = readUsageCost(parsedChunk) ?? cost;
      },
      buildMetadata: () => gatewayCostMetadata(cost),
    };
  },
};

/**
 * LiteLLM also reports cost in the `x-litellm-response-cost` header. Only a
 * complete response can use it: a stream sends its headers before usage
 * exists, so a streamed call relies on `usage.cost` alone.
 */
function withLiteLlmResponseCostHeader(model: LanguageModelV4): LanguageModelV4 {
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    get supportedUrls() {
      return model.supportedUrls;
    },
    doStream: (options) => model.doStream(options),
    doGenerate: async (options) => {
      const result = await model.doGenerate(options);
      if (result.providerMetadata?.gateway !== undefined) return result;
      const cost = finiteCost(result.response?.headers?.["x-litellm-response-cost"]);
      if (cost === undefined) return result;
      return {
        ...result,
        providerMetadata: { ...result.providerMetadata, gateway: { cost } },
      };
    },
  };
}

/** Drops trailing slashes without a regex (`/\/+$/` backtracks polynomially). */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}
