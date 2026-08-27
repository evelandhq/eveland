import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { decryptSecretValue, type EncryptedSecret } from "@evelandhq/core/server/secrets";
import type {
  ModelGatewayModelRouteRecord,
  ModelGatewayProviderConnectionRecord,
} from "@evelandhq/db";
import type { ModelListing } from "./registry.js";

/** Narrow persistence port of the registry loader. */
export type ModelGatewayRegistryRepository = {
  listModelGatewayProviderConnections(): Promise<ModelGatewayProviderConnectionRecord[]>;
  listModelGatewayModelRoutes(): Promise<ModelGatewayModelRouteRecord[]>;
};

export type StoreBackedModelRegistry = {
  resolveModel: (modelId: string) => Promise<LanguageModelV4 | undefined>;
  listModels: () => Promise<ModelListing[]>;
  refresh: () => Promise<void>;
};

type LoadedRegistry = {
  models: Map<string, LanguageModelV4>;
  listings: ModelListing[];
};

/**
 * The registry the data plane serves from: provider connections + the
 * Eveland-owned route table, loaded from the Store and refreshed on a TTL.
 * Provider credentials are decrypted with the dedicated
 * EVELAND_MODEL_GATEWAY_SECRET_KEY at load time and live only inside the
 * provider clients; a connection whose credential cannot be decrypted fails
 * closed (its models resolve to nothing) without taking down the rest.
 */
export function createStoreBackedModelRegistry(input: {
  store: ModelGatewayRegistryRepository;
  secretKey: string;
  refreshIntervalMs?: number;
  now?: () => number;
}): StoreBackedModelRegistry {
  const refreshIntervalMs = input.refreshIntervalMs ?? 15_000;
  const now = input.now ?? Date.now;
  let loaded: LoadedRegistry | null = null;
  let loadedAt = 0;
  let inflight: Promise<LoadedRegistry> | null = null;

  async function load(): Promise<LoadedRegistry> {
    const [connections, routes] = await Promise.all([
      input.store.listModelGatewayProviderConnections(),
      input.store.listModelGatewayModelRoutes(),
    ]);
    const providers = new Map<string, ReturnType<typeof createOpenAICompatible>>();
    for (const connection of connections) {
      const apiKey = decryptConnectionKey(connection, input.secretKey);
      if (apiKey === null) continue;
      providers.set(
        connection.providerId,
        createOpenAICompatible({
          name: connection.providerId,
          baseURL: connection.baseUrl,
          apiKey,
          includeUsage: true,
        }),
      );
    }
    const models = new Map<string, LanguageModelV4>();
    const listings: ModelListing[] = [];
    for (const route of routes) {
      const provider = providers.get(route.providerId);
      if (provider === undefined) continue;
      models.set(route.modelId, provider.chatModel(route.providerModelId));
      listings.push({
        id: route.modelId,
        name: route.displayName ?? route.modelId,
        specification: {
          specificationVersion: "v4",
          provider: route.providerId,
          modelId: route.providerModelId,
        },
        modelType: "language",
      });
    }
    return { models, listings };
  }

  async function current(): Promise<LoadedRegistry> {
    if (loaded !== null && now() - loadedAt < refreshIntervalMs) return loaded;
    inflight ??= load()
      .then((next) => {
        loaded = next;
        loadedAt = now();
        return next;
      })
      .finally(() => {
        inflight = null;
      });
    // A refresh failure serves the last-known-good registry when one exists.
    return inflight.catch((error) => {
      if (loaded !== null) return loaded;
      throw error;
    });
  }

  return {
    resolveModel: async (modelId) => (await current()).models.get(modelId),
    listModels: async () => (await current()).listings,
    refresh: async () => {
      loadedAt = 0;
      loaded = null;
      await current();
    },
  };
}

function decryptConnectionKey(
  connection: ModelGatewayProviderConnectionRecord,
  secretKey: string,
): string | null {
  try {
    return decryptSecretValue(JSON.parse(connection.encryptedApiKey) as EncryptedSecret, secretKey);
  } catch {
    return null;
  }
}
