import type { LogRecord } from "@evelandhq/core/contracts";
import { and, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import {
  logRowToLog,
  sessionEventRowToSessionEvent,
  sessionNodeRowToSessionNode,
  sessionRowToSession,
} from "./mappers.js";
import { ingestPostgresAgentEvent } from "./postgres-agent-observability-store.js";
import { logs, modelUsageEvents, sessionEvents, sessionNodes, sessions } from "./schema.js";
import type { LogStore, SessionStore } from "./store-domains.js";
import type { PostgresStoreContext } from "./postgres-store-support.js";
import { modelUsageRowToModelUsageEvent } from "./postgres-store-support.js";

type PostgresSessionQueryDomain = Pick<
  SessionStore,
  | "listSessions"
  | "getSession"
  | "listSessionsPage"
  | "listSessionEvents"
  | "listSessionNodes"
  | "ingestAgentEvent"
  | "listModelUsageEvents"
  | "hasRunningSessionsObservedBy"
> &
  Pick<LogStore, "listLogs">;

export function createPostgresSessionQueryStore({
  database,
  db,
}: PostgresStoreContext): PostgresSessionQueryDomain {
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
      const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      return row ? sessionRowToSession(row) : null;
    },

    async listSessionsPage(projectId, input) {
      const conditions = [eq(sessions.projectId, projectId)];
      if (input.trigger) conditions.push(eq(sessions.trigger, input.trigger));
      if (input.scheduleId) conditions.push(eq(sessions.scheduleId, input.scheduleId));
      if (input.scheduleRunId) conditions.push(eq(sessions.scheduleRunId, input.scheduleRunId));
      if (input.unlinkedOnly) conditions.push(isNull(sessions.scheduleRunId));
      if (input.cursor) {
        const [cursor] = await db
          .select({ id: sessions.id, startedAt: sessions.startedAt })
          .from(sessions)
          .where(and(eq(sessions.id, input.cursor), eq(sessions.projectId, projectId)))
          .limit(1);
        if (!cursor) return { items: [], nextCursor: null };
        if (cursor)
          conditions.push(
            or(
              lt(sessions.startedAt, cursor.startedAt),
              and(eq(sessions.startedAt, cursor.startedAt), lt(sessions.id, cursor.id)),
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
        nextCursor: rows.length > input.limit ? (pageRows.at(-1)?.id ?? null) : null,
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

    async ingestAgentEvent(observation) {
      return ingestPostgresAgentEvent(database, observation);
    },

    async hasRunningSessionsObservedBy(runtimeInstanceId) {
      const [row] = await db
        .select({ id: sessionNodes.id })
        .from(sessionNodes)
        .innerJoin(sessions, eq(sessions.id, sessionNodes.rootSessionId))
        .where(
          and(
            eq(sessionNodes.lastObservedRuntimeInstanceId, runtimeInstanceId),
            eq(sessions.status, "running"),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    async listModelUsageEvents(sessionId) {
      const rows = await db
        .select()
        .from(modelUsageEvents)
        .where(eq(modelUsageEvents.sessionId, sessionId))
        .orderBy(modelUsageEvents.createdAt);
      return rows.map(modelUsageRowToModelUsageEvent);
    },

    // The log record grows for the life of the project, so callers page it:
    // `limit` alone returns the LAST n rows (a tail), `afterId` returns rows
    // strictly after that row — the follow cursor — optionally capped by
    // `limit`. Ordering and anchoring use the monotonic seq column: createdAt
    // is millisecond-resolution and burst-written lines collide on it, so a
    // time-ordered cursor could skip same-instant rows. Results are always
    // ascending; an unknown afterId returns nothing rather than replaying
    // the whole history.
    async listLogs(
      projectId,
      type?: LogRecord["type"],
      options?: { limit?: number; afterId?: string },
    ) {
      const scope = type
        ? and(eq(logs.projectId, projectId), eq(logs.type, type))
        : eq(logs.projectId, projectId);
      if (options?.afterId) {
        const [anchor] = await db
          .select({ seq: logs.seq })
          .from(logs)
          .where(and(eq(logs.projectId, projectId), eq(logs.id, options.afterId)));
        if (!anchor) return [];
        let query = db
          .select()
          .from(logs)
          .where(and(scope, gt(logs.seq, anchor.seq)))
          .orderBy(logs.seq)
          .$dynamic();
        if (options.limit) query = query.limit(options.limit);
        return (await query).map(logRowToLog);
      }
      if (options?.limit) {
        const rows = await db
          .select()
          .from(logs)
          .where(scope)
          .orderBy(desc(logs.seq))
          .limit(options.limit);
        return rows.reverse().map(logRowToLog);
      }
      const rows = await db.select().from(logs).where(scope).orderBy(logs.seq);
      return rows.map(logRowToLog);
    },
  };
}
