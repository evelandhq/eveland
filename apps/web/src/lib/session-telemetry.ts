import type {
  BuiltInOtlpLogRecord,
  BuiltInOtlpSpan,
  SessionOtlpTelemetry,
} from "@eveland/core/observability";

export type SessionTraceRow = {
  span: BuiltInOtlpSpan;
  depth: number;
  logs: BuiltInOtlpLogRecord[];
};

export function buildSessionTraceRows(
  telemetry: SessionOtlpTelemetry,
): {
  rows: SessionTraceRow[];
  uncorrelatedLogs: BuiltInOtlpLogRecord[];
} {
  const spans = [...telemetry.spans].sort(compareSpans);
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const children = new Map<string, BuiltInOtlpSpan[]>();
  const roots: BuiltInOtlpSpan[] = [];
  for (const span of spans) {
    const parent = span.parentSpanId
      ? byId.get(span.parentSpanId)
      : undefined;
    if (
      !parent ||
      parent.traceId !== span.traceId ||
      parent.spanId === span.spanId
    ) {
      roots.push(span);
      continue;
    }
    const siblings = children.get(parent.spanId) ?? [];
    siblings.push(span);
    siblings.sort(compareSpans);
    children.set(parent.spanId, siblings);
  }

  const logsBySpan = new Map<string, BuiltInOtlpLogRecord[]>();
  const uncorrelatedLogs: BuiltInOtlpLogRecord[] = [];
  for (const log of [...telemetry.logs].sort(compareLogs)) {
    if (!log.spanId || !byId.has(log.spanId)) {
      uncorrelatedLogs.push(log);
      continue;
    }
    const logs = logsBySpan.get(log.spanId) ?? [];
    logs.push(log);
    logsBySpan.set(log.spanId, logs);
  }

  const rows: SessionTraceRow[] = [];
  const visited = new Set<string>();
  const append = (span: BuiltInOtlpSpan, depth: number) => {
    if (visited.has(span.spanId)) return;
    visited.add(span.spanId);
    rows.push({
      span,
      depth,
      logs: logsBySpan.get(span.spanId) ?? [],
    });
    for (const child of children.get(span.spanId) ?? []) {
      append(child, depth + 1);
    }
  };
  for (const root of roots) append(root, 0);
  for (const span of spans) append(span, 0);

  return { rows, uncorrelatedLogs };
}

function compareSpans(
  left: BuiltInOtlpSpan,
  right: BuiltInOtlpSpan,
): number {
  return (
    left.startedAt.localeCompare(right.startedAt) ||
    left.spanId.localeCompare(right.spanId)
  );
}

function compareLogs(
  left: BuiltInOtlpLogRecord,
  right: BuiltInOtlpLogRecord,
): number {
  return (
    left.timestamp.localeCompare(right.timestamp) ||
    left.id.localeCompare(right.id)
  );
}
