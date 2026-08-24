import Link from "next/link";
import { ChevronDownIcon } from "lucide-react";
import { describeScheduleCron } from "@evelandhq/core/schedules";
import { DateTime } from "@/components/date-time";
import { SessionReplay } from "@/components/session-replay";
import { StatusBadge } from "@/components/status-badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  getScheduleRun,
  getSession,
  getSessionEvents,
  getSessionNodes,
  getSessionUsage,
} from "@/lib/server-api";
import { formatTraceDuration } from "@/lib/trace";
import { formatTokenCount, formatUsd, groupModelUsageByAgent } from "@/lib/usage";

export async function generateMetadata({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return { title: `Session ${sessionId}` };
}

export default async function SessionTimelinePage({
  params,
}: {
  params: Promise<{ projectId: string; sessionId: string }>;
}) {
  const { projectId, sessionId } = await params;
  const [events, session, usageEvents, nodes] = await Promise.all([
    getSessionEvents(sessionId),
    getSession(sessionId),
    getSessionUsage(sessionId),
    getSessionNodes(sessionId),
  ]);
  const usage = session.usage;
  const hasUsage = usage.status !== "none" && usage.status !== "missing";
  const agentUsage = groupModelUsageByAgent(usageEvents);
  const scheduleRun = session.scheduleRunId ? await getScheduleRun(session.scheduleRunId) : null;
  const durationMs = session.completedAt
    ? Date.parse(session.completedAt) - Date.parse(session.startedAt)
    : null;
  const hasDetails = agentUsage.length > 0 || nodes.length > 0;

  return (
    <div className="flex flex-col gap-4">
      {/* One card for the session's identity — what ran, when, and what it
          cost. The conversation below gets its own frame. */}
      <section className="flex flex-col gap-3 rounded-xl border p-5">
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">Session</h2>
              <StatusBadge status={session.status} />
            </div>
            <p className="font-mono text-xs text-muted-foreground">{sessionId}</p>
            <p className="text-xs text-muted-foreground">
              <DateTime value={session.startedAt} />
              {durationMs !== null && durationMs >= 0
                ? ` · ${formatTraceDuration(durationMs) || "<1 ms"}`
                : null}
              {` · ${events.length} ${events.length === 1 ? "event" : "events"}`}
            </p>
          </div>
          {hasUsage ? (
            <dl className="flex flex-wrap items-center gap-5 text-right">
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Tokens
                </dt>
                <dd className="font-mono text-xs font-semibold tabular-nums">
                  {formatTokenCount(usage.inputTokens + usage.outputTokens)}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  In / out
                </dt>
                <dd className="font-mono text-xs font-semibold tabular-nums">
                  {formatTokenCount(usage.inputTokens)} / {formatTokenCount(usage.outputTokens)}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Cache read
                </dt>
                <dd className="font-mono text-xs font-semibold tabular-nums">
                  {formatTokenCount(usage.cacheReadTokens)}
                </dd>
              </div>
              {usage.costUsd !== null ? (
                <div>
                  <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Cost
                  </dt>
                  <dd className="font-mono text-xs font-semibold tabular-nums">
                    {formatUsd(usage.costUsd)}
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </div>
        {session.error ? (
          <div className="border-t pt-3">
            <h3 className="text-sm font-medium">Failure</h3>
            <p className="mt-1 text-sm text-destructive">{session.error}</p>
          </div>
        ) : null}
        {scheduleRun ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 self-start rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs">
            <span className="font-medium">
              {scheduleRun.trigger === "cron" ? "Cron" : "Manual"} · {scheduleRun.scheduleKey}
            </span>
            {scheduleRun.trigger === "cron" ? (
              <span
                className="font-mono text-muted-foreground"
                title={describeScheduleCron(scheduleRun.version.cron)}
              >
                {scheduleRun.version.cron}
              </span>
            ) : null}
            <span className="text-muted-foreground">
              Run {scheduleRun.status.replaceAll("_", " ")}
            </span>
            {scheduleRun.missedTicks > 0 ? (
              <span className="text-muted-foreground">
                {scheduleRun.missedTicks} missed {scheduleRun.missedTicks === 1 ? "tick" : "ticks"}
              </span>
            ) : null}
            {scheduleRun.error ? (
              <span className="text-destructive">{scheduleRun.error}</span>
            ) : null}
            <Link
              className="font-medium underline-offset-4 hover:underline"
              href={`/projects/${projectId}/schedule-runs/${scheduleRun.id}`}
            >
              Run details
            </Link>
          </span>
        ) : null}
      </section>
      {hasDetails ? (
        <Collapsible defaultOpen={agentUsage.length > 1 || nodes.length > 1}>
          <CollapsibleTrigger className="group/details flex w-full items-center gap-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
            Details
            <ChevronDownIcon className="size-3.5 transition-transform group-data-[panel-open]/details:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="data-[ending-style]:animate-out data-[starting-style]:animate-in">
            <div className="grid gap-x-6 gap-y-4 pt-2 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              {agentUsage.length > 0 ? (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Usage by agent
                  </h3>
                  <div className="mt-2 overflow-x-auto rounded-xl border px-3">
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
                          <tr
                            className="border-t border-border"
                            key={`${agent.agentId ?? agent.agentName ?? "unknown"}-${index}`}
                          >
                            <td className="py-2 font-medium">
                              {agent.agentName ?? agent.agentId ?? "Unknown agent"}
                            </td>
                            <td className="py-2 text-right font-mono text-muted-foreground">
                              {agent.reportedSteps}
                              {agent.missingSteps > 0 ? ` + ${agent.missingSteps} missing` : ""}
                            </td>
                            <td className="py-2 text-right font-mono">
                              {formatTokenCount(agent.inputTokens)}
                            </td>
                            <td className="py-2 text-right font-mono">
                              {formatTokenCount(agent.outputTokens)}
                            </td>
                            <td className="py-2 text-right font-mono font-medium">
                              {formatTokenCount(agent.totalTokens)}
                            </td>
                            <td className="py-2 text-right font-mono text-muted-foreground">
                              {formatTokenCount(agent.cacheReadTokens)}
                            </td>
                            <td className="py-2 text-right font-mono text-muted-foreground">
                              {formatUsd(agent.costUsd)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
              {nodes.length > 0 ? (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Session tree
                  </h3>
                  <div className="mt-2 grid gap-2">
                    {nodes.map((node) => (
                      <div
                        className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 rounded-lg border border-border px-3 py-2 text-xs"
                        key={node.id}
                      >
                        <div className="min-w-0">
                          <div className="font-medium">
                            {node.parentNodeId ? "↳ " : ""}
                            {node.agentName ?? node.agentId ?? "Unknown agent"}
                          </div>
                          <div className="mt-1 truncate font-mono text-muted-foreground">
                            {node.eveSessionId}
                          </div>
                        </div>
                        <div className="text-right text-muted-foreground">
                          <div>{node.status}</div>
                          <div className="mt-1">
                            {node.observedModelId ?? node.modelId ?? node.channelKind ?? "local"}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      <SessionReplay events={events} nodes={nodes} />
    </div>
  );
}
