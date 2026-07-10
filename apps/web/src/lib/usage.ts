import type { ModelUsageEvent, SessionTokenUsage } from "./api";

export type TokenUsageSummary = SessionTokenUsage & {
  totalTokens: number;
};

export type AgentUsageSummary = Omit<TokenUsageSummary, "status"> & {
  agentId: string | null;
  agentName: string | null;
};

const compactTokenFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

export function formatTokenCount(tokens: number): string {
  return compactTokenFormatter.format(tokens);
}

export function formatUsd(costUsd: number | null): string {
  return costUsd === null ? "—" : usdFormatter.format(costUsd);
}

export function summarizeTokenUsage(usages: readonly SessionTokenUsage[]): TokenUsageSummary {
  const summary: TokenUsageSummary = {
    status: "none",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    reportedSteps: 0,
    missingSteps: 0,
  };

  for (const usage of usages) {
    summary.inputTokens += usage.inputTokens;
    summary.outputTokens += usage.outputTokens;
    summary.cacheReadTokens += usage.cacheReadTokens;
    summary.cacheWriteTokens += usage.cacheWriteTokens;
    summary.reportedSteps += usage.reportedSteps;
    summary.missingSteps += usage.missingSteps;
    if (usage.costUsd !== null) {
      summary.costUsd = (summary.costUsd ?? 0) + usage.costUsd;
    }
  }

  summary.totalTokens = summary.inputTokens + summary.outputTokens;
  summary.status =
    summary.reportedSteps > 0
      ? summary.missingSteps > 0
        ? "partial"
        : "reported"
      : summary.missingSteps > 0
        ? "missing"
        : "none";
  return summary;
}

export function groupModelUsageByAgent(events: readonly ModelUsageEvent[]): AgentUsageSummary[] {
  const grouped = new Map<string, AgentUsageSummary>();

  for (const event of events) {
    const key = event.agentId ?? event.eveSessionId;
    const summary = grouped.get(key) ?? {
      agentId: event.agentId,
      agentName: event.agentName,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
      reportedSteps: 0,
      missingSteps: 0,
    };
    summary.inputTokens += event.inputTokens ?? 0;
    summary.outputTokens += event.outputTokens ?? 0;
    summary.cacheReadTokens += event.cacheReadTokens ?? 0;
    summary.cacheWriteTokens += event.cacheWriteTokens ?? 0;
    summary.totalTokens = summary.inputTokens + summary.outputTokens;
    if (event.costUsd !== null) {
      summary.costUsd = (summary.costUsd ?? 0) + event.costUsd;
    }
    if (event.usageReported) {
      summary.reportedSteps += 1;
    } else {
      summary.missingSteps += 1;
    }
    grouped.set(key, summary);
  }

  return [...grouped.values()].sort(
    (left, right) => right.totalTokens - left.totalTokens || (left.agentName ?? "").localeCompare(right.agentName ?? ""),
  );
}
