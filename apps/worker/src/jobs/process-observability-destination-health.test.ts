import {
  createDefaultObservabilityPolicy,
  type ExternalDestinationConfig,
  type ObservabilityPolicy,
} from "@evelandhq/core/observability";
import { encryptSecretValue } from "@evelandhq/core/server/secrets";
import { describe, expect, test, vi } from "vitest";
import {
  createExternalDestinationHealthReconciler,
  probeExternalDestination,
} from "./process-observability-destination-health.js";

const appSecretKey = "eveland-dev-secret-key-000000000";

describe("external observability destination health", () => {
  test("derives the Langfuse traces endpoint from its base URL", async () => {
    const requestDestination = vi.fn().mockResolvedValue({
      status: 200,
    });

    await probeExternalDestination(
      {
        kind: "langfuse",
        baseUrl: "https://us.cloud.langfuse.com",
        publicKey: "pk-lf",
        secretKey: "sk-lf",
      },
      requestDestination,
    );

    expect(requestDestination).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          kind: "langfuse",
          baseUrl: "https://us.cloud.langfuse.com",
        }),
        signal: "traces",
        contentType: "application/json",
      }),
    );
  });

  test("probes enabled destinations independently and marks paused destinations without network access", async () => {
    const policy: ObservabilityPolicy = {
      ...createDefaultObservabilityPolicy(3),
      externalDestinations: [
        {
          id: "destination_elastic",
          kind: "elastic",
          enabled: true,
          securityRevision: 1,
          encryptedConfig: encrypted({
            kind: "elastic",
            endpoint: "https://elastic.example.com:4318",
            authorization: { type: "api_key", value: "secret" },
          }),
          supportedSignals: ["traces", "logs", "metrics"],
          filterProfile: "all_eveland",
        },
        {
          id: "destination_langfuse",
          kind: "langfuse",
          enabled: true,
          securityRevision: 1,
          encryptedConfig: encrypted({
            kind: "langfuse",
            baseUrl: "https://langfuse.example.com",
            publicKey: "pk-lf",
            secretKey: "sk-lf",
          }),
          supportedSignals: ["traces"],
          filterProfile: "agent_genai",
        },
        {
          id: "destination_paused",
          kind: "custom_otlp",
          enabled: false,
          securityRevision: 1,
          encryptedConfig: encrypted({
            kind: "custom_otlp",
            endpoint: "https://paused.example.com",
            supportedSignals: ["logs"],
            domains: ["runtime"],
            headers: {},
          }),
          supportedSignals: ["logs"],
          domains: ["runtime"],
          filterProfile: "custom",
        },
      ],
    };
    const upsert = vi.fn().mockImplementation(async (health) => health);
    const probe = vi.fn(async (config: ExternalDestinationConfig) => {
      if (config.kind === "langfuse") {
        throw new Error("HTTP 401");
      }
    });
    let now = new Date("2026-07-23T12:00:00.000Z");
    const reconcile = createExternalDestinationHealthReconciler({
      store: {
        getObservabilityPolicy: vi.fn().mockResolvedValue(policy),
        upsertExternalObservabilityDestinationHealth: upsert,
      },
      appSecretKey,
      now: () => now,
      probeDestination: probe,
    });

    await expect(reconcile()).resolves.toBe(3);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledWith({
      destinationId: "destination_elastic",
      status: "healthy",
      checkedAt: "2026-07-23T12:00:00.000Z",
      lastSuccessAt: "2026-07-23T12:00:00.000Z",
      lastError: null,
    });
    expect(upsert).toHaveBeenCalledWith({
      destinationId: "destination_langfuse",
      status: "degraded",
      checkedAt: "2026-07-23T12:00:00.000Z",
      lastSuccessAt: null,
      lastError: "HTTP 401",
    });
    expect(upsert).toHaveBeenCalledWith({
      destinationId: "destination_paused",
      status: "paused",
      checkedAt: "2026-07-23T12:00:00.000Z",
      lastSuccessAt: null,
      lastError: null,
    });

    await expect(reconcile()).resolves.toBe(0);
    now = new Date("2026-07-23T12:05:00.000Z");
    await expect(reconcile()).resolves.toBe(3);
  });
});

function encrypted(config: ExternalDestinationConfig): string {
  return JSON.stringify(encryptSecretValue(JSON.stringify(config), appSecretKey));
}
