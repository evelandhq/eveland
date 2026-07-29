import { describe, expect, test } from "vitest";
import {
  destinationPatch,
  draftFromDestination,
  emptyDestinationDraft,
} from "./destination-draft";

describe("observability destination drafts", () => {
  test("omits blank stored credentials from update patches", () => {
    expect(
      destinationPatch({
        ...emptyDestinationDraft(),
        kind: "langfuse",
        endpoint: "https://us.cloud.langfuse.com",
        publicKey: "",
        secretKey: "",
      }),
    ).toEqual({
      kind: "langfuse",
      baseUrl: "https://us.cloud.langfuse.com",
    });
  });

  test("requires a signal and domain for custom OTLP", () => {
    expect(() =>
      destinationPatch({
        ...emptyDestinationDraft(),
        kind: "custom_otlp",
        signals: { traces: false, logs: false, metrics: false },
      }),
    ).toThrow("Select at least one signal and one telemetry domain.");
  });

  test("builds an edit draft without returning stored secrets", () => {
    expect(
      draftFromDestination({
        id: "destination_1",
        kind: "custom_otlp",
        enabled: true,
        supportedSignals: ["traces"],
        domains: ["agent"],
        filterProfile: "custom",
        securityRevision: 1,
        config: {
          kind: "custom_otlp",
          endpoint: "https://collector.example.com",
          headerNames: ["authorization"],
        },
        health: {
          destinationId: "destination_1",
          status: "healthy",
          checkedAt: null,
          lastSuccessAt: null,
          lastError: null,
        },
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "custom_otlp",
        endpoint: "https://collector.example.com",
        headers: "",
        signals: { traces: true, logs: false, metrics: false },
        domains: {
          agent: true,
          platform: false,
          runtime: false,
          capacity: false,
        },
      }),
    );
  });
});
