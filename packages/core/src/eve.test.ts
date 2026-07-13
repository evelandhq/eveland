import { describe, expect, test } from "vitest";
import { extractEveResponseText, getEveString, isEveRecord, parseEveJsonObject, parseStepUsageEvent } from "./eve.js";

test("Eve wire helpers parse object payloads and preserve raw response fallback", () => {
  const parsed = parseEveJsonObject('{"sessionId":"eve_123","response":"hello"}');

  expect(isEveRecord(parsed)).toBe(true);
  expect(getEveString(parsed, "sessionId")).toBe("eve_123");
  expect(extractEveResponseText(parsed, "raw")).toBe("hello");
  expect(parseEveJsonObject("[]")).toBeNull();
  expect(parseEveJsonObject("not-json")).toBeNull();
  expect(extractEveResponseText(null, "raw")).toBe("raw");
});

describe("parseStepUsageEvent", () => {
  test("normalizes provider-reported usage from a completed model step", () => {
    expect(
      parseStepUsageEvent("step.completed", {
        turnId: "turn_2",
        stepIndex: 3,
        finishReason: "stop",
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          cacheReadTokens: 80,
          cacheWriteTokens: 10,
          costUsd: 0.0042,
        },
      }),
    ).toEqual({
      turnId: "turn_2",
      stepIndex: 3,
      finishReason: "stop",
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      costUsd: 0.0042,
      usageReported: true,
    });
  });

  test("keeps unavailable usage fields distinct from zero", () => {
    expect(
      parseStepUsageEvent("step.completed", {
        turnId: "turn_0",
        stepIndex: 0,
        finishReason: "tool-calls",
        usage: { inputTokens: 42 },
      }),
    ).toEqual({
      turnId: "turn_0",
      stepIndex: 0,
      finishReason: "tool-calls",
      inputTokens: 42,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      usageReported: true,
    });
  });

  test("records a completed step whose provider omitted usage", () => {
    expect(
      parseStepUsageEvent("step.completed", {
        turnId: "turn_0",
        stepIndex: 0,
        finishReason: "stop",
      }),
    ).toEqual({
      turnId: "turn_0",
      stepIndex: 0,
      finishReason: "stop",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      usageReported: false,
    });
  });

  test("ignores events that cannot identify a completed model step", () => {
    expect(parseStepUsageEvent("turn.completed", { turnId: "turn_0", stepIndex: 0 })).toBeNull();
    expect(parseStepUsageEvent("step.completed", { turnId: "turn_0" })).toBeNull();
  });
});
