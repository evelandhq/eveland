import { describe, expect, test } from "vitest";
import type { SessionEvent, SessionNode } from "./api";
import { buildSessionTrace, formatTraceDuration, traceRowPreview } from "./trace";

let index = 0;

function event(
  type: string,
  payload: unknown,
  options: { atMs?: number; sessionNodeId?: string | null } = {},
): SessionEvent {
  index += 1;
  return {
    id: `evt_${index}`,
    sessionId: "sess_1",
    index,
    type,
    payload,
    sessionNodeId: options.sessionNodeId ?? null,
    telemetryEventId: null,
    eventFingerprint: null,
    observedDeploymentId: null,
    observedRuntimeInstanceId: null,
    sourceSequence: null,
    eventAt: new Date(Date.UTC(2026, 6, 13, 5, 0, 0, options.atMs ?? 0)).toISOString(),
    createdAt: new Date(Date.UTC(2026, 6, 13, 5, 0, 0, options.atMs ?? 0)).toISOString(),
  };
}

function node(id: string, parentNodeId: string | null, agentName: string | null): SessionNode {
  return {
    id,
    rootSessionId: "sess_1",
    projectId: "proj_1",
    eveSessionId: `eve_${id}`,
    parentNodeId,
    parentEveSessionId: parentNodeId ? `eve_${parentNodeId}` : null,
    startedDeploymentId: "dep_1",
    lastObservedDeploymentId: "dep_1",
    startedRuntimeInstanceId: null,
    lastObservedRuntimeInstanceId: null,
    agentId: agentName,
    agentName,
    nodeId: id,
    channelKind: null,
    modelId: null,
    observedModelId: null,
    eveVersion: null,
    resolutionStatus: "observed",
    status: "completed",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe("buildSessionTrace", () => {
  const delivery = (turnId: string, text: string, options = {}) =>
    event("delivery.consumed", { turnId, parts: [{ kind: "text", text }] }, options);
  const reply = (turnId: string, value: string, options = {}) =>
    event("content.completed", { turnId, kind: "text", phase: "reply", value }, options);
  const call = (turnId: string, callId: string, name: string, options = {}) =>
    event(
      "call.requested",
      { turnId, callId, capability: { kind: "tool", name }, input: { city: "b" } },
      options,
    );

  test("classifies rows, pairs settled calls onto the request row, and numbers turns", () => {
    const trace = buildSessionTrace(
      [
        event("session.started", { runtime: { agentId: "root" } }),
        event("turn.started", { turnId: "turn_0" }),
        delivery("turn_0", "hi"),
        call("turn_0", "call_1", "get_weather"),
        event(
          "call.settled",
          { turnId: "turn_0", callId: "call_1", outcome: "completed", output: "Sunny" },
          { atMs: 250 },
        ),
        reply("turn_0", "It is sunny."),
        event("turn.settled", { turnId: "turn_0", outcome: "completed" }),
        delivery("turn_1", "again"),
      ],
      [],
    );

    expect(trace.turnCount).toBe(2);
    expect(trace.rows.map((row) => row.role)).toEqual([
      "lifecycle",
      "lifecycle",
      "user",
      "tool",
      "assistant",
      "lifecycle",
      "user",
    ]);

    const tool = trace.rows.find((row) => row.role === "tool");
    expect(tool).toMatchObject({
      name: "get_weather",
      status: "completed",
      payload: { city: "b" },
      result: "Sunny",
      durationMs: 250,
      turn: 1,
    });

    expect(trace.rows.at(-1)?.turn).toBe(2);
    const preTurn = trace.rows[0]!;
    expect(preTurn.turn).toBeNull();
  });

  test("attributes subagent rows with depth and agent name", () => {
    const trace = buildSessionTrace(
      [
        delivery("turn_0", "root", { sessionNodeId: "n1" }),
        reply("turn_0", "child reply", { sessionNodeId: "n2" }),
        reply("turn_0", "detached"),
      ],
      [node("n1", null, "root-agent"), node("n2", "n1", "Explore")],
    );

    expect(trace.rows[0]).toMatchObject({ depth: 0, agentName: null });
    expect(trace.rows[1]).toMatchObject({ depth: 1, agentName: "Explore" });
    expect(trace.rows[2]).toMatchObject({ depth: 0, agentName: null });
  });

  test("cancelling a turn cancels its pending tool rows", () => {
    const trace = buildSessionTrace(
      [
        call("turn_0", "call_1", "bash"),
        event("turn.settled", { turnId: "turn_0", outcome: "cancelled" }),
      ],
      [],
    );

    expect(trace.rows[0]).toMatchObject({ status: "cancelled", errorText: "Turn cancelled" });
    expect(trace.rows[1]).toMatchObject({ role: "lifecycle", status: "cancelled" });
  });

  test("builds user, reasoning, tool, usage, and assistant rows and records failures", () => {
    const trace = buildSessionTrace(
      [
        event("turn.started", { turnId: "turn_1" }),
        event("delivery.consumed", { turnId: "turn_1", parts: [{ kind: "text", text: "Hi" }] }),
        event("content.completed", {
          turnId: "turn_1",
          kind: "reasoning",
          phase: "narration",
          value: "hmm",
        }),
        event(
          "call.requested",
          {
            turnId: "turn_1",
            callId: "call_1",
            capability: { kind: "tool", name: "search" },
            input: { q: "x" },
          },
          { atMs: 10 },
        ),
        event("call.requested", {
          turnId: "turn_1",
          callId: "call_c",
          capability: { kind: "control", name: "eve__task_wait" },
        }),
        event(
          "call.settled",
          {
            turnId: "turn_1",
            callId: "call_1",
            outcome: "failed",
            error: { code: "E", message: "no hits" },
          },
          { atMs: 250 },
        ),
        event("usage.recorded", {
          turnId: "turn_1",
          owner: { runId: "run_1" },
          usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
        event("content.completed", {
          turnId: "turn_1",
          kind: "text",
          phase: "reply",
          value: "Hello",
        }),
        event("turn.settled", {
          turnId: "turn_1",
          outcome: "failed",
          error: { code: "X", message: "boom" },
        }),
      ],
      [],
    );

    expect(trace.turnCount).toBe(1);
    expect(trace.rows.map((row) => [row.role, row.type])).toEqual([
      ["lifecycle", "turn.started"],
      ["user", "delivery.consumed"],
      ["reasoning", "content.completed"],
      ["tool", "call.requested"],
      ["lifecycle", "usage.recorded"],
      ["assistant", "content.completed"],
      ["lifecycle", "turn.settled"],
    ]);
    const tool = trace.rows.find((row) => row.role === "tool")!;
    expect(tool).toMatchObject({
      name: "search",
      status: "failed",
      errorText: "no hits",
      durationMs: 240,
    });
    expect(trace.rows.find((row) => row.type === "usage.recorded")?.usage).toMatchObject({
      inputTokens: 5,
    });
    expect(trace.rows.at(-1)).toMatchObject({ status: "failed", errorText: "boom" });
  });
});

describe("traceRowPreview", () => {
  test("flattens whitespace and truncates", () => {
    expect(traceRowPreview("a\n  b\tc")).toBe("a b c");
    expect(traceRowPreview({ a: 1 })).toBe('{"a":1}');
    expect(traceRowPreview("x".repeat(200), 10)).toBe("xxxxxxxxx…");
    expect(traceRowPreview(null)).toBe("");
  });
});

describe("formatTraceDuration", () => {
  test("formats ms, seconds, and minutes", () => {
    expect(formatTraceDuration(86)).toBe("86 ms");
    expect(formatTraceDuration(2400)).toBe("2.4 s");
    expect(formatTraceDuration(18400)).toBe("18 s");
    expect(formatTraceDuration(84000)).toBe("1 min 24 s");
    expect(formatTraceDuration(null)).toBe("");
  });
});
