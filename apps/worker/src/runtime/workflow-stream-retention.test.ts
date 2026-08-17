import { afterEach, describe, expect, test, vi } from "vitest";
import {
  formatWorkflowStreamRetentionSummary,
  runWorkflowStreamRetentionSweep,
  startWorkflowStreamRetentionScheduler,
} from "./workflow-stream-retention.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("runWorkflowStreamRetentionSweep", () => {
  test("reports a legacy retention failure without rejecting the scheduler", async () => {
    const onSummary = vi.fn();

    await expect(
      runWorkflowStreamRetentionSweep({
        sweepLegacy: vi.fn(async () => {
          throw new Error("legacy unavailable");
        }),
        onSummary,
      }),
    ).resolves.toEqual(expect.objectContaining({ role: "legacy", status: "error" }));

    expect(onSummary).toHaveBeenCalledTimes(1);
    expect(onSummary).toHaveBeenCalledWith(
      expect.objectContaining({ role: "legacy", error: expect.any(Error) }),
    );
  });
});

describe("startWorkflowStreamRetentionScheduler", () => {
  test("runs at startup and on the interval, then clears the timer and closes resources", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const scheduler = startWorkflowStreamRetentionScheduler({ intervalMs: 1_000, run, close });

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);

    await scheduler.close();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("does not start when the configured interval is disabled", async () => {
    const run = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const scheduler = startWorkflowStreamRetentionScheduler({ intervalMs: 0, run, close });

    expect(run).not.toHaveBeenCalled();
    await scheduler.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("formatWorkflowStreamRetentionSummary", () => {
  test("redacts database URLs from failures", () => {
    const formatted = formatWorkflowStreamRetentionSummary({
      role: "legacy",
      status: "error",
      durationMs: 12,
      deletedRows: 0,
      error: new Error(
        "connection postgres://world:top-secret@db.internal:5432/workflow?sslmode=require failed",
      ),
    });

    expect(formatted.level).toBe("error");
    expect(formatted.message).toContain("[redacted database URL]");
    expect(formatted.message).not.toContain("top-secret");
    expect(JSON.stringify(formatted.attributes)).not.toContain("db.internal");
  });
});
