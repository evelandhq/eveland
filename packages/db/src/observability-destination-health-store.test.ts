import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

describe("external observability destination health store", () => {
  test("keeps one current probe result per destination", async () => {
    const store = createTestStore();
    await store.upsertExternalObservabilityDestinationHealth({
      destinationId: "destination_1",
      status: "degraded",
      checkedAt: "2026-07-23T12:00:00.000Z",
      lastSuccessAt: null,
      lastError: "HTTP 503",
    });
    await store.upsertExternalObservabilityDestinationHealth({
      destinationId: "destination_1",
      status: "healthy",
      checkedAt: "2026-07-23T12:05:00.000Z",
      lastSuccessAt: "2026-07-23T12:05:00.000Z",
      lastError: null,
    });

    await expect(store.listExternalObservabilityDestinationHealth()).resolves.toEqual([
      {
        destinationId: "destination_1",
        status: "healthy",
        checkedAt: "2026-07-23T12:05:00.000Z",
        lastSuccessAt: "2026-07-23T12:05:00.000Z",
        lastError: null,
      },
    ]);
  });
});
