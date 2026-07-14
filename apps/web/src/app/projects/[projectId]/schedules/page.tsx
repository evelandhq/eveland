import Link from "next/link";
import { getSchedules } from "@/lib/server-api";
import { StatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function SchedulesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const schedules = await getSchedules(projectId);

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Schedules</h2>
        <p className="mt-1 text-xs text-muted-foreground">Markdown schedules can be triggered by the MVP worker; TypeScript schedules are discovery-only.</p>
      </div>
      <table className="w-full border-collapse text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 text-left font-medium">Name</th>
            <th className="px-4 py-2 text-left font-medium">Cron</th>
            <th className="px-4 py-2 text-left font-medium">Next run</th>
            <th className="px-4 py-2 text-left font-medium">Source</th>
            <th className="px-4 py-2 text-right font-medium">History</th>
          </tr>
        </thead>
        <tbody>
          {schedules.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                No schedules discovered.
              </td>
            </tr>
          ) : (
            schedules.map((schedule) => (
              <tr key={schedule.id} className="border-t border-border">
                <td className="px-4 py-3">
                  <div className="font-medium">{schedule.name}</div>
                  <StatusBadge status={schedule.executable ? "running" : "stopped"} />
                </td>
                <td className="px-4 py-3 text-muted-foreground">{schedule.cron ?? schedule.kind}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{schedule.nextRunAt ?? "Not scheduled"}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{schedule.sourcePath}</td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/projects/${projectId}/sessions?trigger=cron&schedule=${schedule.id}`}
                    className={buttonVariants({ variant: "outline" })}
                  >
                    View history
                  </Link>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
