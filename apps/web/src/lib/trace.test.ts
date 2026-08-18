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
    remoteUrl: null,
    resolutionStatus: "observed",
    status: "completed",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe("buildSessionTrace", () => {
  test("classifies rows, pairs tool results onto the request row, and numbers turns", () => {
    const trace = buildSessionTrace(
      [
        event("session.started", { runtime: { agentId: "root" } }),
        event("turn.started", { turnId: "turn_0" }),
        event("message.received", { message: "hi", turnId: "turn_0" }),
        event("actions.requested", {
          actions: [
            { callId: "call_1", kind: "tool-call", toolName: "get_weather", input: { city: "b" } },
          ],
          turnId: "turn_0",
        }),
        event(
          "action.result",
          {
            result: {
              callId: "call_1",
              kind: "tool-result",
              output: "Sunny",
              usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
            status: "completed",
            turnId: "turn_0",
          },
          { atMs: 250 },
        ),
        event("message.completed", { message: "It is sunny.", turnId: "turn_0" }),
        event("turn.completed", { turnId: "turn_0" }),
        event("message.received", { message: "again", turnId: "turn_1" }),
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
    expect(tool?.usage?.outputTokens).toBe(2);

    expect(trace.rows.at(-1)?.turn).toBe(2);
    const preTurn = trace.rows[0]!;
    expect(preTurn.turn).toBeNull();
  });

  test("marks failed results and keeps unmatched results as their own rows", () => {
    const trace = buildSessionTrace(
      [
        event("actions.requested", {
          actions: [{ callId: "call_1", kind: "tool-call", toolName: "read", input: {} }],
          turnId: "turn_0",
        }),
        event("action.result", {
          result: { callId: "call_1", kind: "tool-result", output: null },
          status: "failed",
          error: { message: "ENOENT" },
          turnId: "turn_0",
        }),
        event("action.result", {
          result: { callId: "call_orphan", kind: "tool-result", toolName: "grep", output: "hit" },
          status: "completed",
          turnId: "turn_0",
        }),
      ],
      [],
    );

    expect(trace.rows).toHaveLength(2);
    expect(trace.rows[0]).toMatchObject({ status: "failed", errorText: "ENOENT" });
    expect(trace.rows[1]).toMatchObject({ role: "tool", name: "grep", result: "hit" });
  });

  test("attributes subagent rows with depth and agent name", () => {
    const trace = buildSessionTrace(
      [
        event("message.received", { message: "root", turnId: "turn_0" }, { sessionNodeId: "n1" }),
        event(
          "message.completed",
          { message: "child reply", turnId: "turn_0" },
          { sessionNodeId: "n2" },
        ),
        event("message.completed", { message: "detached", turnId: "turn_0" }),
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
        event("actions.requested", {
          actions: [{ callId: "call_1", kind: "tool-call", toolName: "bash", input: {} }],
          turnId: "turn_0",
        }),
        event("turn.cancelled", { turnId: "turn_0" }),
      ],
      [],
    );

    expect(trace.rows[0]).toMatchObject({ status: "cancelled", errorText: "Turn cancelled" });
    expect(trace.rows[1]).toMatchObject({ role: "lifecycle", status: "cancelled" });
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
