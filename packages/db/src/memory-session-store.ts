import type { ModelUsageEvent, Session, SessionEvent } from "@eveland/core/contracts";
import { createId } from "@eveland/core/ids";
import {
  addUsageToSession,
  emptySessionTokenUsage,
  ingestMemoryObserverEnvelope,
  mergeMemorySessions,
} from "./memory-observer-store.js";
import type { MemoryState } from "./memory-state.js";
import type { MemoryDomain } from "./memory-store-support.js";
import { summarizeSessionUsage } from "./session-usage.js";
import type { SessionStore } from "./store-domains.js";

export function createMemorySessionStore(state: MemoryState): MemoryDomain<SessionStore> {
  return {
    async createSession(input) {
      const now = new Date().toISOString();
      const session: Session = {
        id: createId("sess"),
        projectId: input.projectId,
        deploymentId: input.deploymentId ?? null,
        eveSessionId: input.eveSessionId ?? null,
        continuationToken: input.continuationToken ?? null,
        rootNodeId: null,
        routeId: null,
        experimentId: null,
        variantName: null,
        trigger: input.trigger,
        scheduleId: input.scheduleId ?? null,
        scheduleRunId: null,
        status: "running",
        startedAt: now,
        completedAt: null,
        usage: emptySessionTokenUsage(),
      };
      state.sessions.push(session);
      const project = state.projects.find((candidate) => candidate.id === input.projectId);
      if (project) {
        project.latestSessionStatus = session.status;
        project.updatedAt = now;
      }
      return session;
    },

    async getSessionByEveSessionId(projectId, eveSessionId) {
      return state.sessions.find((session) => session.projectId === projectId && session.eveSessionId === eveSessionId) ?? null;
    },

    async appendSessionEvent(sessionId, type, payload) {
      const event: SessionEvent = {
        id: createId("evt"),
        sessionId,
        index: state.sessionEvents.filter((candidate) => candidate.sessionId === sessionId).length,
        type,
        payload,
        sessionNodeId: null,
        observerEventId: null,
        eventFingerprint: null,
        observedDeploymentId: null,
        sourceSequence: null,
        eventAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      state.sessionEvents.push(event);
      return event;
    },

    async recordModelUsage(sessionId, usage) {
      const session = state.sessions.find((candidate) => candidate.id === sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found.`);
      }

      const eveSessionId = usage.eveSessionId ?? sessionId;
      const existing = state.modelUsageEvents.find(
        (event) =>
          event.sessionId === sessionId &&
          event.eveSessionId === eveSessionId &&
          event.turnId === usage.turnId &&
          event.stepIndex === usage.stepIndex,
      );
      if (existing) {
        return existing;
      }

      const event: ModelUsageEvent = {
        id: createId("usage"),
        sessionId,
        ...usage,
        eveSessionId,
        agentId: usage.agentId ?? null,
        agentName: usage.agentName ?? null,
        createdAt: new Date().toISOString(),
      };
      state.modelUsageEvents.push(event);
      addUsageToSession(session, event);
      return event;
    },

    async completeSession(sessionId, input) {
      let session = state.sessions.find((candidate) => candidate.id === sessionId);
      if (!session) {
        return null;
      }

      if (input.eveSessionId) {
        const observedSession = state.sessions.find(
          (candidate) =>
            candidate.id !== sessionId &&
            candidate.projectId === session!.projectId &&
            candidate.eveSessionId === input.eveSessionId,
        );
        if (observedSession) {
          mergeMemorySessions(state, session, observedSession);
          session = state.sessions.find((candidate) => candidate.id === sessionId)!;
        }
        const binding = state.sessionBindings.find(
          (candidate) => candidate.projectId === session!.projectId && candidate.eveSessionId === input.eveSessionId,
        );
        if (binding) {
          session.trigger = binding.trigger;
          session.routeId = binding.routeId;
          session.experimentId = binding.experimentId;
          session.variantName = binding.variantName;
          session.deploymentId = binding.deploymentId;
        }
      }

      const now = new Date().toISOString();
      session.status = input.status;
      session.eveSessionId = input.eveSessionId ?? session.eveSessionId;
      session.continuationToken = input.continuationToken ?? session.continuationToken;
      session.completedAt = input.status === "completed" || input.status === "failed" ? now : null;

      const project = state.projects.find((candidate) => candidate.id === session.projectId);
      if (project) {
        project.latestSessionStatus = session.status;
        project.updatedAt = now;
      }

      return session;
    },

    async listSessions(projectId) {
      return state.sessions.filter((session) => session.projectId === projectId);
    },

    async getSession(sessionId) {
      return state.sessions.find((session) => session.id === sessionId) ?? null;
    },

    async listSessionsPage(projectId, input) {
      const cursor = input.cursor
        ? state.sessions.find((session) => session.id === input.cursor && session.projectId === projectId)
        : null;
      if (input.cursor && !cursor) return { items: [], nextCursor: null };
      const sessions = state.sessions
        .filter((session) => session.projectId === projectId)
        .filter((session) => !input.trigger || session.trigger === input.trigger)
        .filter((session) => !input.scheduleId || session.scheduleId === input.scheduleId)
        .filter((session) => !input.scheduleRunId || session.scheduleRunId === input.scheduleRunId)
        .filter((session) => !input.unlinkedOnly || session.scheduleRunId === null)
        .filter((session) => !cursor || session.startedAt < cursor.startedAt || (session.startedAt === cursor.startedAt && session.id < cursor.id))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
      const page = sessions.slice(0, input.limit);
      return { items: page, nextCursor: sessions.length > input.limit ? page.at(-1)?.id ?? null : null };
    },

    async listSessionEvents(sessionId) {
      return state.sessionEvents.filter((event) => event.sessionId === sessionId).sort((a, b) => a.index - b.index);
    },

    async listSessionNodes(sessionId) {
      return state.sessionNodes.filter((node) => node.rootSessionId === sessionId);
    },

    async ingestObserverEnvelope(envelope) {
      return ingestMemoryObserverEnvelope(
        state,
        envelope,
        (sessionId, usage) => this.recordModelUsage(sessionId, usage),
      );
    },

    async listModelUsageEvents(sessionId) {
      return state.modelUsageEvents.filter((event) => event.sessionId === sessionId);
    },

  };
}
