import { ProjectLogViewer } from "@/components/project-log-viewer";
import { getLogs } from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Logs",
};

export default async function LogsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const logs = await getLogs(projectId);

  return (
    <div className="mx-auto flex min-h-0 flex-1 w-full max-w-4xl flex-col gap-4">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">Logs</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Build, deployment, and runtime activity for this project.
        </p>
      </header>
      <ProjectLogViewer logs={logs} />
    </div>
  );
}
