import { describe, expect, test, vi } from "vitest";
import {
  createObservabilityRetentionReconciler,
} from "./process-observability-retention.js";

describe("Built-in observability retention", () => {
  test("applies receipt, Session, and capacity windows at a bounded cadence", async () => {
    const pruneOtlpTelemetry = vi.fn().mockResolvedValue({ receipts: 3 });
    const pruneDerivedAgentTelemetry = vi.fn().mockResolvedValue({
      sessions: 4,
      events: 5,
      usageEvents: 6,
      nodes: 7,
    });
    const pruneHostMetrics = vi.fn().mockResolvedValue(8);
    let now = new Date("2026-07-23T12:00:00.000Z");
    const reconcile = createObservabilityRetentionReconciler({
      store: {
        pruneOtlpTelemetry,
        pruneDerivedAgentTelemetry,
        pruneHostMetrics,
      },
      now: () => now,
    });

    await expect(reconcile()).resolves.toBe(33);
    await expect(reconcile()).resolves.toBe(0);
    // Receipts expire on a retry-window horizon, not the read-model one.
    expect(pruneOtlpTelemetry).toHaveBeenCalledWith({
      receiptsBefore: new Date("2026-07-22T12:00:00.000Z"),
    });
    expect(pruneDerivedAgentTelemetry).toHaveBeenCalledWith(
      new Date("2026-04-24T12:00:00.000Z"),
    );
    expect(pruneHostMetrics).toHaveBeenCalledWith(
      new Date("2026-06-23T12:00:00.000Z"),
    );

    now = new Date("2026-07-24T12:00:00.000Z");
    await expect(reconcile()).resolves.toBe(33);
    expect(pruneOtlpTelemetry).toHaveBeenCalledTimes(2);
  });
});
