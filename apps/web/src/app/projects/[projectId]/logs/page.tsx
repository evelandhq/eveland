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
    <section className="flex flex-col">
      <ProjectLogViewer logs={logs} />
    </section>
  );
}
