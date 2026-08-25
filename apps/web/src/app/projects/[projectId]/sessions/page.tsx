import Link from "next/link";
import { DateTime } from "@/components/date-time";
import { getSchedules, getSessionsPage } from "@/lib/server-api";
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
import { formatTokenCount, summarizeTokenUsage } from "@/lib/usage";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Sessions",
};

const sessionTriggers = new Set([
  "playground",
  "api",
  "cron",
  "manual",
  "webhook",
  "channel",
  "direct_http",
]);

type SessionsQuery = {
  trigger?: string;
  schedule?: string;
  sessionCursor?: string;
};

export default async function SessionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<SessionsQuery>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const sessionTrigger =
    query.trigger && sessionTriggers.has(query.trigger) ? query.trigger : undefined;
  const [sessionPage, schedules] = await Promise.all([
    getSessionsPage(projectId, {
      trigger: sessionTrigger,
      scheduleId: query.schedule,
      cursor: query.sessionCursor,
      limit: "50",
    }),
    getSchedules(projectId),
  ]);
  const scheduleKeys = new Map(schedules.map(({ schedule }) => [schedule.id, schedule.key]));
  const usage = summarizeTokenUsage(sessionPage.sessions.map((session) => session.usage));

  return (
    // The heading carries the page-level usage numbers on its right, so the
    // table below stays purely tabular.
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <h2 className="text-base font-semibold">Sessions</h2>
        <dl className="flex flex-wrap items-center gap-5 text-right">
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Tokens on this page
            </dt>
            <dd className="font-mono text-xs font-semibold tabular-nums">
              {usage.status === "none" || usage.status === "missing"
                ? "—"
                : formatTokenCount(usage.totalTokens)}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Input / output
            </dt>
            <dd className="font-mono text-xs font-semibold tabular-nums">
              {formatTokenCount(usage.inputTokens)} / {formatTokenCount(usage.outputTokens)}
            </dd>
          </div>
        </dl>
      </div>
      {sessionPage.sessions.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No matching Sessions</EmptyTitle>
            <EmptyDescription>No Eve Sessions match the current filters.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
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
              {sessionPage.sessions.map((session) => (
                <TableRow key={session.id}>
                  <TableCell>
                    <Link
                      href={`/projects/${projectId}/sessions/${session.id}`}
                      className="font-mono text-xs font-medium hover:underline"
                    >
                      {session.id}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs">
                    <span>{triggerLabel(session.trigger)}</span>
                    {session.scheduleId && scheduleKeys.has(session.scheduleId) ? (
                      <span className="text-muted-foreground">
                        {" "}
                        · {scheduleKeys.get(session.scheduleId)}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={session.status} />
                    {session.error ? (
                      <p
                        className="mt-1 max-w-80 truncate text-xs text-destructive"
                        title={session.error}
                      >
                        {session.error}
                      </p>
                    ) : null}
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
      {sessionPage.nextCursor ? (
        <div className="flex justify-end">
          <Link
            href={historyHref(query, sessionPage.nextCursor)}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Older sessions
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function triggerLabel(trigger: string): string {
  return trigger
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function tokenTotal(usage: { status: string; inputTokens: number; outputTokens: number }): string {
  return usage.status === "none" || usage.status === "missing"
    ? "—"
    : formatTokenCount(usage.inputTokens + usage.outputTokens);
}

function historyHref(current: SessionsQuery, sessionCursor: string): string {
  const query = new URLSearchParams();
  if (current.trigger) query.set("trigger", current.trigger);
  if (current.schedule) query.set("schedule", current.schedule);
  query.set("sessionCursor", sessionCursor);
  return `?${query.toString()}`;
}
