import type {
  ExternalDestinationConfig,
  ObservabilitySignal,
} from "@eveland/core/observability";
import type { Store } from "@eveland/db";
import { DEFAULT_TEAM_ID } from "@eveland/db";
import {
  decryptDestinationConfig,
} from "./process-collector-observability.js";

const probeIntervalMs = 5 * 60 * 1_000;
const probeTimeoutMs = 5_000;

type DestinationHealthStore = Pick<
  Store,
  | "getObservabilityPolicy"
  | "upsertExternalObservabilityDestinationHealth"
>;

export function createExternalDestinationHealthReconciler(input: {
  store: DestinationHealthStore;
  appSecretKey: string;
  now?: () => Date;
  probeDestination?: (config: ExternalDestinationConfig) => Promise<void>;
}): () => Promise<number> {
  const now = input.now ?? (() => new Date());
  const probeDestination =
    input.probeDestination ?? probeExternalDestination;
  let lastRunAt: number | undefined;
  let inFlight: Promise<number> | undefined;

  const reconcile = async (): Promise<number> => {
    const checkedAt = now();
    if (
      lastRunAt !== undefined &&
      checkedAt.getTime() - lastRunAt < probeIntervalMs
    ) {
      return 0;
    }
    const policy = await input.store.getObservabilityPolicy(
      DEFAULT_TEAM_ID,
    );
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
          const config = decryptDestinationConfig(
            destination.encryptedConfig,
            input.appSecretKey,
          );
          if (config.kind !== destination.kind) {
            throw new Error(
              "Encrypted destination kind does not match its policy.",
            );
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
): Promise<void> {
  const requests = probeRequests(config);
  for (const request of requests) {
    const response = await fetch(request.url, {
      method: "POST",
      headers: {
        ...request.headers,
        "content-type": "application/json",
      },
      body: JSON.stringify(emptySignalRequest(request.signal)),
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `Destination probe failed with HTTP ${response.status}.`,
      );
    }
  }
}

function probeRequests(config: ExternalDestinationConfig): Array<{
  signal: ObservabilitySignal;
  url: string;
  headers: Record<string, string>;
}> {
  switch (config.kind) {
    case "elastic":
      return (["traces", "logs", "metrics"] as const).map((signal) => ({
        signal,
        url: signalUrl(config.endpoint, signal),
        headers: {
          authorization: `${
            config.authorization.type === "api_key" ? "ApiKey" : "Bearer"
          } ${config.authorization.value}`,
        },
      }));
    case "langfuse":
      return [
        {
          signal: "traces",
          url: config.tracesEndpoint,
          headers: {
            authorization: `Basic ${Buffer.from(
              `${config.publicKey}:${config.secretKey}`,
            ).toString("base64")}`,
            "x-langfuse-ingestion-version": "4",
          },
        },
      ];
    case "custom_otlp":
      return config.supportedSignals.map((signal) => ({
        signal,
        url: signalUrl(config.endpoint, signal),
        headers: config.headers,
      }));
  }
}

function signalUrl(
  endpoint: string,
  signal: ObservabilitySignal,
): string {
  return `${endpoint.replace(/\/+$/, "")}/v1/${signal}`;
}

function emptySignalRequest(
  signal: ObservabilitySignal,
): Record<string, never[]> {
  const field = {
    traces: "resourceSpans",
    logs: "resourceLogs",
    metrics: "resourceMetrics",
  }[signal];
  return { [field]: [] };
}

function boundedError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error);
  return message.slice(0, 512);
}
