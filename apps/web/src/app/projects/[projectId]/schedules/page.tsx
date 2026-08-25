import Link from "next/link";
import { SUPPORTED_EVE_VERSION_RANGE } from "@evelandhq/core/eve-compatibility";
import { describeScheduleCron } from "@evelandhq/core/schedules";
import { DateTime } from "@/components/date-time";
import { getScheduleAttention, getScheduleRuns, getSchedules } from "@/lib/server-api";
import { AcknowledgeScheduleRuns } from "@/components/acknowledge-schedule-runs";
import { RunScheduleAction } from "@/components/run-schedule-action";
import { StatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
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
export const metadata = {
  title: "Schedules",
};

type SchedulesQuery = {
  schedule?: string;
  runCursor?: string;
};

export default async function SchedulesPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<SchedulesQuery>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const [schedules, runPage, attention] = await Promise.all([
    getSchedules(projectId),
    getScheduleRuns(projectId, {
      scheduleId: query.schedule,
      cursor: query.runCursor,
      limit: "50",
    }),
    getScheduleAttention(projectId),
  ]);
  const selectedSchedule = query.schedule
    ? schedules.find(({ schedule }) => schedule.id === query.schedule)
    : undefined;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">Schedules</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Markdown and TypeScript schedules run from the promoted scheduler target. Cron definitions
          use UTC; run timestamps use your display timezone.
        </p>
      </header>
      {attention > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive-subtle px-4 py-3">
          <p className="text-sm text-destructive-foreground">
            {attention} failed {attention === 1 ? "run needs" : "runs need"} review. Each run below
            records why it failed; mark it reviewed once someone has looked.
          </p>
          <AcknowledgeScheduleRuns projectId={projectId}>Mark all reviewed</AcknowledgeScheduleRuns>
        </div>
      ) : null}
      {schedules.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No schedules discovered</EmptyTitle>
            <EmptyDescription>
              Deploy an Eve {SUPPORTED_EVE_VERSION_RANGE} project with definitions under
              agent/schedules.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Schedule</TableHead>
                <TableHead>Timing</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>Target</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.map(({ schedule, version, targetDeploymentId }) => (
                <TableRow key={schedule.id}>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">{schedule.key}</span>
                      <span className="text-xs text-muted-foreground">
                        {version?.sourcePath ?? "Not present in the target Release"}
                      </span>
                      <StatusBadge status={version && schedule.enabled ? "running" : "stopped"} />
                    </div>
                  </TableCell>
                  <TableCell>
                    {version ? (
                      <div className="flex flex-col gap-1">
                        <span>{describeScheduleCron(version.cron)}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {version.cron}
                        </span>
                      </div>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {schedule.nextRunAt ? <DateTime value={schedule.nextRunAt} /> : "Not scheduled"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {targetDeploymentId ?? "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-start justify-end gap-2">
                      <Link
                        href={`?schedule=${encodeURIComponent(schedule.id)}#recent-runs`}
                        className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
                      >
                        View history
                      </Link>
                      <RunScheduleAction
                        projectId={projectId}
                        scheduleId={schedule.id}
                        scheduleKey={schedule.key}
                        disabled={!version || !schedule.enabled}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <section id="recent-runs" className="scroll-mt-4">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">
              {selectedSchedule ? `Recent runs · ${selectedSchedule.schedule.key}` : "Recent runs"}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              The latest schedule executions, including runs that produced no Session.
            </p>
          </div>
          {query.schedule ? (
            <Link
              href={`/projects/${projectId}/schedules#recent-runs`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              All schedules
            </Link>
          ) : null}
        </div>

        {runPage.runs.length === 0 ? (
          <Empty className="py-8">
            <EmptyHeader>
              <EmptyTitle>No recent runs</EmptyTitle>
              <EmptyDescription>Cron and manual executions will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead>Started</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runPage.runs.map((run) => {
                  const onlySession = run.sessions.length === 1 ? run.sessions[0] : undefined;
                  const destination = onlySession
                    ? `/projects/${projectId}/sessions/${onlySession.id}`
                    : `/projects/${projectId}/schedule-runs/${run.id}`;

                  return (
                    <TableRow key={run.id}>
                      <TableCell>
                        <Link href={destination} className="font-medium hover:underline">
                          {run.scheduleKey}
                        </Link>
                        <p className="mt-1 font-mono text-xs text-muted-foreground">
                          {onlySession?.id ?? run.id}
                        </p>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {run.trigger === "cron" ? "Cron" : "Manual"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={run.status} />
                        {run.status === "failed" ? (
                          run.acknowledgedAt ? (
                            <p className="mt-1 text-xs text-muted-foreground">Reviewed</p>
                          ) : (
                            <div className="mt-1.5">
                              <AcknowledgeScheduleRuns
                                projectId={projectId}
                                runIds={[run.id]}
                                variant="ghost"
                              >
                                Mark reviewed
                              </AcknowledgeScheduleRuns>
                            </div>
                          )
                        ) : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {run.sessionCount === 0
                          ? "No Session"
                          : `${run.sessionCount} ${run.sessionCount === 1 ? "Session" : "Sessions"}`}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {tokenTotal(run.usage)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {run.startedAt ? (
                          <DateTime value={run.startedAt} />
                        ) : (
                          <>
                            Due <DateTime value={run.dueAt} />
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {runPage.nextCursor ? (
          <div className="mt-4 flex justify-end">
            <Link
              href={runHistoryHref(query, runPage.nextCursor)}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Older runs
            </Link>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function tokenTotal(usage: { status: string; inputTokens: number; outputTokens: number }): string {
  return usage.status === "none" || usage.status === "missing"
    ? "—"
    : formatTokenCount(usage.inputTokens + usage.outputTokens);
}

function runHistoryHref(current: SchedulesQuery, runCursor: string): string {
  const query = new URLSearchParams();
  if (current.schedule) query.set("schedule", current.schedule);
  query.set("runCursor", runCursor);
  return `?${query.toString()}#recent-runs`;
}
