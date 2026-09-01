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
  Pick<LogStore, "listLogs" | "listLogsPage">;

function logScope(projectId: string, type: LogRecord["type"] | undefined) {
  return type
    ? and(eq(logs.projectId, projectId), eq(logs.type, type))
    : eq(logs.projectId, projectId);
}

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

    async listLogs(projectId, type?: LogRecord["type"]) {
      const rows = await db.select().from(logs).where(logScope(projectId, type)).orderBy(logs.seq);
      return rows.map(logRowToLog);
    },

    // The log record grows for the life of the project, so bounded callers
    // (the CLI's tail/follow, deploy's build-log watcher) page it. Ordering
    // and the cursor ride the monotonic seq column: createdAt has
    // millisecond resolution and burst-written lines collide on it, so a
    // time-anchored cursor could skip same-instant rows (appendLog
    // serializes per project so seq is also commit-ordered). The cursor is
    // the last-seen seq as an opaque string, and an EMPTY tail still returns
    // cursor 0, so a follower that starts before any log exists never needs
    // an unbounded re-read and never skips the lines that arrive next.
    async listLogsPage(
      projectId,
      type: LogRecord["type"] | undefined,
      options: { limit: number; after?: string },
    ) {
      const scope = logScope(projectId, type);
      const limit = Math.min(Math.max(1, Math.floor(options.limit)), 1_000);
      if (options.after !== undefined) {
        const after = Number(options.after);
        const rows = await db
          .select()
          .from(logs)
          .where(and(scope, gt(logs.seq, after)))
          .orderBy(logs.seq)
          .limit(limit);
        const cursor = rows.at(-1)?.seq ?? after;
        return { logs: rows.map(logRowToLog), cursor: String(cursor) };
      }
      const rows = await db.select().from(logs).where(scope).orderBy(desc(logs.seq)).limit(limit);
      rows.reverse();
      const last = rows.at(-1)?.seq;
      // An empty scope pins the cursor at 0: logs are never deleted, so
      // "empty" means nothing committed in scope has ever existed and 0
      // skips nothing. Reading a separate max(seq) watermark here would race
      // — a row committing between the two queries would sit inside the
      // watermark yet never have been returned.
      return { logs: rows.map(logRowToLog), cursor: String(last ?? 0) };
    },
  };
}
