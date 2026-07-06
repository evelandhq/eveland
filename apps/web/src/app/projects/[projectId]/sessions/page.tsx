import Link from "next/link";
import { getSessions } from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

export default async function SessionsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const sessions = await getSessions(projectId);

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Sessions</h2>
        <p className="mt-1 text-xs text-muted-foreground">Runtime history from Playground, cron, webhooks, channels, and API triggers.</p>
      </div>
      <table className="w-full border-collapse text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 text-left font-medium">Session</th>
            <th className="px-4 py-2 text-left font-medium">Trigger</th>
            <th className="px-4 py-2 text-left font-medium">Status</th>
            <th className="px-4 py-2 text-left font-medium">Started</th>
          </tr>
        </thead>
        <tbody>
          {sessions.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-10 text-center text-muted-foreground">
                No sessions recorded.
              </td>
            </tr>
          ) : (
            sessions.map((session) => (
              <tr key={session.id} className="border-t border-border">
                <td className="px-4 py-3">
                  <Link href={`/projects/${projectId}/sessions/${session.id}`} className="font-medium hover:underline">
                    {session.id}
                  </Link>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{session.trigger}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={session.status} />
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(session.startedAt).toLocaleString()}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
