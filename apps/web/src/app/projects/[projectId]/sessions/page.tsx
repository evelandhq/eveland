import Link from "next/link";
import { getSessions } from "@/lib/server-api";
import { StatusBadge } from "@/components/status-badge";
import { formatTokenCount, summarizeTokenUsage } from "@/lib/usage";

export const dynamic = "force-dynamic";

export default async function SessionsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const sessions = await getSessions(projectId);
  const usage = summarizeTokenUsage(sessions.map((session) => session.usage));

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Sessions</h2>
          <p className="mt-1 text-xs text-muted-foreground">Runtime history from Playground, cron, webhooks, channels, and API triggers.</p>
        </div>
        <dl className="flex items-center gap-6 text-right">
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Total tokens</dt>
            <dd className="mt-0.5 font-mono text-sm font-medium">{usage.status === "none" || usage.status === "missing" ? "—" : formatTokenCount(usage.totalTokens)}</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Input / output</dt>
            <dd className="mt-0.5 font-mono text-sm font-medium">
              {formatTokenCount(usage.inputTokens)} / {formatTokenCount(usage.outputTokens)}
            </dd>
          </div>
        </dl>
      </div>
      <table className="w-full border-collapse text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 text-left font-medium">Session</th>
            <th className="px-4 py-2 text-left font-medium">Trigger</th>
            <th className="px-4 py-2 text-left font-medium">Status</th>
            <th className="px-4 py-2 text-right font-medium">Tokens</th>
            <th className="px-4 py-2 text-right font-medium">Input / output</th>
            <th className="px-4 py-2 text-left font-medium">Started</th>
          </tr>
        </thead>
        <tbody>
          {sessions.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
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
                <td className="px-4 py-3 text-right font-mono text-xs">
                  {session.usage.status === "none" || session.usage.status === "missing"
                    ? "—"
                    : formatTokenCount(session.usage.inputTokens + session.usage.outputTokens)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                  {formatTokenCount(session.usage.inputTokens)} / {formatTokenCount(session.usage.outputTokens)}
                  {session.usage.status === "partial" ? <span className="ml-2 text-amber-600">partial</span> : null}
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
