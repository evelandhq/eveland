import type { UsageRange, UsageTotals } from "@eveland/core/contracts";
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

export function completionRate(totals: UsageTotals): number | null {
  const terminalSessions =
    totals.completedSessions + totals.failedSessions;
  return terminalSessions === 0
    ? null
    : (totals.completedSessions / terminalSessions) * 100;
}

export function usageCoverage(totals: UsageTotals): number | null {
  const observedSteps = totals.reportedSteps + totals.missingSteps;
  return observedSteps === 0
    ? null
    : (totals.reportedSteps / observedSteps) * 100;
}

export function costCoverage(totals: UsageTotals): number | null {
  return totals.modelSteps === 0
    ? null
    : (totals.costReportedSteps / totals.modelSteps) * 100;
}

export function percentageDelta(
  current: number,
  previous: number,
): number | null {
  return previous === 0 ? null : ((current - previous) / previous) * 100;
}

export function parseUsageFilters(
  input: Record<string, string | string[] | undefined>,
): { range: UsageRange; modelId?: string } {
  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;
  const requestedRange = first(input.range);
  const range: UsageRange =
    requestedRange === "24h" ||
    requestedRange === "7d" ||
    requestedRange === "30d"
      ? requestedRange
      : "7d";
  const modelId = first(input.model)?.trim();
  return modelId ? { range, modelId } : { range };
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
