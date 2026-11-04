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
  test("ignores a different subagent than the one under test", () => {
    const watch = watchDelegatedTurn({ subagentName: "researcher" });

    watch.observe({ type: "child.opened", data: { name: "summarizer", sessionId: "wrun_x" } });
    watch.observe({ type: "turn.settled", data: { outcome: "completed", turnId: "turn_0" } });
    expect(watch.subagentCalled).toBe(false);
    expect(watch.settled).toBe(false);
  });

  test("a task that never opened a child is not delegation proof", () => {
    // The agent call can fail before its child session opens.
    const watch = watchDelegatedTurn({ subagentName: "researcher" });

    watch.observe({ type: "task.started", data: {} });
    watch.observe({ type: "turn.settled", data: { outcome: "completed", turnId: "turn_0" } });
    expect(watch.subagentCalled).toBe(false);
    expect(watch.turnCompleted).toBe(true);
    expect(watch.settled).toBe(false);
  });

  test("an ended session settles the delegation too", () => {
    const watch = watchDelegatedTurn();

    watch.observe({ type: "child.opened", data: { name: "anything", sessionId: "wrun_y" } });
    watch.observe({ type: "session.ended", data: { outcome: "completed" } });
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

  test("a turn that settles without completing is a failure", () => {
    const watch = watchDelegatedTurn({ subagentName: "researcher" });

    watch.observe({ type: "turn.settled", data: { outcome: "failed", turnId: "turn_0" } });
    expect(watch.turnFailed).toBe(true);
    expect(watch.turnCompleted).toBe(false);
    expect(watch.settled).toBe(true);
  });

  test("stream lines yield their commit facts, and nothing for transport lines", () => {
    expect(sessionStreamLineEvents({ at: 1, facts: [{ type: "turn.started", data: {} }] })).toEqual(
      [{ type: "turn.started", data: {} }],
    );
    expect(sessionStreamLineEvents({ $eve: "heartbeat" })).toEqual([]);
    expect(sessionStreamLineEvents({ progress: { data: { delta: "x" } } })).toEqual([]);
  });

  test("a completed turn is a turn.settled that completed", () => {
    expect(isCompletedTurnEvent({ type: "turn.settled", data: { outcome: "completed" } })).toBe(
      true,
    );
    expect(isCompletedTurnEvent({ type: "turn.settled", data: { outcome: "failed" } })).toBe(false);
    expect(isCompletedTurnEvent({ type: "turn.started", data: {} })).toBe(false);
  });
});
