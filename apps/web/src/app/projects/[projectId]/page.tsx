import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { DateTime } from "@/components/date-time";
import { EveVersionStatus } from "@/components/eve-version-status";
import { ProjectOverviewTrend } from "@/components/project-overview-trend";
import { CopyValue } from "@/components/copy-value";
import { getEveVersionStatus } from "@/lib/eve-version";
import { describeProjectSource } from "@/lib/project-source";
import { StatusBadge } from "@/components/status-badge";
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
export const metadata = {
  title: "Overview",
};

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
    <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-8">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">Overview</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Current status, recent activity, and usage for this project.
        </p>
      </header>

      {/* One bordered card for the project's current context: the endpoint —
          the one value you actually paste somewhere — gets the size on top, and
          the provenance facts sit below a hairline as a quiet four-up grid. */}
      <section
        aria-label="Current project context"
        className="flex flex-col gap-4 rounded-xl border p-5"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-xs text-muted-foreground">Stable endpoint</p>
          {endpoints.stable ? (
            <CopyValue
              className="font-mono text-base font-medium"
              icon="always"
              label="stable endpoint"
              value={endpoints.stable}
            />
          ) : (
            <p className="text-base font-medium text-muted-foreground">Not available</p>
          )}
        </div>

        <dl className="grid gap-4 border-t pt-4 text-xs sm:grid-cols-2 xl:grid-cols-4">
          <OverviewFact
            label="Next run"
            value={
              nextSchedule?.schedule.nextRunAt ? (
                <DateTime value={nextSchedule.schedule.nextRunAt} />
              ) : (
                `None scheduled · ${schedules.length} discovered`
              )
            }
          />
          <OverviewFact
            label="Release"
            value={
              project?.releaseId ? (
                <CopyValue className="font-mono" label="release id" value={project.releaseId} />
              ) : (
                "None"
              )
            }
          />
          <OverviewFact
            label="Source"
            value={
              project ? describeProjectSource(project.importKind, project.gitUrl).label : "None"
            }
          />
          {/* Normal is quiet: a current runtime is a version number, not a
              badge. The badge is what upgrade-pending (amber) and unsupported
              (red) earn. */}
          <OverviewFact
            label="Eve Agent"
            value={
              getEveVersionStatus(eveVersion) === "current" ? (
                <span className="font-mono">{eveVersion.version ?? "Unknown"}</span>
              ) : (
                <EveVersionStatus eveVersion={eveVersion} showMessage={false} />
              )
            }
          />
        </dl>
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
        <dl className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <OverviewStat
            label="Sessions"
            value={analytics.summary.sessions.toLocaleString()}
            detail={`${analytics.summary.runningSessions} running`}
            detailTone={analytics.summary.runningSessions > 0 ? "info" : "muted"}
          />
          <OverviewStat
            label="Completed"
            value={completion === null ? "—" : `${completion.toFixed(1)}%`}
            detail={`${analytics.summary.failedSessions} failed`}
            detailTone={analytics.summary.failedSessions > 0 ? "destructive" : "muted"}
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
        <div className="mt-3 rounded-xl border p-4 pb-2">
          <p className="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-chart-1" />
            Sessions per day
          </p>
          <ProjectOverviewTrend series={analytics.series} />
        </div>
      </section>

      <section aria-labelledby="recent-sessions-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 id="recent-sessions-heading" className="text-base font-semibold">
              Recent sessions
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
        <div className="mt-3 overflow-x-auto rounded-xl border">
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

function OverviewFact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm font-medium break-words">{value}</dd>
    </div>
  );
}

const STAT_DETAIL_TONE = {
  muted: "text-muted-foreground",
  info: "text-info-foreground",
  destructive: "text-destructive-foreground",
} as const;

function OverviewStat({
  label,
  value,
  detail,
  detailTone = "muted",
}: {
  label: string;
  value: string;
  detail: string;
  detailTone?: keyof typeof STAT_DETAIL_TONE;
}) {
  return (
    <div className="rounded-xl border p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-[22px] font-semibold tracking-tight">{value}</dd>
      <dd className={`mt-0.5 text-xs ${STAT_DETAIL_TONE[detailTone]}`}>{detail}</dd>
    </div>
  );
}
