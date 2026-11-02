/**
 * When a smoke may stop reading the root session stream of a turn that
 * delegates to a subagent.
 *
 * Through eve 0.50 a subagent call ran inline inside the root turn, so
 * `subagent.called` and everything the child did arrived before
 * `turn.completed`. eve 0.51 dispatches every subagent call as a background
 * task, and the whole delegation now straddles the root turn's boundary. One
 * measured 0.51.1 stream, in order:
 *
 *   subagent.completed  { backgroundTask: { status: "working", taskId } }
 *   turn.completed      turn_0
 *   session.waiting
 *   subagent.called     { childSessionId, name }        (+157ms)
 *   turn.started        turn_1  "Background task … is completed. Result: …"
 *   turn.completed      turn_1
 *   session.waiting                                     (+428ms)
 *
 * So neither `turn.completed` nor the first `session.waiting` means the
 * delegation happened, and `subagent.called` alone does not mean the child has
 * done its work yet. The settle point is the session going idle *after* the
 * child was reported — that is the follow-up turn which delivers the child's
 * result, by which time the child has run.
 *
 * `subagent.completed` is deliberately not delegation proof: under 0.51 it is
 * emitted for the tool call that merely handed back the task handle, before
 * any child run exists.
 *
 * eve 0.69 removed the `subagent.*` events and background tasks. An agent call
 * is a task the root turn holds for: `task.started` and a text receipt, then
 * `agent.started` once the child session opens, `turn.waiting` while it
 * works, `task.settled` with its reply, and only then `turn.completed` and
 * `session.waiting`. `agent.started` is the delegation proof there (a
 * `task.started` alone is not: the call can fail before the child opens), and
 * the same "idle after the child was reported" settle point still holds.
 *
 * eve 0.84 (session protocol v27, the 1.0 line) streams commit lines whose
 * `facts` carry the events. The agent call is a `call.requested` whose
 * capability kind is `agent`; `child.opened` (with the agent's `name`) is the
 * delegation proof; the child runs inside the root turn, whose single
 * `turn.settled` reports the outcome. One captured 1.0.0-rc.1 root stream:
 *
 *   call.requested   { capability: { kind: "agent", name: "researcher" } }
 *   task.started
 *   child.opened     { name: "researcher", sessionId }
 *   call.settled     { outcome: "completed" }
 *   turn.settled     { outcome: "completed" }
 *
 * so the settle point is the root turn settling after the child opened.
 */
export type SessionStreamEvent = {
  type?: string;
  data?: unknown;
};

export type DelegatedTurnWatch = {
  /** Feed every decoded stream event, in arrival order. */
  observe(event: SessionStreamEvent): void;
  /** A root turn reached its own boundary. */
  readonly turnCompleted: boolean;
  /** A turn ended in failure; the reader should surface that. */
  readonly turnFailed: boolean;
  /** A child run for the delegated subagent was reported. */
  readonly subagentCalled: boolean;
  /**
   * The only safe point to stop reading a delegating turn's stream: the
   * session went idle after the delegated child was reported (or a turn
   * failed, which no amount of further reading will improve).
   */
  readonly settled: boolean;
};

/**
 * The events one decoded stream line carries: a v27 commit line's facts, a v26
 * event itself, and nothing for transport lines (heartbeats, progress).
 */
export function sessionStreamLineEvents(line: unknown): SessionStreamEvent[] {
  if (!line || typeof line !== "object" || Array.isArray(line)) return [];
  const { facts, type } = line as { facts?: unknown; type?: unknown };
  if (Array.isArray(facts)) return facts as SessionStreamEvent[];
  return typeof type === "string" ? [line as SessionStreamEvent] : [];
}

/** A turn that ended well: v26 `turn.completed`, or v27 `turn.settled` completed. */
export function isCompletedTurnEvent(event: SessionStreamEvent): boolean {
  return (
    event.type === "turn.completed" ||
    (event.type === "turn.settled" && outcomeOf(event.data) === "completed")
  );
}

export function watchDelegatedTurn(input: { subagentName?: string } = {}): DelegatedTurnWatch {
  let turnCompleted = false;
  let turnFailed = false;
  let subagentCalled = false;
  let idleAfterSubagentCall = false;

  return {
    observe(event) {
      if (event.type === "turn.completed") turnCompleted = true;
      if (event.type === "turn.failed" || event.type === "session.failed") turnFailed = true;
      if (event.type === "turn.settled" || event.type === "session.ended") {
        if (outcomeOf(event.data) === "completed") {
          if (event.type === "turn.settled") turnCompleted = true;
        } else {
          turnFailed = true;
        }
      }
      if (
        (event.type === "subagent.called" ||
          event.type === "agent.started" ||
          event.type === "child.opened") &&
        matchesSubagent(event.data, input.subagentName)
      ) {
        subagentCalled = true;
        return;
      }
      if (
        subagentCalled &&
        (event.type === "session.waiting" ||
          event.type === "session.completed" ||
          event.type === "turn.settled" ||
          event.type === "session.ended")
      )
        idleAfterSubagentCall = true;
    },
    get turnCompleted() {
      return turnCompleted;
    },
    get turnFailed() {
      return turnFailed;
    },
    get subagentCalled() {
      return subagentCalled;
    },
    get settled() {
      return turnFailed || (subagentCalled && idleAfterSubagentCall);
    },
  };
}

/**
 * eve names the delegated agent on `subagent.called`, `agent.started`, and v27's
 * `child.opened` as `name`; `toolName`
 * carries the same value on 0.51 and is accepted so the match does not depend
 * on which of the two a given line in the window happens to populate.
 */
function matchesSubagent(data: unknown, expected: string | undefined): boolean {
  if (expected === undefined) return true;
  if (!data || typeof data !== "object") return false;
  const { name, toolName } = data as { name?: unknown; toolName?: unknown };
  return name === expected || toolName === expected;
}

function outcomeOf(data: unknown): unknown {
  return data && typeof data === "object" ? (data as { outcome?: unknown }).outcome : undefined;
}
