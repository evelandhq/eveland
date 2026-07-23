import { SessionReplay } from "@/components/session-replay"
import { SessionTraceView } from "@/components/session-trace-view"
import { getSession, getSessionEvents, getSessionNodes, getSessionTelemetry, getSessionUsage } from "@/lib/server-api"
import { formatTokenCount, formatUsd, groupModelUsageByAgent } from "@/lib/usage"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ sessionId: string }>
}) {
  const { sessionId } = await params
  return { title: `Session ${sessionId}` }
}

export default async function SessionTimelinePage({
  params,
}: {
  params: Promise<{ projectId: string; sessionId: string }>
}) {
  const { projectId, sessionId } = await params
  const [events, session, usageEvents, nodes, telemetry] = await Promise.all([
    getSessionEvents(sessionId),
    getSession(sessionId),
    getSessionUsage(sessionId),
    getSessionNodes(sessionId),
    getSessionTelemetry(sessionId),
  ])
  const usage = session.usage
  const agentUsage = groupModelUsageByAgent(usageEvents)

  return (
    <section className="rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Session replay</h2>
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
      {nodes.length > 0 ? (
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Session tree</h3>
          <div className="mt-2 grid gap-2">
            {nodes.map((node) => (
              <div key={node.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 rounded-sm border border-border px-3 py-2 text-xs">
                <div className="min-w-0">
                  <div className="font-medium">{node.parentNodeId ? "↳ " : ""}{node.agentName ?? node.agentId ?? "Unknown agent"}</div>
                  <div className="mt-1 truncate font-mono text-muted-foreground">{node.eveSessionId}</div>
                </div>
                <div className="text-right text-muted-foreground">
                  <div>{node.status}</div>
                  <div className="mt-1">{node.modelId ?? node.channelKind ?? "local"}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <SessionTraceView telemetry={telemetry} />
      <SessionReplay events={events} nodes={nodes} />
    </section>
  )
}
