type SweepStatus = "ok" | "error";

export type WorkflowStreamRetentionSummary = {
  role: "legacy";
  status: SweepStatus;
  durationMs: number;
  deletedRows: number;
  error?: unknown;
};

export async function runWorkflowStreamRetentionSweep(input: {
  sweepLegacy: () => Promise<number>;
  onSummary?: (summary: WorkflowStreamRetentionSummary) => void;
}): Promise<WorkflowStreamRetentionSummary> {
  const summary = await captureLegacySweep(input.sweepLegacy);
  input.onSummary?.(summary);
  return summary;
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

export function startWorkflowStreamRetentionScheduler(input: {
  intervalMs: number;
  run: () => Promise<void>;
  close?: () => Promise<void>;
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
        await input.close?.();
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
  return {
    level: "info",
    message: `Workflow stream retention (${summary.role}) deleted ${String(summary.deletedRows)} rows in ${String(summary.durationMs)}ms.`,
    attributes,
  };
}

function redactDatabaseUrls(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted database URL]");
}
