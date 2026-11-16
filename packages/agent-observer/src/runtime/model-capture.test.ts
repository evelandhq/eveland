import { describe, expect, test } from "vitest";
import { createModelCallCapture } from "./model-capture.js";

/** The fields eve 1.0 puts on every `model.call.*` instrumentation event. */
function scope(sessionId: string, runId: string): Record<string, unknown> {
  return {
    sessionId,
    rootSessionId: "wrun_root",
    runId,
    attempt: 0,
    turnId: "turn_0",
  };
}

function callStarted(sessionId: string, runId: string, modelId: string): Record<string, unknown> {
  return {
    type: "model.call.started",
    idempotencyKey: `model:${sessionId}:${runId}:0:0:0`,
    model: { modelId, provider: "gateway" },
    scope: scope(sessionId, runId),
  };
}

function callSettled(
  sessionId: string,
  runId: string,
  responseModelId?: string,
): Record<string, unknown> {
  return {
    type: "model.call.settled",
    outcome: "completed",
    finishReason: "stop",
    idempotencyKey: `model:${sessionId}:${runId}:0:0:0`,
    ...(responseModelId ? { responseModelId } : {}),
    usage: { inputTokens: 10, outputTokens: 5 },
    scope: scope(sessionId, runId),
  };
}

describe("model call capture", () => {
  test("names the model a run's provider call ran, keyed by session and run", () => {
    const capture = createModelCallCapture();
    capture.observe(callStarted("wrun_a", "run_0", "served/model-a"));
    capture.observe(callSettled("wrun_a", "run_0", "model-a-2026-11-01"));
    capture.observe(callStarted("wrun_b", "run_0", "served/model-b"));

    expect(capture.take({ sessionId: "wrun_a", runId: "run_0" })).toEqual({
      modelId: "served/model-a",
      responseModelId: "model-a-2026-11-01",
    });
    // Run ids repeat across sessions (every session starts at run_0), so a
    // child session's call never names its parent's model.
    expect(capture.take({ sessionId: "wrun_b", runId: "run_0" })).toEqual({
      modelId: "served/model-b",
    });
    expect(capture.take({ sessionId: "wrun_a", runId: "run_1" })).toBeUndefined();
  });

  test("keeps the run's model for every usage record the run reports", () => {
    // A run whose discarded attempt records usage reports twice under one run id.
    const capture = createModelCallCapture();
    capture.observe(callStarted("wrun_a", "run_0", "served/model-a"));

    expect(capture.take({ sessionId: "wrun_a", runId: "run_0" })?.modelId).toBe("served/model-a");
    expect(capture.take({ sessionId: "wrun_a", runId: "run_0" })?.modelId).toBe("served/model-a");
  });

  test("names the latest provider call when a run makes several", () => {
    const capture = createModelCallCapture();
    capture.observe(callStarted("wrun_a", "run_0", "served/first"));
    capture.observe(callSettled("wrun_a", "run_0", "first-2026"));
    capture.observe(callStarted("wrun_a", "run_0", "served/fallback"));

    expect(capture.take({ sessionId: "wrun_a", runId: "run_0" })).toEqual({
      modelId: "served/fallback",
    });
  });

  test("forgets the oldest runs past its bound", () => {
    const capture = createModelCallCapture({ maxRuns: 2 });
    capture.observe(callStarted("wrun_a", "run_0", "m0"));
    capture.observe(callStarted("wrun_a", "run_1", "m1"));
    capture.observe(callStarted("wrun_a", "run_2", "m2"));

    expect(capture.take({ sessionId: "wrun_a", runId: "run_0" })).toBeUndefined();
    expect(capture.take({ sessionId: "wrun_a", runId: "run_2" })?.modelId).toBe("m2");
  });

  test("ignores malformed events and never throws into eve's instrumentation bus", () => {
    const capture = createModelCallCapture();
    for (const event of [
      null,
      "model.call.started",
      { type: "model.call.started" },
      { type: "model.call.started", model: { modelId: 7 }, scope: scope("wrun_a", "run_0") },
      { type: "model.call.started", model: { modelId: "m" }, scope: { sessionId: "wrun_a" } },
      { type: "model.call.settled", outcome: "failed", scope: scope("wrun_a", "run_0") },
      { type: "call.requested", scope: scope("wrun_a", "run_0") },
    ]) {
      expect(() => capture.observe(event)).not.toThrow();
    }
    expect(capture.take({ sessionId: "wrun_a", runId: "run_0" })).toBeUndefined();
  });

  test("leaves the response model unset when a settle arrives for a run it never saw start", () => {
    const capture = createModelCallCapture();
    capture.observe(callSettled("wrun_a", "run_0", "orphan-2026"));
    expect(capture.take({ sessionId: "wrun_a", runId: "run_0" })).toBeUndefined();
  });
});
