import Link from "next/link";
import { ArrowRightIcon, PlayIcon } from "lucide-react";
import { DateTime } from "@/components/date-time";
import { EveVersionStatus } from "@/components/eve-version-status";
import { ProjectOverviewTrend } from "@/components/project-overview-trend";
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
import {
  getAgentEndpoints,
  getEveVersion,
  getProject,
  getProjectUsageAnalytics,
  getSchedules,
} from "@/lib/server-api";
import { completionRate, formatTokenCount, formatUsd, usageCoverage } from "@/lib/usage";

export const dynamic = "force-dynamic";

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const [project, endpoints, eveVersion, schedules, analytics] = await Promise.all([
    getProject(projectId),
    getAgentEndpoints(projectId),
    getEveVersion(projectId),
    getSchedules(projectId),
    getProjectUsageAnalytics(projectId, { range: "7d" }),
  ]);
  const completion = completionRate(analytics.summary);
  const coverage = usageCoverage(analytics.summary);
  const totalTokens = analytics.summary.inputTokens + analytics.summary.outputTokens;
  const nextSchedule = schedules
    .filter(({ schedule }) => schedule.enabled && schedule.nextRunAt)
    .sort(
      (left, right) =>
        new Date(left.schedule.nextRunAt!).getTime() -
        new Date(right.schedule.nextRunAt!).getTime(),
    )[0];

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs text-muted-foreground">Last 7 days</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">Overview</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Execution volume, reliability, and the latest activity for this Agent.
          </p>
        </div>
        <Link href={`/projects/${projectId}/playground`} className={buttonVariants()}>
          <PlayIcon data-icon="inline-start" />
          Open Playground
        </Link>
      </header>

      <section
        className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Current project context"
      >
        <OverviewContext
          label="Production"
          value={<StatusBadge status={project?.deploymentStatus ?? null} />}
          detail={project?.releaseId ?? "No release"}
        />
        <OverviewContext
          label="Eve Agent"
          value={<EveVersionStatus eveVersion={eveVersion} />}
          detail={eveVersion.supported ? "Compatible with Eveland" : "Action required"}
        />
        <OverviewContext
          label="Stable endpoint"
          value={
            endpoints.stable ? (
              <a
                href={endpoints.stable}
                target="_blank"
                rel="noreferrer"
                className="block truncate underline-offset-4 hover:underline"
              >
                {endpoints.stable}
              </a>
            ) : (
              "Not available"
            )
          }
          detail={project?.slug ?? projectId}
        />
        <OverviewContext
          label="Next schedule"
          value={
            nextSchedule?.schedule.nextRunAt ? (
              <DateTime value={nextSchedule.schedule.nextRunAt} />
            ) : (
              "None scheduled"
            )
          }
          detail={nextSchedule?.schedule.key ?? `${schedules.length} discovered`}
        />
      </section>

      <section aria-labelledby="execution-summary-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 id="execution-summary-heading" className="text-base font-semibold">
              Execution summary
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Sessions are bucketed by their start time.
            </p>
          </div>
          <Link
            href={`/projects/${projectId}/usage?range=7d`}
            className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
          >
            View usage
            <ArrowRightIcon className="size-4" />
          </Link>
        </div>
        <dl className="mt-5 grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
          <OverviewStat
            label="Sessions"
            value={analytics.summary.sessions.toLocaleString()}
            detail={`${analytics.summary.runningSessions} running`}
          />
          <OverviewStat
            label="Completed"
            value={completion === null ? "—" : `${completion.toFixed(1)}%`}
            detail={`${analytics.summary.failedSessions} failed`}
          />
          <OverviewStat
            label="Model tokens"
            value={formatTokenCount(totalTokens)}
            detail={coverage === null ? "No usage reported" : `${coverage.toFixed(1)}% coverage`}
          />
          <OverviewStat
            label="Provider cost"
            value={formatUsd(analytics.summary.costUsd)}
            detail="Provider-reported only"
          />
        </dl>
        <div className="mt-5 border-t border-border pt-4">
          <ProjectOverviewTrend series={analytics.series} />
        </div>
      </section>

      <section aria-labelledby="recent-sessions-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 id="recent-sessions-heading" className="text-base font-semibold">
              Recent Sessions
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Latest observed executions from the same seven-day window.
            </p>
          </div>
          <Link
            href={`/projects/${projectId}/sessions`}
            className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
          >
            View all
            <ArrowRightIcon className="size-4" />
          </Link>
        </div>
        <div className="mt-3 overflow-x-auto border-y border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Session</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analytics.recentSessions.slice(0, 8).map((session) => (
                <TableRow key={session.id}>
                  <TableCell>
                    <Link
                      href={`/projects/${projectId}/sessions/${session.id}`}
                      className="font-mono font-medium hover:underline"
                    >
                      {session.id}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{session.trigger}</TableCell>
                  <TableCell>
                    <StatusBadge status={session.status} />
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {session.usage.status === "none" || session.usage.status === "missing"
                      ? "—"
                      : formatTokenCount(session.usage.inputTokens + session.usage.outputTokens)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <DateTime value={session.startedAt} />
                  </TableCell>
                </TableRow>
              ))}
              {analytics.recentSessions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    No Sessions observed in the last 7 days.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}

function OverviewContext({
  label,
  value,
  detail,
}: {
  label: string;
  value: React.ReactNode;
  detail: string;
}) {
  return (
    <div className="min-w-0 bg-background p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-2 min-w-0 text-sm font-medium">{value}</div>
      <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function OverviewStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-2 font-mono text-xl font-semibold">{value}</dd>
      <dd className="mt-1 text-xs text-muted-foreground">{detail}</dd>
    </div>
  );
}
