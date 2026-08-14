import type { SharedWorkflowWorldSweepResult } from "./shared-workflow-world-reaper.js";

type SweepStatus = "ok" | "skipped" | "error";

export type WorkflowStreamRetentionSummary = {
  role: "legacy" | "shared";
  status: SweepStatus;
  durationMs: number;
  deletedRows: number;
  batches?: number;
  hitBatchLimit?: boolean;
  lockAcquired?: boolean;
  skipReason?: "lock-held" | "unconfigured";
  error?: unknown;
};

export async function runWorkflowStreamRetentionSweeps(input: {
  sweepLegacy: () => Promise<number>;
  sweepShared: () => Promise<SharedWorkflowWorldSweepResult>;
  onSummary?: (summary: WorkflowStreamRetentionSummary) => void;
}): Promise<[WorkflowStreamRetentionSummary, WorkflowStreamRetentionSummary]> {
  const summaries = await Promise.all([
    captureLegacySweep(input.sweepLegacy),
    captureSharedSweep(input.sweepShared),
  ]);
  for (const summary of summaries) input.onSummary?.(summary);
  return summaries;
}

async function captureLegacySweep(
  sweep: () => Promise<number>,
): Promise<WorkflowStreamRetentionSummary> {
  const startedAt = Date.now();
  try {
    const deletedRows = await sweep();
    return {
      role: "legacy",
      status: "ok",
      durationMs: Date.now() - startedAt,
      deletedRows,
    };
  } catch (error) {
    return {
      role: "legacy",
      status: "error",
      durationMs: Date.now() - startedAt,
      deletedRows: 0,
      error,
    };
  }
}

async function captureSharedSweep(
  sweep: () => Promise<SharedWorkflowWorldSweepResult>,
): Promise<WorkflowStreamRetentionSummary> {
  const startedAt = Date.now();
  try {
    const result = await sweep();
    const skipReason = !result.configured
      ? "unconfigured"
      : !result.lockAcquired
        ? "lock-held"
        : undefined;
    return {
      role: "shared",
      status: skipReason ? "skipped" : "ok",
      durationMs: Date.now() - startedAt,
      deletedRows: result.deletedRows,
      batches: result.batches,
      hitBatchLimit: result.hitBatchLimit,
      lockAcquired: result.lockAcquired,
      ...(skipReason ? { skipReason } : {}),
    };
  } catch (error) {
    return {
      role: "shared",
      status: "error",
      durationMs: Date.now() - startedAt,
      deletedRows: 0,
      error,
    };
  }
}

export function startWorkflowStreamRetentionScheduler(input: {
  intervalMs: number;
  run: () => Promise<void>;
  close: () => Promise<void>;
  onError?: (error: unknown) => void;
}): { close(): Promise<void> } {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  const trigger = () => {
    if (running) return;
    const current = input.run().catch((error) => input.onError?.(error));
    running = current;
    void current.finally(() => {
      if (running === current) running = undefined;
    });
  };

  if (Number.isFinite(input.intervalMs) && input.intervalMs > 0) {
    trigger();
    timer = setInterval(trigger, input.intervalMs);
  }

  return {
    close() {
      closePromise ??= (async () => {
        if (timer) clearInterval(timer);
        await running;
        await input.close();
      })();
      return closePromise;
    },
  };
}

export function formatWorkflowStreamRetentionSummary(summary: WorkflowStreamRetentionSummary): {
  level: "info" | "warn" | "error";
  message: string;
  attributes: Record<string, string | number | boolean>;
} {
  const attributes: Record<string, string | number | boolean> = {
    "eveland.workflow_retention.role": summary.role,
    "eveland.workflow_retention.status": summary.status,
    "eveland.workflow_retention.duration_ms": summary.durationMs,
    "eveland.workflow_retention.deleted_rows": summary.deletedRows,
  };
  if (summary.batches !== undefined) {
    attributes["eveland.workflow_retention.batches"] = summary.batches;
  }
  if (summary.hitBatchLimit !== undefined) {
    attributes["eveland.workflow_retention.hit_batch_limit"] = summary.hitBatchLimit;
  }
  if (summary.lockAcquired !== undefined) {
    attributes["eveland.workflow_retention.lock_acquired"] = summary.lockAcquired;
  }
  if (summary.skipReason) {
    attributes["eveland.workflow_retention.skip_reason"] = summary.skipReason;
  }

  if (summary.status === "error") {
    const error = summary.error;
    attributes["error.type"] = error instanceof Error ? error.name : "UnknownError";
    const detail = redactDatabaseUrls(error instanceof Error ? error.message : String(error));
    return {
      level: "error",
      message: `Workflow stream retention (${summary.role}) failed after ${String(summary.durationMs)}ms: ${detail}`,
      attributes,
    };
  }
  if (summary.skipReason) {
    return {
      level: "info",
      message: `Workflow stream retention (${summary.role}) skipped: ${summary.skipReason}.`,
      attributes,
    };
  }
  if (summary.hitBatchLimit) {
    return {
      level: "warn",
      message: `Workflow stream retention (${summary.role}) reached its batch limit after deleting ${String(summary.deletedRows)} rows; backlog may remain.`,
      attributes,
    };
  }
  return {
    level: "info",
    message: `Workflow stream retention (${summary.role}) deleted ${String(summary.deletedRows)} rows in ${String(summary.durationMs)}ms.`,
    attributes,
  };
}

function redactDatabaseUrls(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted database URL]");
}
