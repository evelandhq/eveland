import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";

export type ProviderConnectionConfig = {
  /** Stable connection id, e.g. "zai" or "deepseek". */
  id: string;
  /** OpenAI-compatible API root, e.g. "https://api.deepseek.com/v1". */
  baseURL: string;
  /** The real provider credential. It exists only on this side of the wire. */
  apiKey: string;
};

export type ModelRouteConfig = {
  /** Canonical model id agents write, e.g. "zai/glm-5.3-flash". */
  modelId: string;
  /** Which provider connection serves this model. */
  connectionId: string;
  /** The model id the provider's own API expects. */
  providerModelId: string;
  displayName?: string;
};

export type ModelListing = {
  id: string;
  name: string;
  specification: { specificationVersion: "v4"; provider: string; modelId: string };
  modelType: "language";
};

export type ModelRegistry = {
  resolveModel: (modelId: string) => LanguageModelV4 | undefined;
  listModels: () => ModelListing[];
};

/**
 * The spike registry: static connections + routes from configuration. The
 * versioned, persisted route registry of the plan replaces this in Phase 2;
 * the contract (resolve + list) stays.
 */
export function createStaticModelRegistry(
  connections: ProviderConnectionConfig[],
  routes: ModelRouteConfig[],
): ModelRegistry {
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
  const routesByModelId = new Map(routes.map((route) => [route.modelId, route]));

  return {
    resolveModel: (modelId) => {
      const route = routesByModelId.get(modelId);
      if (route === undefined) return undefined;
      return providers.get(route.connectionId)?.chatModel(route.providerModelId);
    },
    listModels: () =>
      routes
        .filter((route) => providers.has(route.connectionId))
        .map((route) => ({
          id: route.modelId,
          name: route.displayName ?? route.modelId,
          specification: {
            specificationVersion: "v4" as const,
            provider: route.connectionId,
            modelId: route.providerModelId,
          },
          modelType: "language" as const,
        })),
  };
}
