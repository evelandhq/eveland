import { describe, expect, test } from "vitest";
import { watchDelegatedTurn } from "./delegated-turn.js";

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
});
