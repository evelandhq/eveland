/**
 * When a smoke may stop reading the root session stream of a turn that
 * delegates to a subagent.
 *
 * The session stream (protocol v27) sends commit lines whose `facts` carry
 * the events. The agent call is a `call.requested` whose capability kind is
 * `agent`; `child.opened` (with the agent's `name`) is the delegation proof --
 * a `task.started` alone is not, since the call can fail before the child
 * opens; the child runs inside the root turn, whose single `turn.settled`
 * reports the outcome. One captured 1.0.0-rc.1 root stream:
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
 * The events one decoded stream line carries: a commit line's facts, and
 * nothing for transport lines (heartbeats, progress).
 */
export function sessionStreamLineEvents(line: unknown): SessionStreamEvent[] {
  if (!line || typeof line !== "object" || Array.isArray(line)) return [];
  const { facts } = line as { facts?: unknown };
  return Array.isArray(facts) ? (facts as SessionStreamEvent[]) : [];
}

/** A turn that ended well: `turn.settled` with the `completed` outcome. */
export function isCompletedTurnEvent(event: SessionStreamEvent): boolean {
  return event.type === "turn.settled" && outcomeOf(event.data) === "completed";
}

export function watchDelegatedTurn(input: { subagentName?: string } = {}): DelegatedTurnWatch {
  let turnCompleted = false;
  let turnFailed = false;
  let subagentCalled = false;
  let idleAfterSubagentCall = false;

  return {
    observe(event) {
      if (event.type === "turn.settled" || event.type === "session.ended") {
        if (outcomeOf(event.data) === "completed") {
          if (event.type === "turn.settled") turnCompleted = true;
        } else {
          turnFailed = true;
        }
      }
      if (event.type === "child.opened" && matchesSubagent(event.data, input.subagentName)) {
        subagentCalled = true;
        return;
      }
      if (subagentCalled && (event.type === "turn.settled" || event.type === "session.ended"))
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

/** eve names the delegated agent on `child.opened` as `name`. */
function matchesSubagent(data: unknown, expected: string | undefined): boolean {
  if (expected === undefined) return true;
  if (!data || typeof data !== "object") return false;
  return (data as { name?: unknown }).name === expected;
}

function outcomeOf(data: unknown): unknown {
  return data && typeof data === "object" ? (data as { outcome?: unknown }).outcome : undefined;
}
