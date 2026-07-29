import { createId } from "@eveland/core/ids";
import {
  mergeExternalDestinationConfig,
  toPublicExternalDestinationConfig,
  toPublicObservabilityPolicy,
  type ExternalDestinationConfig,
  type ExternalDestinationConfigPatch,
  type ExternalObservabilityDestination,
  type ObservabilityPolicy,
  type PublicExternalDestinationConfig,
} from "@eveland/core/observability";
import {
  decryptDestinationConfig,
  encryptDestinationConfig,
  parseObservabilityPrivateHostAllowlist,
  validateExternalObservabilityDestination,
} from "@eveland/core/server/observability";
import { DEFAULT_TEAM_ID, type Store } from "@eveland/db";
import type { AppOptions } from "../app-types.js";

export function createObservabilityPolicyService(input: {
  store: Store;
  options: AppOptions;
  appSecretKey: string;
}) {
  const { store, options, appSecretKey } = input;

  async function resolveDestinationConfig(
    patch: ExternalDestinationConfigPatch,
    existing?: ExternalObservabilityDestination,
  ): Promise<ExternalDestinationConfig> {
    const config = mergeExternalDestinationConfig(
      patch,
      existing ? readDestinationConfig(existing) : null,
    );
    if (options.validateObservabilityDestination) {
      await options.validateObservabilityDestination(config);
    } else {
      await validateExternalObservabilityDestination(config, {
        privateHostAllowlist: parseObservabilityPrivateHostAllowlist(
          process.env.EVELAND_OBSERVABILITY_PRIVATE_ENDPOINT_ALLOWLIST,
        ),
      });
    }
    return config;
  }

  function createDestination(
    config: ExternalDestinationConfig,
    existing: {
      id: string;
      enabled: boolean;
      securityRevision: number;
    } = {
      id: createId("destination"),
      enabled: true,
      securityRevision: 1,
    },
  ): ExternalObservabilityDestination {
    const common = {
      ...existing,
      encryptedConfig: encryptDestinationConfig(config, appSecretKey),
    };
    switch (config.kind) {
      case "elastic":
        return {
          ...common,
          kind: "elastic",
          supportedSignals: ["traces", "logs", "metrics"],
          filterProfile: "all_eveland",
        };
      case "langfuse":
        return {
          ...common,
          kind: "langfuse",
          supportedSignals: ["traces"],
          filterProfile: "agent_genai",
        };
      case "custom_otlp":
        return {
          ...common,
          kind: "custom_otlp",
          supportedSignals: config.supportedSignals,
          domains: config.domains,
          filterProfile: "custom",
        };
    }
  }

  async function saveDestinations(
    current: ObservabilityPolicy,
    expectedRevision: number,
    externalDestinations: ExternalObservabilityDestination[],
  ) {
    return store.saveObservabilityPolicy({
      teamId: DEFAULT_TEAM_ID,
      expectedRevision,
      agentCapture: current.agentCapture,
      externalDestinations,
    });
  }

  async function markDestinationProbePending(
    destinationId: string,
    enabled: boolean,
  ): Promise<void> {
    await store.upsertExternalObservabilityDestinationHealth({
      destinationId,
      status: enabled ? "pending" : "paused",
      checkedAt: null,
      lastSuccessAt: null,
      lastError: null,
    });
  }

  function readDestinationConfig(
    destination: ExternalObservabilityDestination,
  ): ExternalDestinationConfig | null {
    try {
      return decryptDestinationConfig(
        destination.encryptedConfig,
        appSecretKey,
      );
    } catch {
      return null;
    }
  }

  async function getPublicPolicy(policy?: ObservabilityPolicy) {
    const resolvedPolicy =
      policy ?? (await store.getObservabilityPolicy(DEFAULT_TEAM_ID));
    const destinationHealth =
      await store.listExternalObservabilityDestinationHealth();
    const destinationConfigs = new Map<
      string,
      PublicExternalDestinationConfig
    >();
    for (const destination of resolvedPolicy.externalDestinations) {
      const config = readDestinationConfig(destination);
      if (config) {
        destinationConfigs.set(
          destination.id,
          toPublicExternalDestinationConfig(config),
        );
      }
    }
    return toPublicObservabilityPolicy(resolvedPolicy, {
      destinationHealth,
      destinationConfigs,
    });
  }

  return {
    createDestination,
    getPublicPolicy,
    markDestinationProbePending,
    resolveDestinationConfig,
    saveDestinations,
  };
}
