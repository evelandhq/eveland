import type {
  BuiltInOtlpLogRecord,
  SessionOtlpTelemetry,
} from "@eveland/core/observability";

import { Badge } from "@/components/ui/badge";
import { buildSessionTraceRows } from "@/lib/session-telemetry";

export function SessionTraceView({
  telemetry,
}: {
  telemetry: SessionOtlpTelemetry;
}) {
  const { rows, uncorrelatedLogs } = buildSessionTraceRows(telemetry);
  const correlatedLogCount = rows.reduce(
    (total, row) => total + row.logs.length,
    0,
  );

  return (
    <div className="border-b border-border px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            OpenTelemetry trace
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Eveland-private spans and logs correlated to this Session.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">
            {rows.length} {rows.length === 1 ? "span" : "spans"}
          </Badge>
          <Badge variant="outline">
            {telemetry.traceIds.length}{" "}
            {telemetry.traceIds.length === 1 ? "trace" : "traces"}
          </Badge>
          <Badge variant="outline">
            {correlatedLogCount + uncorrelatedLogs.length}{" "}
            {correlatedLogCount + uncorrelatedLogs.length === 1
              ? "log"
              : "logs"}
          </Badge>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No Eveland Agent spans have been received for this Session.
        </p>
      ) : (
        <ol className="mt-3 grid gap-2">
          {rows.map(({ span, depth, logs }) => (
            <li key={span.id}>
              <article
                className="rounded-sm border border-border bg-background px-3 py-2"
                style={{ marginLeft: `${depth * 1.25}rem` }}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{span.name}</p>
                    <p
                      className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                      title={`${span.traceId}/${span.spanId}`}
                    >
                      {span.traceId}/{span.spanId}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {formatDuration(span.durationMs)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">{span.resource.serviceName}</Badge>
                  <Badge variant="outline">{span.resource.domain}</Badge>
                  {span.statusCode === 2 ? (
                    <Badge variant="destructive">error</Badge>
                  ) : null}
                  <time
                    dateTime={span.startedAt}
                    className="text-xs text-muted-foreground"
                  >
                    {new Date(span.startedAt).toLocaleString()}
                  </time>
                </div>
                {logs.length > 0 ? (
                  <div className="mt-3 border-l-2 border-border pl-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Trace-correlated logs
                    </p>
                    <LogRecords logs={logs} />
                  </div>
                ) : null}
              </article>
            </li>
          ))}
        </ol>
      )}

      {uncorrelatedLogs.length > 0 ? (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Session logs
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Records correlated by Session or trace, without a matching span.
          </p>
          <LogRecords logs={uncorrelatedLogs} />
        </div>
      ) : null}
    </div>
  );
}

function LogRecords({ logs }: { logs: BuiltInOtlpLogRecord[] }) {
  return (
    <ul className="mt-2 grid gap-2">
      {logs.map((log) => (
        <li
          key={log.id}
          className="grid gap-1 text-xs sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-3"
        >
          <div className="min-w-0">
            <p className="break-words text-foreground">
              {log.eventName ?? bodySummary(log.body)}
            </p>
            {log.eventName ? (
              <p className="mt-0.5 line-clamp-2 break-words text-muted-foreground">
                {bodySummary(log.body)}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2 text-muted-foreground sm:justify-end">
            {log.severityText ? (
              <Badge
                variant={
                  (log.severityNumber ?? 0) >= 17
                    ? "destructive"
                    : "outline"
                }
              >
                {log.severityText}
              </Badge>
            ) : null}
            <time dateTime={log.timestamp}>
              {new Date(log.timestamp).toLocaleString()}
            </time>
          </div>
        </li>
      ))}
    </ul>
  );
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000
    ? `${Math.round(durationMs * 100) / 100} ms`
    : `${Math.round(durationMs / 10) / 100} s`;
}

function bodySummary(body: unknown): string {
  const value =
    typeof body === "string" ? body : JSON.stringify(body) ?? "";
  return value.length > 240 ? `${value.slice(0, 237)}...` : value;
}
