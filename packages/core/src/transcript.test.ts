import { describe, expect, test } from "vitest";
import {
  buildSessionTranscript,
  buildTranscriptTurns,
  groupTranscriptItems,
  turnToolCalls,
  type TranscriptSourceEvent,
  type TranscriptSourceNode,
} from "./transcript.js";

const at = (second: number) => `2026-07-13T05:00:0${second}.000Z`;

function event(
  type: string,
  payload: unknown,
  options: { second?: number; sessionNodeId?: string | null } = {},
): TranscriptSourceEvent {
  return {
    type,
    payload,
    eventAt: at(options.second ?? 0),
    sessionNodeId: options.sessionNodeId ?? null,
  };
}

describe("buildTranscriptTurns", () => {
  const at = "2026-11-02T00:00:00.000Z";
  const fact = (type: string, payload: Record<string, unknown>) => ({ type, payload, eventAt: at });

  test("builds the same turn from delivery, content, calls, usage, and the settled outcome", () => {
    const [turn] = buildTranscriptTurns([
      fact("turn.started", { turnId: "turn_1" }),
      fact("delivery.consumed", { turnId: "turn_1", parts: [{ kind: "text", text: "Weather?" }] }),
      fact("content.completed", {
        turnId: "turn_1",
        kind: "reasoning",
        phase: "narration",
        value: "Look it up.",
      }),
      fact("call.requested", {
        turnId: "turn_1",
        callId: "call_1",
        owner: { runId: "run_1" },
        capability: { kind: "tool", name: "get_weather" },
        input: { city: "Paris" },
      }),
      fact("call.requested", {
        turnId: "turn_1",
        callId: "call_wait",
        capability: { kind: "control", name: "eve__task_wait" },
      }),
      fact("usage.recorded", {
        turnId: "turn_1",
        kind: "model",
        owner: { runId: "run_1" },
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
      fact("usage.recorded", {
        turnId: "turn_1",
        kind: "model",
        owner: { callId: "call_1" },
        usage: { inputTokens: 99, outputTokens: 99, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
      fact("call.settled", {
        turnId: "turn_1",
        callId: "call_1",
        outcome: "completed",
        output: { temp: 21 },
      }),
      fact("content.completed", { turnId: "turn_1", kind: "text", phase: "reply", value: "21C." }),
      fact("turn.settled", { turnId: "turn_1", outcome: "completed" }),
    ]);

    expect(turn).toMatchObject({
      turnId: "turn_1",
      userMessage: "Weather?",
      assistantMessage: "21C.",
      status: "completed",
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(turn!.items.map((item) => item.kind)).toEqual([
      "user",
      "reasoning",
      "tool",
      "assistant",
    ]);
    expect(turnToolCalls(turn!)).toEqual([
      expect.objectContaining({
        callId: "call_1",
        name: "get_weather",
        status: "completed",
        input: { city: "Paris" },
        output: { temp: 21 },
      }),
    ]);
  });

  test("counts a decision's and an auxiliary call's spend on the turn, not a child's re-report", () => {
    const usage = (inputTokens: number) => ({
      inputTokens,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const [turn] = buildTranscriptTurns([
      fact("usage.recorded", {
        turnId: "turn_1",
        kind: "model",
        owner: { runId: "run_1" },
        usage: usage(10),
      }),
      fact("usage.recorded", { turnId: "turn_1", kind: "decision", usage: usage(100) }),
      fact("usage.recorded", {
        turnId: "turn_1",
        kind: "auxiliary",
        owner: { callId: "call_1" },
        usage: usage(1000),
      }),
      fact("usage.recorded", {
        turnId: "turn_1",
        kind: "model",
        owner: { callId: "call_2" },
        usage: usage(9),
      }),
      fact("usage.recorded", { turnId: "turn_1", kind: "delegated-late", usage: usage(9) }),
    ]);

    expect(turn!.usage).toEqual({
      inputTokens: 1110,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("keeps unanswered calls pending and separates turns by turnId", () => {
    const turns = buildTranscriptTurns([
      fact("delivery.consumed", { turnId: "turn_0", parts: [{ kind: "text", text: "First" }] }),
      fact("content.completed", { turnId: "turn_0", kind: "text", phase: "reply", value: "Done" }),
      fact("turn.settled", { turnId: "turn_0", outcome: "completed" }),
      fact("delivery.consumed", { turnId: "turn_1", parts: [{ kind: "text", text: "Second" }] }),
      fact("call.requested", {
        turnId: "turn_1",
        callId: "call_9",
        capability: { kind: "tool", name: "slow_tool" },
        input: {},
      }),
    ]);

    expect(turns.map((turn) => [turn.turnId, turn.userMessage, turn.status])).toEqual([
      ["turn_0", "First", "completed"],
      ["turn_1", "Second", "incomplete"],
    ]);
    expect(turnToolCalls(turns[1]!)[0]).toMatchObject({
      name: "slow_tool",
      status: "pending",
      output: null,
    });
  });

  test("records failures, cancellations, sign-ins, and the child a call opened", () => {
    const turns = buildTranscriptTurns([
      fact("call.requested", {
        turnId: "turn_1",
        callId: "call_agent",
        capability: { kind: "agent", name: "researcher" },
      }),
      fact("child.opened", {
        turnId: "turn_1",
        sessionId: "eve_child",
        owner: { callId: "call_agent" },
        name: "researcher",
      }),
      fact("interaction.opened", {
        turnId: "turn_1",
        interactionId: "int_1",
        request: {
          kind: "sign-in",
          prompt: "Sign in",
          signIn: { name: "gh", displayName: "GitHub" },
        },
      }),
      fact("interaction.settled", {
        turnId: "turn_1",
        interactionId: "int_1",
        outcome: "accepted",
      }),
      fact("turn.settled", { turnId: "turn_1", outcome: "cancelled" }),
      fact("model.settled", {
        turnId: "turn_2",
        runId: "run_9",
        outcome: "failed",
        error: { code: "X", message: "model down" },
      }),
      fact("turn.settled", {
        turnId: "turn_2",
        outcome: "failed",
        error: { code: "X", message: "turn down" },
      }),
    ]);

    expect(turns[0]).toMatchObject({ status: "cancelled" });
    expect(turnToolCalls(turns[0]!)[0]).toMatchObject({
      isSubagent: true,
      childEveSessionId: "eve_child",
      status: "cancelled",
    });
    expect(turns[0]!.items.filter((item) => item.kind === "system")).toEqual([
      expect.objectContaining({ label: "Authorization required", text: "GitHub" }),
      expect.objectContaining({ label: "Authorization completed", text: "accepted" }),
      expect.objectContaining({ label: "Turn cancelled" }),
    ]);
    expect(turns[1]).toMatchObject({ status: "failed" });
    expect(turns[1]!.items).toEqual([
      expect.objectContaining({ label: "Step failed", text: "model down" }),
      expect.objectContaining({ label: "Turn failed", text: "turn down" }),
    ]);
  });
});

describe("groupTranscriptItems", () => {
  const delivery = (text: string, second = 0) =>
    event("delivery.consumed", { turnId: "turn_0", parts: [{ kind: "text", text }] }, { second });
  const reply = (value: string, second: number) =>
    event(
      "content.completed",
      { turnId: "turn_0", kind: "text", phase: "reply", value },
      { second },
    );
  const call = (callId: string, name: string, second: number) =>
    event(
      "call.requested",
      { turnId: "turn_0", callId, capability: { kind: "tool", name }, input: {} },
      { second },
    );
  const settled = (callId: string, outcome: string, second: number, error?: string) =>
    event(
      "call.settled",
      {
        turnId: "turn_0",
        callId,
        outcome,
        ...(error ? { error: { code: "E", message: error } } : { output: "Found it" }),
      },
      { second },
    );

  test("collapses consecutive reasoning and tool items into one activity group", () => {
    const [turn] = buildTranscriptTurns([
      delivery("Investigate it"),
      event(
        "content.completed",
        { turnId: "turn_0", kind: "reasoning", value: "I should inspect the repository." },
        { second: 1 },
      ),
      call("call_1", "search", 2),
      settled("call_1", "completed", 3),
      reply("Here is what I found.", 4),
      event("turn.settled", { turnId: "turn_0", outcome: "completed" }, { second: 5 }),
    ]);

    expect(groupTranscriptItems(turn!)).toEqual([
      expect.objectContaining({ kind: "user", text: "Investigate it" }),
      {
        kind: "activity",
        status: "completed",
        items: [
          expect.objectContaining({ kind: "reasoning" }),
          expect.objectContaining({
            kind: "tool",
            call: expect.objectContaining({ name: "search", status: "completed" }),
          }),
        ],
      },
      expect.objectContaining({ kind: "assistant", text: "Here is what I found." }),
    ]);
  });

  test("keeps separate activity groups on either side of an assistant message", () => {
    const [turn] = buildTranscriptTurns([
      delivery("Start"),
      call("call_1", "first", 1),
      reply("Intermediate update", 2),
      call("call_2", "second", 3),
    ]);

    expect(groupTranscriptItems(turn!).map((item) => item.kind)).toEqual([
      "user",
      "activity",
      "assistant",
      "activity",
    ]);
    expect(groupTranscriptItems(turn!)).toMatchObject([
      {},
      { status: "running", items: [{ call: { name: "first" } }] },
      {},
      { status: "running", items: [{ call: { name: "second" } }] },
    ]);
  });

  test("marks an activity group failed when one of its tools fails", () => {
    const [turn] = buildTranscriptTurns([
      delivery("Try it"),
      call("call_1", "deploy", 0),
      settled("call_1", "failed", 1, "boom"),
      event(
        "turn.settled",
        { turnId: "turn_0", outcome: "failed", error: { code: "E", message: "boom" } },
        { second: 2 },
      ),
    ]);

    expect(groupTranscriptItems(turn!)).toMatchObject([{}, { kind: "activity", status: "failed" }]);
  });

  test("keeps trailing activity running until the turn settles", () => {
    const [turn] = buildTranscriptTurns([
      delivery("Keep going"),
      call("call_1", "search", 0),
      settled("call_1", "completed", 1),
    ]);

    expect(groupTranscriptItems(turn!)).toMatchObject([
      {},
      { kind: "activity", status: "running" },
    ]);
  });
});

describe("buildSessionTranscript", () => {
  const nodes: TranscriptSourceNode[] = [
    {
      id: "node_root",
      eveSessionId: "eve_root",
      parentNodeId: null,
      nodeId: null,
      agentId: "main",
      agentName: "Main agent",
      status: "completed",
    },
    {
      id: "node_child",
      eveSessionId: "eve_child",
      parentNodeId: "node_root",
      nodeId: null,
      agentId: null,
      agentName: "researcher",
      status: "completed",
    },
  ];
  const root = { sessionNodeId: "node_root" };
  const child = { sessionNodeId: "node_child" };

  const events: TranscriptSourceEvent[] = [
    event(
      "delivery.consumed",
      { turnId: "turn_0", parts: [{ kind: "text", text: "Ask the researcher." }] },
      root,
    ),
    event(
      "call.requested",
      {
        turnId: "turn_0",
        callId: "call_r",
        capability: { kind: "agent", name: "researcher" },
        input: { q: "streaming" },
      },
      { ...root, second: 1 },
    ),
    event(
      "child.opened",
      { turnId: "turn_0", sessionId: "eve_child", owner: { callId: "call_r" }, name: "researcher" },
      { ...root, second: 1 },
    ),
    event(
      "delivery.consumed",
      { turnId: "turn_c", parts: [{ kind: "text", text: "Verify streaming." }] },
      { ...child, second: 2 },
    ),
    event(
      "content.completed",
      { turnId: "turn_c", kind: "text", phase: "reply", value: "Verified." },
      { ...child, second: 3 },
    ),
    event(
      "call.settled",
      { turnId: "turn_0", callId: "call_r", outcome: "completed", output: "Verified." },
      { ...root, second: 4 },
    ),
    event(
      "content.completed",
      {
        turnId: "turn_0",
        kind: "text",
        phase: "reply",
        value: "The researcher verified streaming.",
      },
      { ...root, second: 5 },
    ),
  ];

  test("nests a child session's transcript under the call that opened it", () => {
    const transcript = buildSessionTranscript(events, nodes);

    expect(transcript.root?.agentName).toBe("Main agent");
    expect(transcript.detached).toHaveLength(0);

    const rootCalls = transcript.root!.turns.flatMap(turnToolCalls);
    expect(rootCalls).toHaveLength(1);
    expect(rootCalls[0]).toMatchObject({ isSubagent: true, output: "Verified." });
    expect(rootCalls[0]!.child?.sessionNodeId).toBe("node_child");
    expect(rootCalls[0]!.child?.turns[0]).toMatchObject({
      userMessage: "Verify streaming.",
      assistantMessage: "Verified.",
    });
  });

  test("keeps a child no call opened as a detached transcript", () => {
    const transcript = buildSessionTranscript(
      events.filter((candidate) => candidate.type !== "child.opened"),
      nodes,
    );

    expect(transcript.detached).toHaveLength(1);
    expect(transcript.detached[0]!.agentName).toBe("researcher");
  });

  test("preserves unresolved remote subagent state for the replay UI", () => {
    const transcript = buildSessionTranscript(
      events.filter((candidate) => candidate.sessionNodeId === "node_root"),
      [nodes[0]!, { ...nodes[1]!, resolutionStatus: "unresolved" }],
    );

    expect(turnToolCalls(transcript.root!.turns[0]!)[0]!.child).toMatchObject({
      resolutionStatus: "unresolved",
      turns: [],
    });
  });

  test("builds a root transcript from bare events when no nodes were recorded", () => {
    const transcript = buildSessionTranscript(
      [
        event(
          "delivery.consumed",
          { turnId: "turn_0", parts: [{ kind: "text", text: "Hello" }] },
          { sessionNodeId: null },
        ),
      ],
      [],
    );

    expect(transcript.root?.turns[0]?.userMessage).toBe("Hello");
  });
});
