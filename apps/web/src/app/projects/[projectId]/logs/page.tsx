import { getLogs } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function LogsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const logs = await getLogs(projectId);

  return (
    <section className="rounded-md border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Logs</h2>
        <p className="mt-1 text-xs text-muted-foreground">Build log, deploy log, and runtime stdout/stderr. Agent events stay in Session Timeline.</p>
      </div>
      <div className="min-h-96 bg-[#111] p-4 font-mono text-xs leading-6 text-[#e8e4d8]">
        {logs.length === 0 ? (
          <div className="text-[#8f8a7d]">No log lines recorded.</div>
        ) : (
          logs.map((log) => (
            <div key={log.id}>
              <span className="text-[#8f8a7d]">[{log.type}]</span> {log.line}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
