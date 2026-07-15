import Link from "next/link";
import { getScheduleRun } from "@/lib/server-api";
import { StatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTokenCount } from "@/lib/usage";

export const dynamic = "force-dynamic";

export default async function ScheduleRunPage({ params }: {
  params: Promise<{ projectId: string; scheduleRunId: string }>;
}) {
  const { projectId, scheduleRunId } = await params;
  const run = await getScheduleRun(scheduleRunId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{run.trigger === "cron" ? "Cron" : "Manual"} · {run.scheduleKey}</CardTitle>
        <CardDescription>{run.id}</CardDescription>
        <div className="pt-2"><StatusBadge status={run.status} /></div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-xs text-muted-foreground">Release</dt><dd className="mt-1 font-mono text-xs">{run.release.id}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Deployment</dt><dd className="mt-1 font-mono text-xs">{run.deployment.id}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Due</dt><dd className="mt-1 text-sm">{new Date(run.dueAt).toLocaleString()}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Missed ticks</dt><dd className="mt-1 font-mono text-sm">{run.missedTicks}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Started</dt><dd className="mt-1 text-sm">{run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Completed</dt><dd className="mt-1 text-sm">{run.completedAt ? new Date(run.completedAt).toLocaleString() : "—"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Sessions</dt><dd className="mt-1 font-mono text-sm">{run.sessionCount}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Tokens</dt><dd className="mt-1 font-mono text-sm">{tokenTotal(run.usage)}</dd></div>
        </dl>
        {run.error ? (
          <div>
            <h3 className="text-sm font-medium">Failure</h3>
            <p className="mt-1 text-sm text-destructive">{run.error}</p>
          </div>
        ) : null}
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Linked Sessions</h3>
          {run.sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">This handler completed without creating a Session.</p>
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>Session</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Tokens</TableHead><TableHead>Started</TableHead></TableRow></TableHeader>
              <TableBody>
                {run.sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell><Link href={`/projects/${projectId}/sessions/${session.id}`} className="font-mono text-xs hover:underline">{session.id}</Link></TableCell>
                    <TableCell><StatusBadge status={session.status} /></TableCell>
                    <TableCell className="text-right font-mono text-xs">{tokenTotal(session.usage)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(session.startedAt).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
      <CardFooter>
        <Link href={`/projects/${projectId}/sessions?trigger=${run.trigger}&schedule=${run.scheduleId}`} className={buttonVariants({ variant: "outline" })}>
          Back to history
        </Link>
      </CardFooter>
    </Card>
  );
}

function tokenTotal(usage: { status: string; inputTokens: number; outputTokens: number }): string {
  return usage.status === "none" || usage.status === "missing" ? "—" : formatTokenCount(usage.inputTokens + usage.outputTokens);
}
