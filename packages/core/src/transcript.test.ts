import { describe, expect, test } from "vitest";
import {
  buildSessionTranscript,
  buildTranscriptTurns,
  turnToolCalls,
  type TranscriptSourceEvent,
  type TranscriptSourceNode,
} from "./transcript.js";

const at = (second: number) => `2026-07-13T05:00:0${second}.000Z`;

function event(type: string, payload: unknown, options: { second?: number; sessionNodeId?: string | null } = {}): TranscriptSourceEvent {
  return { type, payload, eventAt: at(options.second ?? 0), sessionNodeId: options.sessionNodeId ?? null };
}

describe("buildTranscriptTurns", () => {
  test("groups a turn with user message, paired tool call, assistant reply, and usage", () => {
    const turns = buildTranscriptTurns([
      event("session.started", { runtime: { agentId: "root", eveVersion: "0.22.1" } }),
      event("turn.started", { turnId: "turn_0" }),
      event("message.received", { message: "What is the weather?", parts: [{ type: "text", text: "What is the weather?" }], turnId: "turn_0" }),
      event("actions.requested", {
        actions: [{ callId: "call_1", kind: "tool-call", toolName: "get_weather", input: { city: "Berlin" } }],
        stepIndex: 0,
        turnId: "turn_0",
      }),
      event("action.result", {
        result: { callId: "call_1", kind: "tool-result", output: "Sunny, 24C", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        status: "completed",
        stepIndex: 0,
        turnId: "turn_0",
      }),
      event("step.completed", { finishReason: "tool-calls", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 }, turnId: "turn_0" }),
      event("message.completed", { finishReason: "stop", message: "It is sunny.", turnId: "turn_0" }),
      event("step.completed", { finishReason: "stop", usage: { inputTokens: 50, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 }, turnId: "turn_0" }),
      event("turn.completed", { turnId: "turn_0" }),
    ]);

    expect(turns).toHaveLength(1);
    const turn = turns[0]!;
    expect(turn.turnId).toBe("turn_0");
    expect(turn.userMessage).toBe("What is the weather?");
    expect(turn.assistantMessage).toBe("It is sunny.");
    expect(turn.status).toBe("completed");
    expect(turn.usage).toEqual({ inputTokens: 150, outputTokens: 50, cacheReadTokens: 5, cacheWriteTokens: 0 });
    expect(turn.items.map((item) => item.kind)).toEqual(["user", "tool", "assistant"]);

    const calls = turnToolCalls(turn);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      callId: "call_1",
      name: "get_weather",
      isSubagent: false,
      input: { city: "Berlin" },
      output: "Sunny, 24C",
      status: "completed",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  test("keeps unanswered tool calls pending and separates turns by turnId", () => {
    const turns = buildTranscriptTurns([
      event("message.received", { message: "First", turnId: "turn_0" }),
      event("message.completed", { message: "First reply", turnId: "turn_0" }),
      event("turn.completed", { turnId: "turn_0" }),
      event("message.received", { message: "Second", turnId: "turn_1" }),
      event("actions.requested", { actions: [{ callId: "call_9", kind: "tool-call", name: "slow_tool", input: {} }], turnId: "turn_1" }),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0]!.status).toBe("completed");
    expect(turns[1]!.status).toBe("incomplete");
    expect(turnToolCalls(turns[1]!)[0]).toMatchObject({ name: "slow_tool", status: "pending", output: null });
  });

  test("records eve 0.24.4 cancelled turns as cancelled, not incomplete", () => {
    const turns = buildTranscriptTurns([
      event("message.received", { message: "Long task", turnId: "turn_0" }),
      event("turn.cancelled", { sequence: 3, turnId: "turn_0" }),
    ]);

    expect(turns[0]!.status).toBe("cancelled");
    expect(turns[0]!.items.at(-1)).toMatchObject({ kind: "system", label: "Turn cancelled" });
  });

  test("falls back to text parts and records failures as system items", () => {
    const turns = buildTranscriptTurns([
      event("message.received", { parts: [{ type: "text", text: "Hi " }, { type: "text", text: "there" }], turnId: "turn_0" }),
      event("turn.failed", { error: { message: "model exploded" }, turnId: "turn_0" }),
    ]);

    expect(turns[0]!.userMessage).toBe("Hi there");
    expect(turns[0]!.status).toBe("failed");
    expect(turns[0]!.items.at(-1)).toMatchObject({ kind: "system", label: "Turn failed", text: "model exploded" });
  });
});

describe("buildSessionTranscript", () => {
  const nodes: TranscriptSourceNode[] = [
    { id: "node_root", parentNodeId: null, nodeId: null, agentId: "main", agentName: "Main agent", status: "completed" },
    { id: "node_child", parentNodeId: "node_root", nodeId: "subagents/researcher", agentId: null, agentName: "researcher", status: "completed" },
  ];

  const events: TranscriptSourceEvent[] = [
    event("message.received", { message: "Ask the researcher.", turnId: "turn_0" }, { sessionNodeId: "node_root" }),
    event(
      "actions.requested",
      { actions: [{ callId: "call_r", kind: "subagent-call", name: "researcher", nodeId: "subagents/researcher", subagentName: "researcher", input: { q: "streaming" } }], turnId: "turn_0" },
      { sessionNodeId: "node_root", second: 1 },
    ),
    event("message.received", { message: "Verify streaming.", turnId: "turn_0" }, { sessionNodeId: "node_child", second: 2 }),
    event("message.completed", { message: "Verified.", turnId: "turn_0" }, { sessionNodeId: "node_child", second: 3 }),
    event(
      "action.result",
      { result: { callId: "call_r", kind: "subagent-result", output: "Verified.", subagentName: "researcher" }, status: "completed", turnId: "turn_0" },
      { sessionNodeId: "node_root", second: 4 },
    ),
    event("message.completed", { message: "The researcher verified streaming.", turnId: "turn_0" }, { sessionNodeId: "node_root", second: 5 }),
  ];

  test("nests the subagent node transcript under the matching subagent call", () => {
    const transcript = buildSessionTranscript(events, nodes);

    expect(transcript.root?.agentName).toBe("Main agent");
    expect(transcript.detached).toHaveLength(0);

    const rootCalls = transcript.root!.turns.flatMap(turnToolCalls);
    expect(rootCalls).toHaveLength(1);
    expect(rootCalls[0]!.isSubagent).toBe(true);
    expect(rootCalls[0]!.child?.agentName).toBe("researcher");
    expect(rootCalls[0]!.child?.turns[0]).toMatchObject({ userMessage: "Verify streaming.", assistantMessage: "Verified." });
  });

  test("keeps unmatched subagent nodes as detached transcripts", () => {
    const transcript = buildSessionTranscript(
      events.filter((candidate) => candidate.type !== "actions.requested" && candidate.type !== "action.result"),
      nodes,
    );

    expect(transcript.detached).toHaveLength(1);
    expect(transcript.detached[0]!.agentName).toBe("researcher");
  });

  test("builds a root transcript from bare events when no nodes were recorded", () => {
    const transcript = buildSessionTranscript(
      [event("message.received", { message: "Hello", turnId: "turn_0" }, { sessionNodeId: null })],
      [],
    );

    expect(transcript.root?.turns[0]?.userMessage).toBe("Hello");
  });
});
