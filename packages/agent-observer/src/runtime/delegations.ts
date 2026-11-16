import { isDelegatedUsageRecord } from "@evelandhq/core/eve";
import { asRecord, asString } from "./values.js";

/**
 * The child session a re-reported `usage.recorded` belongs to, when that
 * child runs without the observer hook and so never reports the spend itself.
 */
export type UnobservedChildSpend = {
  sessionId: string;
  /** The subagent's name as the parent calls it (`filechild`, `crm__reviewer`). */
  agentName: string;
};

export type DelegationTracker = {
  /**
   * Follows one fact of a session's stream. `unobservedSubagents` names the
   * subagents of the session's agent that run without the observer hook. For a
   * `usage.recorded` that re-reports the spend of such a child, returns that
   * child.
   */
  observe(input: {
    sessionId: string;
    eventType: string;
    data: Record<string, unknown>;
    scope: Record<string, unknown> | undefined;
    unobservedSubagents: ReadonlySet<string>;
  }): UnobservedChildSpend | undefined;
};

type SessionDelegations = {
  /** Calls to a local unobserved subagent, by call id, with the task serving each. */
  calls: Map<string, { agentName: string; taskId?: string }>;
  /** The child session a call or task opened, by `call:<id>` or `task:<id>`. */
  children: Map<string, UnobservedChildSpend>;
};

/**
 * Sessions with an open delegation to an unobserved subagent. A session that
 * never ends keeps its entry, so the oldest is dropped past this bound.
 */
const defaultMaxSessions = 1024;

/**
 * Tracks which of a session's calls delegate to a subagent that runs without
 * the observer hook. eve gives a file-form subagent no hooks slot, so its
 * session's facts never reach the observer; the only report of what it spent
 * is the `usage.recorded` its parent writes against the call that opened it
 * (`owner: { callId }`), or after that call settled (`delegated-late`, scoped
 * to the child's task). Every other child records its own spend, so the
 * parent's record re-reports it and stays uncounted.
 *
 * The parent's own facts decide it: `call.requested` names the subagent and
 * whether it is remote, `call.started` the task that serves the call, and
 * `child.opened` the child session the call or task opened. Whether a
 * subagent runs with the hook is fixed when the Release is built (Eveland
 * injects it), so it is no guess. A call this process did not see requested
 * (the deployment restarted while the child ran) stays unattributed, which
 * leaves its spend uncounted rather than counted twice.
 */
export function createDelegationTracker(options: { maxSessions?: number } = {}): DelegationTracker {
  const maxSessions = Math.max(1, options.maxSessions ?? defaultMaxSessions);
  const sessions = new Map<string, SessionDelegations>();

  function delegationsOf(sessionId: string, create: boolean): SessionDelegations | undefined {
    const existing = sessions.get(sessionId);
    if (existing || !create) return existing;
    const created: SessionDelegations = { calls: new Map(), children: new Map() };
    sessions.set(sessionId, created);
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    return created;
  }

  return {
    observe({ sessionId, eventType, data, scope, unobservedSubagents }) {
      switch (eventType) {
        case "call.requested": {
          const callId = asString(data.callId);
          const capability = asRecord(data.capability);
          const agentName = asString(capability?.name);
          if (
            !callId ||
            !agentName ||
            capability?.kind !== "agent" ||
            capability.remote === true ||
            !unobservedSubagents.has(agentName)
          ) {
            return undefined;
          }
          delegationsOf(sessionId, true)!.calls.set(callId, { agentName });
          return undefined;
        }
        case "call.started": {
          const delegations = delegationsOf(sessionId, false);
          const callId = asString(data.callId);
          const taskId = asString(data.taskId);
          const call = callId ? delegations?.calls.get(callId) : undefined;
          if (!delegations || !callId || !taskId || !call) return undefined;
          call.taskId = taskId;
          // A later call to the same task reaches the child it already opened.
          const child = delegations.children.get(`call:${callId}`);
          if (child && !delegations.children.has(`task:${taskId}`)) {
            delegations.children.set(`task:${taskId}`, child);
          }
          return undefined;
        }
        case "child.opened": {
          const delegations = delegationsOf(sessionId, false);
          const childSessionId = asString(data.sessionId);
          if (!delegations || !childSessionId) return undefined;
          const owner = asRecord(data.owner);
          const ownerCallId = asString(owner?.callId);
          const call = ownerCallId ? delegations.calls.get(ownerCallId) : undefined;
          const ownerTaskId = asString(owner?.taskId) ?? call?.taskId;
          const agentName =
            call?.agentName ??
            (ownerTaskId
              ? [...delegations.calls.values()].find((entry) => entry.taskId === ownerTaskId)
                  ?.agentName
              : undefined);
          if (!agentName) return undefined;
          const child = { sessionId: childSessionId, agentName };
          if (call) delegations.children.set(`call:${ownerCallId}`, child);
          if (ownerTaskId) delegations.children.set(`task:${ownerTaskId}`, child);
          return undefined;
        }
        case "usage.recorded": {
          if (!isDelegatedUsageRecord(data)) return undefined;
          const delegations = delegationsOf(sessionId, false);
          if (!delegations) return undefined;
          const callId = asString(asRecord(data.owner)?.callId);
          if (callId) {
            const taskId = delegations.calls.get(callId)?.taskId;
            return (
              delegations.children.get(`call:${callId}`) ??
              (taskId ? delegations.children.get(`task:${taskId}`) : undefined)
            );
          }
          const taskId = asString(scope?.taskId);
          return taskId ? delegations.children.get(`task:${taskId}`) : undefined;
        }
        case "session.ended":
          sessions.delete(sessionId);
          return undefined;
        default:
          return undefined;
      }
    },
  };
}

/**
 * The process-wide tracker every hook in the process shares, so a policy
 * revision, which replaces the telemetry runtime, keeps what it learned.
 */
export const delegationTracker: DelegationTracker = createDelegationTracker();
