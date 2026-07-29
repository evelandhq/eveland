import { and, eq, sql } from "drizzle-orm";
import type {
  AgentRoute,
  Job,
  JobType,
  ModelUsageEvent,
  SharedAgentEnvironment,
  SharedAgentEnvironmentRecord,
} from "@eveland/core/contracts";
import type { StoreDatabase } from "./client.js";
import { agentAuthCredentials, modelUsageEvents, sessionEvents, sessions, sharedAgentEnvironment } from "./schema.js";
import type { AgentAuthCredentialKey, Store } from "./store-domains.js";

export type PostgresStoreContext = {
  database: StoreDatabase;
  db: StoreDatabase["db"];
  ensureDeploymentRoutes(projectId: string, deploymentId: string, baseDomain: string): Promise<AgentRoute[]>;
  ensureDefaultOwner(): Promise<void>;
  createJob(projectId: string, type: JobType, payload: Record<string, unknown>): Promise<Job>;
};

export type PostgresDomain = Partial<Store> & ThisType<Store>;

export function agentAuthCredentialWhere(key: AgentAuthCredentialKey) {
  return and(
    eq(agentAuthCredentials.agentConnectionId, key.agentConnectionId),
    eq(agentAuthCredentials.securityRevision, key.securityRevision),
    eq(agentAuthCredentials.authMethod, key.authMethod),
    eq(agentAuthCredentials.credentialScope, key.credentialScope),
    eq(agentAuthCredentials.scopeSubject, key.scopeSubject),
    eq(agentAuthCredentials.credentialKey, key.credentialKey),
  );
}

export function normalizeSharedAgentEnvironmentEntries(value: unknown): SharedAgentEnvironmentRecord["entries"] {
  if (!Array.isArray(value)) throw new Error("Invalid shared Agent environment entries.");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid shared Agent environment entry.");
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.key !== "string"
      || (candidate.kind !== "variable" && candidate.kind !== "secret")
      || typeof candidate.encryptedValue !== "string"
    ) {
      throw new Error("Invalid shared Agent environment entry.");
    }
    const kind = candidate.kind as "variable" | "secret";
    return { key: candidate.key, kind, encryptedValue: candidate.encryptedValue };
  }).sort((left, right) => left.key.localeCompare(right.key));
}

export function sharedAgentEnvironmentRowToRecord(
  row: typeof sharedAgentEnvironment.$inferSelect,
): SharedAgentEnvironmentRecord {
  return {
    revision: row.revision,
    entries: normalizeSharedAgentEnvironmentEntries(row.entries),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function sharedAgentEnvironmentRowToPublic(
  row: typeof sharedAgentEnvironment.$inferSelect,
): SharedAgentEnvironment {
  const record = sharedAgentEnvironmentRowToRecord(row);
  return {
    ...record,
    entries: record.entries.map(({ key, kind }) => ({ key, kind, configured: true })),
  };
}

export function modelUsageRowToModelUsageEvent(
  row: typeof modelUsageEvents.$inferSelect,
): ModelUsageEvent {
  return {
    id: row.id,
    sessionId: row.sessionId,
    eveSessionId: row.eveSessionId,
    agentId: row.agentId,
    agentName: row.agentName,
    turnId: row.turnId,
    stepIndex: row.stepIndex,
    finishReason: row.finishReason,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    costUsd: row.costUsd,
    usageReported: row.usageReported,
    createdAt: row.createdAt.toISOString(),
  };
}

export function normalizeBaseDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!normalized || !/^[a-z0-9.-]+$/.test(normalized)) throw new Error(`Invalid Agent base domain: ${value}`);
  return normalized;
}

export function isUniqueConstraint(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
  if (record.code === "23505" && (record.constraint_name === constraint || record.constraint === constraint)) return true;
  return isUniqueConstraint(record.cause, constraint);
}

export type SessionEventInsert = Omit<typeof sessionEvents.$inferInsert, "index">;

/**
 * Appends a Session event, assigning the next per-Session `index`.
 *
 * `index` is the replay/transcript ordering key, and every caller used to
 * derive it from a `count(*)` read: two concurrent appends read the same count
 * and inserted the same index, silently corrupting event order (and, in
 * appendSessionEvent's case, transferring every existing row of the Session on
 * each append).
 *
 * The parent Session row is locked first so appends to one Session serialize
 * while different Sessions never contend. That lock order -- sessions before
 * session_events -- matches what the ingest transaction already does when it
 * projects status onto the Session afterwards. `session_events_session_index_idx`
 * remains the backstop: a path that skips this helper fails loudly instead of
 * duplicating an index.
 *
 * Must be called inside a transaction; the row lock is only held for its
 * duration.
 */
export async function appendSessionEventRow(
  tx: StoreDatabase["db"],
  values: SessionEventInsert,
): Promise<typeof sessionEvents.$inferSelect> {
  await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, values.sessionId))
    .for("update");
  const [next] = await tx
    .select({
      value: sql<number>`coalesce(max(${sessionEvents.index}) + 1, 0)::int`,
    })
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, values.sessionId));
  const [row] = await tx
    .insert(sessionEvents)
    .values({ ...values, index: next?.value ?? 0 })
    .returning();
  if (!row) throw new Error("Failed to append Session event.");
  return row;
}

/**
 * Re-parents one Session's events onto another during a merge, renumbering
 * them so they keep their relative order and land after the target's existing
 * events. A bare `set session_id = ...` collides on
 * `session_events_session_index_idx`: both Sessions number their events from
 * zero, so the merge would otherwise interleave two conflicting orderings.
 */
export async function moveSessionEventsForMerge(
  tx: StoreDatabase["db"],
  fromSessionId: string,
  toSessionId: string,
): Promise<void> {
  const [next] = await tx
    .select({
      value: sql<number>`coalesce(max(${sessionEvents.index}) + 1, 0)::int`,
    })
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, toSessionId));
  const offset = next?.value ?? 0;
  await tx
    .update(sessionEvents)
    .set({
      sessionId: toSessionId,
      index: sql`${sessionEvents.index} + ${offset}`,
    })
    .where(eq(sessionEvents.sessionId, fromSessionId));
}
