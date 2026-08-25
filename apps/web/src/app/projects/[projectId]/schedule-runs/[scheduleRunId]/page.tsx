import Link from "next/link";
import { AcknowledgeScheduleRuns } from "@/components/acknowledge-schedule-runs";
import { DateTime } from "@/components/date-time";
import { getScheduleRun } from "@/lib/server-api";
import { StatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatTokenCount } from "@/lib/usage";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ scheduleRunId: string }> }) {
  const { scheduleRunId } = await params;
  return { title: `Schedule run ${scheduleRunId}` };
}

export default async function ScheduleRunPage({
  params,
}: {
  params: Promise<{ projectId: string; scheduleRunId: string }>;
}) {
  const { projectId, scheduleRunId } = await params;
  const run = await getScheduleRun(scheduleRunId);

  return (
    <div className="flex flex-col gap-8">
      {/* One bordered card for the run's context: what ran and how it ended on
          top, the execution facts below a hairline as a quiet grid. */}
      <section
        aria-label="Schedule run context"
        className="flex flex-col gap-4 rounded-xl border p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">
              {run.trigger === "cron" ? "Cron" : "Manual"} · {run.scheduleKey}
            </h2>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{run.id}</p>
          </div>
          <StatusBadge status={run.status} />
        </div>
        <dl className="grid gap-4 border-t pt-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <RunFact label="Release" value={<span className="font-mono">{run.release.id}</span>} />
          <RunFact
            label="Deployment"
            value={<span className="font-mono">{run.deployment.id}</span>}
          />
          <RunFact label="Due" value={<DateTime value={run.dueAt} />} />
          <RunFact
            label="Missed ticks"
            value={<span className="font-mono">{run.missedTicks}</span>}
          />
          <RunFact
            label="Started"
            value={run.startedAt ? <DateTime value={run.startedAt} /> : "—"}
          />
          <RunFact
            label="Completed"
            value={run.completedAt ? <DateTime value={run.completedAt} /> : "—"}
          />
          <RunFact label="Sessions" value={<span className="font-mono">{run.sessionCount}</span>} />
          <RunFact
            label="Tokens"
            value={<span className="font-mono">{tokenTotal(run.usage)}</span>}
          />
        </dl>
        {run.error ? (
          <div className="border-t pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-medium">Failure</h3>
              {run.status === "failed" ? (
                run.acknowledgedAt ? (
                  <p className="text-xs text-muted-foreground">
                    Reviewed <DateTime value={run.acknowledgedAt} />
                  </p>
                ) : (
                  <AcknowledgeScheduleRuns projectId={projectId} runIds={[run.id]}>
                    Mark reviewed
                  </AcknowledgeScheduleRuns>
                )
              ) : null}
            </div>
            <p className="mt-1 text-sm text-destructive">{run.error}</p>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="linked-sessions-heading">
        <h3 id="linked-sessions-heading" className="text-base font-semibold">
          Linked Sessions
        </h3>
        {run.sessions.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            This handler completed without creating a Session.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead>Started</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {run.sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell>
                      <Link
                        href={`/projects/${projectId}/sessions/${session.id}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {session.id}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={session.status} />
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {tokenTotal(session.usage)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <DateTime value={session.startedAt} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <div>
        <Link
          href={`/projects/${projectId}/sessions?trigger=${run.trigger}&schedule=${run.scheduleId}`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Back to history
        </Link>
      </div>
    </div>
  );
}

function RunFact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm font-medium break-words">{value}</dd>
    </div>
  );
}

function tokenTotal(usage: { status: string; inputTokens: number; outputTokens: number }): string {
  return usage.status === "none" || usage.status === "missing"
    ? "—"
    : formatTokenCount(usage.inputTokens + usage.outputTokens);
}
