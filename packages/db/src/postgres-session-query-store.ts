import type { LogRecord } from "@eveland/core/contracts";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import {
  logRowToLog,
  sessionEventRowToSessionEvent,
  sessionNodeRowToSessionNode,
  sessionRowToSession,
} from "./mappers.js";
import { ingestPostgresObserverEnvelope } from "./postgres-observer-store.js";
import {
  logs,
  modelUsageEvents,
  sessionEvents,
  sessionNodes,
  sessions,
} from "./schema.js";

const defaultOwner = {
  id: "user_local_admin",
  email: "admin@example.com",
  name: "Local Admin",
};

import type {
  PostgresDomain,
  PostgresStoreContext,
} from "./postgres-store-support.js";
import { modelUsageRowToModelUsageEvent } from "./postgres-store-support.js";

export function createPostgresSessionQueryStore({
  database,
  db,
  ensureDeploymentRoutes,
  ensureDefaultOwner,
  createJob,
}: PostgresStoreContext): PostgresDomain {
  return {
    async listSessions(projectId) {
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.projectId, projectId))
        .orderBy(desc(sessions.startedAt));
      return rows.map(sessionRowToSession);
    },

    async getSession(sessionId) {
      const [row] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return row ? sessionRowToSession(row) : null;
    },

    async listSessionsPage(projectId, input) {
      const conditions = [eq(sessions.projectId, projectId)];
      if (input.trigger) conditions.push(eq(sessions.trigger, input.trigger));
      if (input.scheduleId)
        conditions.push(eq(sessions.scheduleId, input.scheduleId));
      if (input.scheduleRunId)
        conditions.push(eq(sessions.scheduleRunId, input.scheduleRunId));
      if (input.unlinkedOnly) conditions.push(isNull(sessions.scheduleRunId));
      if (input.cursor) {
        const [cursor] = await db
          .select({ id: sessions.id, startedAt: sessions.startedAt })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, input.cursor),
              eq(sessions.projectId, projectId),
            ),
          )
          .limit(1);
        if (!cursor) return { items: [], nextCursor: null };
        if (cursor)
          conditions.push(
            or(
              lt(sessions.startedAt, cursor.startedAt),
              and(
                eq(sessions.startedAt, cursor.startedAt),
                lt(sessions.id, cursor.id),
              ),
            )!,
          );
      }
      const rows = await db
        .select()
        .from(sessions)
        .where(and(...conditions))
        .orderBy(desc(sessions.startedAt), desc(sessions.id))
        .limit(input.limit + 1);
      const pageRows = rows.slice(0, input.limit);
      return {
        items: pageRows.map(sessionRowToSession),
        nextCursor:
          rows.length > input.limit ? (pageRows.at(-1)?.id ?? null) : null,
      };
    },

    async listSessionEvents(sessionId) {
      const rows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId))
        .orderBy(sessionEvents.index);
      return rows.map(sessionEventRowToSessionEvent);
    },

    async listSessionNodes(sessionId) {
      const rows = await db
        .select()
        .from(sessionNodes)
        .where(eq(sessionNodes.rootSessionId, sessionId))
        .orderBy(sessionNodes.createdAt);
      return rows.map(sessionNodeRowToSessionNode);
    },

    async ingestObserverEnvelope(envelope) {
      return ingestPostgresObserverEnvelope(database, envelope);
    },

    async listModelUsageEvents(sessionId) {
      const rows = await db
        .select()
        .from(modelUsageEvents)
        .where(eq(modelUsageEvents.sessionId, sessionId))
        .orderBy(modelUsageEvents.createdAt);
      return rows.map(modelUsageRowToModelUsageEvent);
    },

    async listLogs(projectId, type?: LogRecord["type"]) {
      const rows = await db
        .select()
        .from(logs)
        .where(
          type
            ? and(eq(logs.projectId, projectId), eq(logs.type, type))
            : eq(logs.projectId, projectId),
        )
        .orderBy(logs.createdAt);
      return rows.map(logRowToLog);
    },
  };
}
