import { describe, expect, test } from "vitest";
import {
  isCompletedTurnEvent,
  sessionStreamLineEvents,
  watchDelegatedTurn,
} from "./delegated-turn.js";

/**
 * The orderings below are transcribed from real root-session streams captured
 * inside the Lima VM.
 */
describe("delegated turn watch", () => {
  test("settles when the session waits again after an inline subagent call", () => {
    const watch = watchDelegatedTurn({ subagentName: "researcher" });

    watch.observe({ type: "turn.started", data: { turnId: "turn_0" } });
    watch.observe({ type: "subagent.called", data: { name: "researcher" } });
    watch.observe({ type: "turn.completed", data: { turnId: "turn_0" } });
    expect(watch.settled).toBe(false);

    watch.observe({ type: "session.waiting", data: { wait: "next-user-message" } });
    expect(watch.subagentCalled).toBe(true);
    expect(watch.turnCompleted).toBe(true);
    expect(watch.settled).toBe(true);
  });

  test("a background-task delegation is not settled by the root turn's own boundary", () => {
    const watch = watchDelegatedTurn({ subagentName: "researcher" });

    // eve 0.51 returns a task handle from the subagent tool, so the root turn
    // finishes and the session waits before the child run has even started.
    watch.observe({
      type: "subagent.completed",
      data: {
        backgroundTask: { status: "working", taskId: "task_d4a9f69fd035" },
        callId: "call_researcher",
        subagentName: "researcher",
      },
    });
    watch.observe({ type: "turn.completed", data: { turnId: "turn_0" } });
    watch.observe({ type: "session.waiting", data: { wait: "next-user-message" } });

    expect(watch.turnCompleted).toBe(true);
    expect(watch.subagentCalled).toBe(false);
    expect(watch.settled).toBe(false);

    // The child run starts afterwards, driven by durable workflow steps.
    watch.observe({
      type: "subagent.called",
      data: {
        agentId: "ag_researcher:d4a9f69fd035",
        childSessionId: "wrun_01M1QPV2E9ACESFAKF415W",
        name: "researcher",
        toolName: "researcher",
      },
    });
    // Called, but its work — and the Connections it uses — is still ahead.
    expect(watch.settled).toBe(false);

    // The parent takes a follow-up turn delivering the child's result.
    watch.observe({ type: "turn.started", data: { turnId: "turn_1" } });
    watch.observe({
      type: "message.received",
      data: { message: "Background task task_d4a9f69fd035 (researcher) is completed." },
    });
    watch.observe({ type: "turn.completed", data: { turnId: "turn_1" } });
    expect(watch.settled).toBe(false);

    watch.observe({ type: "session.waiting", data: { wait: "next-user-message" } });
    expect(watch.settled).toBe(true);
  });

  test("an eve 0.69 agent task settles when the session waits after agent.started", () => {
    // 0.69 runs the agent call as a task inside the root turn: the call's
    // result is a receipt, the child is announced by `agent.started`, the turn
    // holds (`turn.waiting`) until `task.settled`, and only then completes.
    const watch = watchDelegatedTurn({ subagentName: "researcher" });

    watch.observe({ type: "turn.started", data: { turnId: "turn_0" } });
    watch.observe({
      type: "task.started",
      data: {
        callId: "call_r",
        kind: "agent",
        name: "researcher",
        taskId: "task_1",
        turnId: "turn_0",
      },
    });
    watch.observe({
      type: "action.result",
      data: { result: { callId: "call_r", output: "Started task task_1." }, status: "completed" },
    });
    // The receipt alone is not delegation proof: an agent call can still fail
    // before its session opens.
    expect(watch.subagentCalled).toBe(false);
    watch.observe({
      type: "agent.started",
      data: {
        callId: "call_r",
        name: "researcher",
        sessionId: "eve_child",
        taskId: "task_1",
        turnId: "turn_0",
      },
    });
    watch.observe({ type: "turn.waiting", data: { turnId: "turn_0", sequence: 7 } });
    expect(watch.subagentCalled).toBe(true);
    expect(watch.settled).toBe(false);

    watch.observe({
      type: "task.settled",
      data: {
        callId: "call_r",
        output: "found it",
        status: "completed",
        taskId: "task_1",
        turnId: "turn_0",
      },
    });
    watch.observe({ type: "turn.completed", data: { turnId: "turn_0" } });
    expect(watch.settled).toBe(false);
    watch.observe({ type: "session.waiting", data: {} });
    expect(watch.settled).toBe(true);
  });

  test("a background-task handle alone is never a delegation proof", () => {
    const watch = watchDelegatedTurn({ subagentName: "researcher" });

    watch.observe({
      type: "subagent.completed",
      data: { backgroundTask: { status: "working", taskId: "task_1" } },
    });
    watch.observe({ type: "turn.completed", data: { turnId: "turn_0" } });
    watch.observe({ type: "session.waiting", data: {} });

    expect(watch.settled).toBe(false);
  });

  test("ignores a different subagent than the one under test", () => {
    const watch = watchDelegatedTurn({ subagentName: "researcher" });

    watch.observe({ type: "subagent.called", data: { name: "summarizer" } });
    watch.observe({ type: "turn.completed", data: { turnId: "turn_0" } });
    watch.observe({ type: "session.waiting", data: {} });
    expect(watch.settled).toBe(false);

    watch.observe({ type: "subagent.called", data: { toolName: "researcher" } });
    watch.observe({ type: "session.waiting", data: {} });
    expect(watch.settled).toBe(true);
  });

  test("a completed session settles the delegation too", () => {
    const watch = watchDelegatedTurn();

    watch.observe({ type: "subagent.called", data: { name: "anything" } });
    expect(watch.settled).toBe(false);

    watch.observe({ type: "session.completed", data: {} });
    expect(watch.settled).toBe(true);
  });

  test("a failed turn settles the watch so the reader reports the failure", () => {
    const watch = watchDelegatedTurn({ subagentName: "researcher" });

    watch.observe({ type: "turn.failed", data: { turnId: "turn_0" } });
    expect(watch.turnFailed).toBe(true);
    expect(watch.settled).toBe(true);
  });

  test("an eve 1.0 (v27) agent call settles when the root turn settles after child.opened", () => {
    // Commit lines captured from an eve 1.0.0-rc.1 root session delegating to
    // the directory-form researcher (EVE_MOCK_AUTHORED_MODELS=1): the child
    // runs inside the root turn, so the turn settles after the child opened.
    const watch = watchDelegatedTurn({ subagentName: "researcher" });
    const lines = [
      {
        at: 1,
        facts: [
          { type: "session.started", data: {} },
          { type: "delivery.admitted", data: {} },
        ],
      },
      { at: 2, facts: [{ type: "turn.started", data: {}, scope: { turnId: "turn_0" } }] },
      {
        at: 3,
        facts: [
          {
            type: "call.requested",
            data: { callId: "call_researcher", capability: { kind: "agent", name: "researcher" } },
            scope: { runId: "run_0", turnId: "turn_0" },
          },
        ],
      },
      {
        at: 4,
        facts: [{ type: "task.started", data: {}, scope: { taskId: "researcher-vgy7sa" } }],
      },
      { $eve: "heartbeat" },
      {
        at: 5,
        facts: [
          {
            type: "child.opened",
            data: {
              name: "researcher",
              owner: { callId: "call_researcher" },
              sessionId: "wrun_child",
            },
            scope: { taskId: "researcher-vgy7sa", runId: "run_0", turnId: "turn_0" },
          },
        ],
      },
    ];
    for (const line of lines)
      for (const event of sessionStreamLineEvents(line)) watch.observe(event);
    expect(watch.subagentCalled).toBe(true);
    expect(watch.settled).toBe(false);

    for (const event of sessionStreamLineEvents({
      at: 6,
      facts: [
        { type: "call.settled", data: { callId: "call_researcher", outcome: "completed" } },
        { type: "turn.settled", data: { outcome: "completed", turnId: "turn_0" } },
        { type: "delivery.settled", data: { outcome: "handled", turnId: "turn_0" } },
      ],
    }))
      watch.observe(event);
    expect(watch.turnCompleted).toBe(true);
    expect(watch.turnFailed).toBe(false);
    expect(watch.settled).toBe(true);
  });

  test("a v27 turn that settles without completing is a failure", () => {
    const watch = watchDelegatedTurn({ subagentName: "researcher" });

    watch.observe({ type: "turn.settled", data: { outcome: "failed", turnId: "turn_0" } });
    expect(watch.turnFailed).toBe(true);
    expect(watch.turnCompleted).toBe(false);
    expect(watch.settled).toBe(true);
  });

  test("stream lines yield their v27 facts, or the v26 event itself, and nothing for transport lines", () => {
    expect(sessionStreamLineEvents({ type: "turn.completed", data: {} })).toEqual([
      { type: "turn.completed", data: {} },
    ]);
    expect(sessionStreamLineEvents({ at: 1, facts: [{ type: "turn.started", data: {} }] })).toEqual(
      [{ type: "turn.started", data: {} }],
    );
    expect(sessionStreamLineEvents({ $eve: "heartbeat" })).toEqual([]);
    expect(sessionStreamLineEvents({ progress: { data: { delta: "x" } } })).toEqual([]);
  });

  test("a completed turn is v26 turn.completed or a v27 turn.settled that completed", () => {
    expect(isCompletedTurnEvent({ type: "turn.completed", data: {} })).toBe(true);
    expect(isCompletedTurnEvent({ type: "turn.settled", data: { outcome: "completed" } })).toBe(
      true,
    );
    expect(isCompletedTurnEvent({ type: "turn.settled", data: { outcome: "failed" } })).toBe(false);
    expect(isCompletedTurnEvent({ type: "turn.started", data: {} })).toBe(false);
  });
});
