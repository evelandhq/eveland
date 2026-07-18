import Link from "next/link";
import { getSchedules } from "@/lib/server-api";
import { RunScheduleAction } from "@/components/run-schedule-action";
import { StatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

export default async function SchedulesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const schedules = await getSchedules(projectId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Schedules</CardTitle>
        <CardDescription>
          Eveland executes Markdown and TypeScript schedules from the promoted scheduler target. Cron expressions use UTC.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {schedules.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No schedules discovered</EmptyTitle>
              <EmptyDescription>Deploy an Eve 0.24.x or 0.25.x project with definitions under agent/schedules.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Schedule</TableHead>
                <TableHead>Cron</TableHead>
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
                      <span className="text-xs text-muted-foreground">{version?.sourcePath ?? "Not present in the target Release"}</span>
                      <StatusBadge status={version && schedule.enabled ? "running" : "stopped"} />
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{version?.cron ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : "Not scheduled"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{targetDeploymentId ?? "—"}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-start justify-end gap-2">
                      <Link
                        href={`/projects/${projectId}/sessions?trigger=cron&schedule=${schedule.id}`}
                        className={buttonVariants({ variant: "outline", size: "sm" })}
                      >
                        View history
                      </Link>
                      <RunScheduleAction projectId={projectId} scheduleId={schedule.id} disabled={!version || !schedule.enabled} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
