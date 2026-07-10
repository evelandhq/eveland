import { getSessionEvents, getSessionUsage, getSessions } from "@/lib/api"
import { formatTokenCount, formatUsd, groupModelUsageByAgent } from "@/lib/usage"

export default async function SessionTimelinePage({
  params,
}: {
  params: Promise<{ projectId: string; sessionId: string }>
}) {
  const { projectId, sessionId } = await params
  const [events, sessions, usageEvents] = await Promise.all([
    getSessionEvents(sessionId),
    getSessions(projectId),
    getSessionUsage(sessionId),
  ])
  const session = sessions.find((candidate) => candidate.id === sessionId)
  const usage = session?.usage
  const agentUsage = groupModelUsageByAgent(usageEvents)

  return (
    <section className="rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Session timeline</h2>
          <p className="mt-1 text-xs text-muted-foreground">{sessionId}</p>
        </div>
        {usage ? (
          <dl className="flex items-center gap-6 text-right">
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Total tokens</dt>
              <dd className="mt-0.5 font-mono text-sm font-medium">
                {usage.status === "none" || usage.status === "missing"
                  ? "—"
                  : formatTokenCount(usage.inputTokens + usage.outputTokens)}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Input / output</dt>
              <dd className="mt-0.5 font-mono text-sm font-medium">
                {formatTokenCount(usage.inputTokens)} / {formatTokenCount(usage.outputTokens)}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Cache read</dt>
              <dd className="mt-0.5 font-mono text-sm font-medium">{formatTokenCount(usage.cacheReadTokens)}</dd>
            </div>
          </dl>
        ) : null}
      </div>
      {agentUsage.length > 0 ? (
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Usage by agent</h3>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1.5 text-left font-medium">Agent</th>
                  <th className="py-1.5 text-right font-medium">Steps</th>
                  <th className="py-1.5 text-right font-medium">Input</th>
                  <th className="py-1.5 text-right font-medium">Output</th>
                  <th className="py-1.5 text-right font-medium">Total</th>
                  <th className="py-1.5 text-right font-medium">Cache read</th>
                  <th className="py-1.5 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {agentUsage.map((agent, index) => (
                  <tr key={`${agent.agentId ?? agent.agentName ?? "unknown"}-${index}`} className="border-t border-border">
                    <td className="py-2 font-medium">{agent.agentName ?? agent.agentId ?? "Unknown agent"}</td>
                    <td className="py-2 text-right font-mono text-muted-foreground">
                      {agent.reportedSteps}
                      {agent.missingSteps > 0 ? ` + ${agent.missingSteps} missing` : ""}
                    </td>
                    <td className="py-2 text-right font-mono">{formatTokenCount(agent.inputTokens)}</td>
                    <td className="py-2 text-right font-mono">{formatTokenCount(agent.outputTokens)}</td>
                    <td className="py-2 text-right font-mono font-medium">{formatTokenCount(agent.totalTokens)}</td>
                    <td className="py-2 text-right font-mono text-muted-foreground">{formatTokenCount(agent.cacheReadTokens)}</td>
                    <td className="py-2 text-right font-mono text-muted-foreground">{formatUsd(agent.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      {events.length === 0 ? (
        <div className="flex min-h-80 items-center justify-center px-4 text-sm text-muted-foreground">No timeline events recorded.</div>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          {events.map((event) => (
            <article key={event.id} className="rounded-md border border-border bg-background p-3">
              <div className="flex items-center justify-between gap-4">
                <h3 className="text-xs font-semibold uppercase tracking-normal">{event.type}</h3>
                <time className="text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString()}</time>
              </div>
              <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-muted p-3 text-xs leading-5">{formatPayload(event.payload)}</pre>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function formatPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload
  }
  if (isRecord(payload)) {
    const content = payload.content
    if (typeof content === "string") {
      return content
    }
    const message = payload.message
    if (typeof message === "string") {
      return message
    }
  }
  return JSON.stringify(payload, null, 2)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
