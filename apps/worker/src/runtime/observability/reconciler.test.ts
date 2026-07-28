import { describe, expect, test, vi } from "vitest";
import { createWorkerObservabilityReconciler } from "./reconciler.js";

describe("Worker observability reconciliation", () => {
  test("runs every reconciler even when one fails", async () => {
    const successful = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();
    const reconcile = createWorkerObservabilityReconciler(
      [
        {
          name: "Collector configuration",
          run: vi.fn().mockRejectedValue(new Error("collector unavailable")),
        },
        { name: "Retention", run: successful },
      ],
      { now: () => 1_000, warn },
    );

    await expect(reconcile()).resolves.toBeUndefined();
    expect(successful).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "Collector configuration reconciliation is degraded:",
      expect.objectContaining({ message: "collector unavailable" }),
    );
  });

  test("rate-limits each reconciler independently", async () => {
    let now = 1_000;
    const warn = vi.fn();
    const reconcile = createWorkerObservabilityReconciler(
      [
        {
          name: "Retention",
          run: vi.fn().mockRejectedValue(new Error("retention failed")),
        },
        {
          name: "Destination health",
          run: vi.fn().mockRejectedValue(new Error("probe failed")),
        },
      ],
      { now: () => now, warningIntervalMs: 60_000, warn },
    );

    await reconcile();
    now += 30_000;
    await reconcile();
    now += 30_000;
    await reconcile();

    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "Retention reconciliation is degraded:",
      "Destination health reconciliation is degraded:",
      "Retention reconciliation is degraded:",
      "Destination health reconciliation is degraded:",
    ]);
  });
});
