import { describe, expect, test } from "vitest";
import { formatTokenCount, formatUsd, groupModelUsageByAgent, summarizeTokenUsage } from "./usage";

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
