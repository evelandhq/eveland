import { describe, expect, test } from "vitest";
import type { UsageTotals } from "@eveland/core/contracts";
import * as usageHelpers from "./usage";

const { formatTokenCount, formatUsd, groupModelUsageByAgent, summarizeTokenUsage } = usageHelpers;

const usageTotals = (overrides: Partial<UsageTotals> = {}): UsageTotals => ({
  sessions: 0,
  runningSessions: 0,
  waitingSessions: 0,
  completedSessions: 0,
  failedSessions: 0,
  modelSteps: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: null,
  reportedSteps: 0,
  missingSteps: 0,
  costReportedSteps: 0,
  ...overrides,
});

describe("summarizeTokenUsage", () => {
  test("aggregates token totals and provider coverage across sessions", () => {
    expect(
      summarizeTokenUsage([
        {
          status: "reported",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 60,
          cacheWriteTokens: 5,
          costUsd: 0.003,
          reportedSteps: 1,
          missingSteps: 0,
        },
        {
          status: "missing",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: null,
          reportedSteps: 0,
          missingSteps: 1,
        },
      ]),
    ).toEqual({
      status: "partial",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 60,
      cacheWriteTokens: 5,
      costUsd: 0.003,
      reportedSteps: 1,
      missingSteps: 1,
    });
  });

  test("formats token counts compactly for session tables", () => {
    expect(formatTokenCount(120)).toBe("120");
    expect(formatTokenCount(1_200)).toBe("1.2K");
    expect(formatTokenCount(1_200_000)).toBe("1.2M");
  });

  test("groups model-step usage by the agent that consumed it", () => {
    expect(
      groupModelUsageByAgent([
        {
          id: "usage_1",
          sessionId: "sess_1",
          eveSessionId: "eve_child",
          agentId: "agent_researcher",
          agentName: "Researcher",
          turnId: "turn_0",
          stepIndex: 0,
          finishReason: "tool-calls",
          inputTokens: 30,
          outputTokens: 4,
          cacheReadTokens: 20,
          cacheWriteTokens: null,
          costUsd: 0.002,
          usageReported: true,
          createdAt: "2026-07-10T00:00:00.000Z",
        },
        {
          id: "usage_2",
          sessionId: "sess_1",
          eveSessionId: "eve_child",
          agentId: "agent_researcher",
          agentName: "Researcher",
          turnId: "turn_0",
          stepIndex: 1,
          finishReason: "stop",
          inputTokens: 20,
          outputTokens: 6,
          cacheReadTokens: 10,
          cacheWriteTokens: null,
          costUsd: null,
          usageReported: true,
          createdAt: "2026-07-10T00:00:01.000Z",
        },
      ]),
    ).toEqual([
      {
        agentId: "agent_researcher",
        agentName: "Researcher",
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: 60,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
        costUsd: 0.002,
        reportedSteps: 2,
        missingSteps: 0,
      },
    ]);
  });

  test("formats optional gateway cost without inventing missing values", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(1.2)).toBe("$1.20");
  });
});

describe("usage analytics presentation", () => {
  test("keeps completion and reporting coverage denominators explicit", () => {
    const completionRate = Reflect.get(usageHelpers, "completionRate") as
      | ((totals: UsageTotals) => number | null)
      | undefined;
    const usageCoverage = Reflect.get(usageHelpers, "usageCoverage") as
      | ((totals: UsageTotals) => number | null)
      | undefined;
    const costCoverage = Reflect.get(usageHelpers, "costCoverage") as
      | ((totals: UsageTotals) => number | null)
      | undefined;

    expect(completionRate).toBeTypeOf("function");
    expect(usageCoverage).toBeTypeOf("function");
    expect(costCoverage).toBeTypeOf("function");
    expect(
      completionRate!(
        usageTotals({
          completedSessions: 8,
          failedSessions: 2,
          runningSessions: 3,
        }),
      ),
    ).toBe(80);
    expect(usageCoverage!(usageTotals({ reportedSteps: 3, missingSteps: 1 }))).toBe(75);
    expect(costCoverage!(usageTotals({ modelSteps: 4, costReportedSteps: 1 }))).toBe(25);
    expect(completionRate!(usageTotals())).toBeNull();
    expect(usageCoverage!(usageTotals())).toBeNull();
    expect(costCoverage!(usageTotals())).toBeNull();
  });

  test("reports period deltas without inventing a percentage from a zero baseline", () => {
    const percentageDelta = Reflect.get(usageHelpers, "percentageDelta") as
      | ((current: number, previous: number) => number | null)
      | undefined;

    expect(percentageDelta).toBeTypeOf("function");
    expect(percentageDelta!(120, 100)).toBe(20);
    expect(percentageDelta!(80, 100)).toBe(-20);
    expect(percentageDelta!(10, 0)).toBeNull();
  });

  test("normalizes shareable usage filters from page search parameters", () => {
    const parseUsageFilters = Reflect.get(usageHelpers, "parseUsageFilters") as
      | ((input: Record<string, string | string[] | undefined>) => {
          range: string;
          modelId?: string;
        })
      | undefined;

    expect(parseUsageFilters).toBeTypeOf("function");
    expect(parseUsageFilters!({ range: "24h", model: "openai/gpt-5-mini" })).toEqual({
      range: "24h",
      modelId: "openai/gpt-5-mini",
    });
    expect(parseUsageFilters!({ range: "forever", model: "  " })).toEqual({
      range: "7d",
    });
    expect(parseUsageFilters!({ range: ["30d", "7d"], model: ["anthropic/sonnet"] })).toEqual({
      range: "30d",
      modelId: "anthropic/sonnet",
    });
  });
});
