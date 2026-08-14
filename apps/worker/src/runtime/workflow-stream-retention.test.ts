import { afterEach, describe, expect, test, vi } from "vitest";
import {
  formatWorkflowStreamRetentionSummary,
  runWorkflowStreamRetentionSweeps,
  startWorkflowStreamRetentionScheduler,
} from "./workflow-stream-retention.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("runWorkflowStreamRetentionSweeps", () => {
  test("runs legacy and shared paths independently when one fails", async () => {
    const onSummary = vi.fn();

    await expect(
      runWorkflowStreamRetentionSweeps({
        sweepLegacy: vi.fn(async () => {
          throw new Error("legacy unavailable");
        }),
        sweepShared: vi.fn(async () => ({
          configured: true,
          deletedRows: 9,
          batches: 2,
          hitBatchLimit: true,
          lockAcquired: true,
        })),
        onSummary,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ role: "legacy", status: "error" }),
      expect.objectContaining({
        role: "shared",
        status: "ok",
        deletedRows: 9,
        batches: 2,
        hitBatchLimit: true,
      }),
    ]);

    expect(onSummary).toHaveBeenCalledTimes(2);
    expect(onSummary).toHaveBeenCalledWith(
      expect.objectContaining({ role: "legacy", error: expect.any(Error) }),
    );
  });

  test("treats an advisory-lock miss and an unconfigured shared world as normal skips", async () => {
    const lockMiss = await runWorkflowStreamRetentionSweeps({
      sweepLegacy: vi.fn(async () => 0),
      sweepShared: vi.fn(async () => ({
        configured: true,
        deletedRows: 0,
        batches: 0,
        hitBatchLimit: false,
        lockAcquired: false,
      })),
    });
    const unconfigured = await runWorkflowStreamRetentionSweeps({
      sweepLegacy: vi.fn(async () => 0),
      sweepShared: vi.fn(async () => ({
        configured: false,
        deletedRows: 0,
        batches: 0,
        hitBatchLimit: false,
        lockAcquired: false,
      })),
    });

    expect(lockMiss[1]).toEqual(
      expect.objectContaining({ role: "shared", status: "skipped", skipReason: "lock-held" }),
    );
    expect(unconfigured[1]).toEqual(
      expect.objectContaining({ role: "shared", status: "skipped", skipReason: "unconfigured" }),
    );
    expect(lockMiss[1]).not.toHaveProperty("error");
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
      role: "shared",
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

  test("reports lock skips normally and batch-limit backlog as a warning", () => {
    const lockSkip = formatWorkflowStreamRetentionSummary({
      role: "shared",
      status: "skipped",
      skipReason: "lock-held",
      durationMs: 2,
      deletedRows: 0,
      batches: 0,
      hitBatchLimit: false,
      lockAcquired: false,
    });
    const backlog = formatWorkflowStreamRetentionSummary({
      role: "shared",
      status: "ok",
      durationMs: 40,
      deletedRows: 1_000_000,
      batches: 20,
      hitBatchLimit: true,
      lockAcquired: true,
    });

    expect(lockSkip.level).toBe("info");
    expect(lockSkip.message).toContain("lock-held");
    expect(backlog.level).toBe("warn");
    expect(backlog.message).toContain("batch limit");
  });
});
