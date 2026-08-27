import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ModelListing, ProviderConnectionConfig } from "./registry.js";

/**
 * Spike-only provider wiring: creator-prefix passthrough over the providers
 * that have a key configured ("zai/glm-5.3-flash" → connection "zai", model
 * "glm-5.3-flash"). The plan's curated, versioned route registry replaces
 * this in Phase 2 — passthrough is acceptable for a spike because both target
 * providers use their creator namespace as their own API model ids.
 */
const KNOWN_PROVIDERS: ReadonlyArray<{ id: string; baseURL: string; keyEnvVar: string }> = [
  { id: "zai", baseURL: "https://api.z.ai/api/paas/v4", keyEnvVar: "ZAI_API_KEY" },
  { id: "deepseek", baseURL: "https://api.deepseek.com/v1", keyEnvVar: "DEEPSEEK_API_KEY" },
];

export function spikeConnectionsFromEnv(
  env: Record<string, string | undefined>,
): ProviderConnectionConfig[] {
  return KNOWN_PROVIDERS.flatMap((provider) => {
    const apiKey = env[provider.keyEnvVar];
    if (apiKey === undefined || apiKey.trim() === "") return [];
    return [{ id: provider.id, baseURL: provider.baseURL, apiKey }];
  });
}

export function spikeResolver(connections: ProviderConnectionConfig[]): {
  resolveModel: (modelId: string) => LanguageModelV4 | undefined;
  listModels: () => ModelListing[];
} {
  const providers = new Map(
    connections.map((connection) => [
      connection.id,
      createOpenAICompatible({
        name: connection.id,
        baseURL: connection.baseURL,
        apiKey: connection.apiKey,
        includeUsage: true,
      }),
    ]),
  );
  return {
    resolveModel: (modelId) => {
      const separator = modelId.indexOf("/");
      if (separator <= 0 || separator === modelId.length - 1) return undefined;
      const provider = providers.get(modelId.slice(0, separator));
      return provider?.chatModel(modelId.slice(separator + 1));
    },
    listModels: () => [],
  };
}
