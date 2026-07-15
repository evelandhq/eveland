import type { Session, SessionTokenUsage } from "@eveland/core/contracts";

export function summarizeSessionUsage(sessions: Session[]): SessionTokenUsage {
  const usage: SessionTokenUsage = {
    status: "none",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    reportedSteps: 0,
    missingSteps: 0,
  };
  for (const session of sessions) {
    usage.inputTokens += session.usage.inputTokens;
    usage.outputTokens += session.usage.outputTokens;
    usage.cacheReadTokens += session.usage.cacheReadTokens;
    usage.cacheWriteTokens += session.usage.cacheWriteTokens;
    if (session.usage.costUsd !== null) usage.costUsd = (usage.costUsd ?? 0) + session.usage.costUsd;
    usage.reportedSteps += session.usage.reportedSteps;
    usage.missingSteps += session.usage.missingSteps;
  }
  usage.status = usage.reportedSteps > 0
    ? usage.missingSteps > 0 ? "partial" : "reported"
    : usage.missingSteps > 0 ? "missing" : "none";
  return usage;
}
