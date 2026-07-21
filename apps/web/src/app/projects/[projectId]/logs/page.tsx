import { ProjectLogViewer } from "@/components/project-log-viewer";
import { Badge } from "@/components/ui/badge";
import { getLogs } from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Logs",
};

export default async function LogsPage({ params }: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const logs = await getLogs(projectId);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">Logs</h2>
          <p className="text-sm text-muted-foreground">
            Build, deploy, and runtime output. Agent events remain in Session Timeline.
          </p>
        </div>
        <Badge variant="outline">{logs.length} {logs.length === 1 ? "line" : "lines"}</Badge>
      </header>

      <ProjectLogViewer logs={logs} />
    </section>
  );
}
