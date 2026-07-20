import { Fragment } from "react";
import Link from "next/link";
import { getScheduleRuns, getSessionsPage } from "@/lib/server-api";
import { StatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTokenCount, summarizeTokenUsage } from "@/lib/usage";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Sessions",
};

const sessionTriggers = new Set(["playground", "api", "webhook", "channel", "direct_http"]);

export default async function SessionsPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ trigger?: string; schedule?: string; runCursor?: string; sessionCursor?: string }>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const scheduleTrigger = query.trigger === "cron" || query.trigger === "manual" ? query.trigger : undefined;
  const sessionTrigger = query.trigger && sessionTriggers.has(query.trigger) ? query.trigger : undefined;
  const showRuns = !query.trigger || Boolean(scheduleTrigger);
  const showSessions = !query.trigger || Boolean(sessionTrigger);
  const [runPage, sessionPage] = await Promise.all([
    showRuns
      ? getScheduleRuns(projectId, {
          scheduleId: query.schedule,
          trigger: scheduleTrigger,
          cursor: query.runCursor,
          limit: "25",
        })
      : Promise.resolve({ runs: [], nextCursor: null }),
    showSessions
      ? getSessionsPage(projectId, {
          trigger: sessionTrigger,
          cursor: query.sessionCursor,
          unlinkedOnly: query.trigger ? undefined : "true",
          limit: "50",
        })
      : Promise.resolve({ sessions: [], nextCursor: null }),
  ]);
  const usage = summarizeTokenUsage([
    ...runPage.runs.map((run) => run.usage),
    ...sessionPage.sessions.map((session) => session.usage),
  ]);
  const hasHistory = runPage.runs.length > 0 || sessionPage.sessions.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sessions</CardTitle>
        <CardDescription>
          Schedule runs are execution envelopes; linked Eve Sessions retain their own event, node, and usage timelines.
        </CardDescription>
        <dl className="flex flex-wrap items-center gap-6 pt-2">
          <div>
            <dt className="text-xs text-muted-foreground">Total tokens</dt>
            <dd className="font-mono font-medium">
              {usage.status === "none" || usage.status === "missing" ? "—" : formatTokenCount(usage.totalTokens)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Input / output</dt>
            <dd className="font-mono font-medium">{formatTokenCount(usage.inputTokens)} / {formatTokenCount(usage.outputTokens)}</dd>
          </div>
        </dl>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!hasHistory ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No matching history</EmptyTitle>
              <EmptyDescription>Runs remain visible even when a successful handler creates zero Sessions.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Execution</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runPage.runs.map((run) => (
                <Fragment key={run.id}>
                  <TableRow>
                    <TableCell>
                      <Link href={`/projects/${projectId}/schedule-runs/${run.id}`} className="font-medium hover:underline">
                        {run.trigger === "cron" ? "Cron" : "Manual"} · {run.scheduleKey}
                      </Link>
                      {run.error ? <p className="mt-1 max-w-xl text-xs text-destructive">{run.error}</p> : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{run.trigger}</TableCell>
                    <TableCell><StatusBadge status={run.status} /></TableCell>
                    <TableCell className="text-right font-mono text-xs">{run.sessionCount}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{tokenTotal(run.usage)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(run.startedAt ?? run.dueAt).toLocaleString()}</TableCell>
                  </TableRow>
                  {run.sessions.map((session) => (
                    <TableRow key={session.id}>
                      <TableCell className="pl-8">
                        <Link href={`/projects/${projectId}/sessions/${session.id}`} className="font-mono text-xs hover:underline">
                          {session.id}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">Session</TableCell>
                      <TableCell><StatusBadge status={session.status} /></TableCell>
                      <TableCell />
                      <TableCell className="text-right font-mono text-xs">{tokenTotal(session.usage)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{new Date(session.startedAt).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
              {sessionPage.sessions.map((session) => (
                <TableRow key={session.id}>
                  <TableCell>
                    <Link href={`/projects/${projectId}/sessions/${session.id}`} className="font-medium hover:underline">{session.id}</Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{session.trigger}</TableCell>
                  <TableCell><StatusBadge status={session.status} /></TableCell>
                  <TableCell />
                  <TableCell className="text-right font-mono text-xs">{tokenTotal(session.usage)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(session.startedAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {runPage.nextCursor ? (
            <Link href={historyHref(query, { runCursor: runPage.nextCursor })} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Older runs
            </Link>
          ) : null}
          {sessionPage.nextCursor ? (
            <Link href={historyHref(query, { sessionCursor: sessionPage.nextCursor })} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Older Sessions
            </Link>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function tokenTotal(usage: { status: string; inputTokens: number; outputTokens: number }): string {
  return usage.status === "none" || usage.status === "missing" ? "—" : formatTokenCount(usage.inputTokens + usage.outputTokens);
}

function historyHref(
  current: { trigger?: string; schedule?: string; runCursor?: string; sessionCursor?: string },
  update: { runCursor?: string; sessionCursor?: string },
): string {
  const query = new URLSearchParams();
  if (current.trigger) query.set("trigger", current.trigger);
  if (current.schedule) query.set("schedule", current.schedule);
  if (update.runCursor) query.set("runCursor", update.runCursor);
  if (update.sessionCursor) query.set("sessionCursor", update.sessionCursor);
  return `?${query.toString()}`;
}
