import type { ExternalDestinationConfig } from "@eveland/core/observability";
import type { Store } from "@eveland/db";
import { DEFAULT_TEAM_ID } from "@eveland/db";
import {
  decryptDestinationConfig,
  parseObservabilityPrivateHostAllowlist,
  requestExternalObservabilityDestination,
  type ExternalObservabilityRequestInput,
} from "@eveland/core/server/observability";

const probeIntervalMs = 5 * 60 * 1_000;
const probeTimeoutMs = 5_000;

type DestinationHealthStore = Pick<
  Store,
  "getObservabilityPolicy" | "upsertExternalObservabilityDestinationHealth"
>;

export function createExternalDestinationHealthReconciler(input: {
  store: DestinationHealthStore;
  appSecretKey: string;
  now?: () => Date;
  probeDestination?: (config: ExternalDestinationConfig) => Promise<void>;
}): () => Promise<number> {
  const now = input.now ?? (() => new Date());
  const probeDestination = input.probeDestination ?? probeExternalDestination;
  let lastRunAt: number | undefined;
  let inFlight: Promise<number> | undefined;

  const reconcile = async (): Promise<number> => {
    const checkedAt = now();
    if (lastRunAt !== undefined && checkedAt.getTime() - lastRunAt < probeIntervalMs) {
      return 0;
    }
    const policy = await input.store.getObservabilityPolicy(DEFAULT_TEAM_ID);
    await Promise.all(
      policy.externalDestinations.map(async (destination) => {
        const base = {
          destinationId: destination.id,
          checkedAt: checkedAt.toISOString(),
          lastSuccessAt: null,
          lastError: null,
        };
        if (!destination.enabled) {
          await input.store.upsertExternalObservabilityDestinationHealth({
            ...base,
            status: "paused",
          });
          return;
        }

        try {
          const config = decryptDestinationConfig(destination.encryptedConfig, input.appSecretKey);
          if (config.kind !== destination.kind) {
            throw new Error("Encrypted destination kind does not match its policy.");
          }
          await probeDestination(config);
          await input.store.upsertExternalObservabilityDestinationHealth({
            ...base,
            status: "healthy",
            lastSuccessAt: checkedAt.toISOString(),
          });
        } catch (error) {
          await input.store.upsertExternalObservabilityDestinationHealth({
            ...base,
            status: "degraded",
            lastError: boundedError(error),
          });
        }
      }),
    );
    lastRunAt = checkedAt.getTime();
    return policy.externalDestinations.length;
  };

  return () => {
    if (inFlight) return inFlight;
    inFlight = reconcile().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}

export async function probeExternalDestination(
  config: ExternalDestinationConfig,
  requestDestination: (
    input: ExternalObservabilityRequestInput,
  ) => Promise<{ status: number }> = requestExternalObservabilityDestination,
): Promise<void> {
  const signals =
    config.kind === "langfuse"
      ? (["traces"] as const)
      : config.kind === "custom_otlp"
        ? config.supportedSignals
        : (["traces", "logs", "metrics"] as const);
  for (const signal of signals) {
    const response = await requestDestination({
      config,
      signal,
      contentType: "application/json",
      body: new TextEncoder().encode(JSON.stringify(emptySignalRequest(signal))),
      privateHostAllowlist: parseObservabilityPrivateHostAllowlist(
        process.env.EVELAND_OBSERVABILITY_PRIVATE_ENDPOINT_ALLOWLIST,
      ),
      timeoutMs: probeTimeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Destination probe failed with HTTP ${response.status}.`);
    }
  }
}

function emptySignalRequest(signal: "traces" | "logs" | "metrics"): Record<string, never[]> {
  const field = {
    traces: "resourceSpans",
    logs: "resourceLogs",
    metrics: "resourceMetrics",
  }[signal];
  return { [field]: [] };
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 512);
}
