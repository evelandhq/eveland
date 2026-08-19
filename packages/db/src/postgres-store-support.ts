import { and, eq, sql } from "drizzle-orm";
import type {
  JobType,
  ModelUsageEvent,
  SharedAgentEnvironment,
  SharedAgentEnvironmentRecord,
} from "@evelandhq/core/contracts";
import { createId } from "@evelandhq/core/ids";
import { decodeJobPayload } from "@evelandhq/core/jobs";
import { getNextRunAt } from "@evelandhq/core/schedules";
import type { StoreDatabase } from "./client.js";
import {
  agentAuthCredentials,
  jobs,
  modelUsageEvents,
  projectSchedulerTargets,
  projectSchedules,
  scheduleVersions,
  sessionEvents,
  sessionNodes,
  sessions,
  sharedAgentEnvironment,
} from "./schema.js";
import type { AgentAuthCredentialKey } from "./store-domains.js";

type JobPayloadInput<Type extends JobType> = Parameters<typeof decodeJobPayload<Type>>[1];

export type PostgresStoreContext = {
  database: StoreDatabase;
  db: StoreDatabase["db"];
};

/**
 * Appends a session's `platform.runtime_lost` event unless that session
 * already carries one for the same RuntimeInstance.
 *
 * The loss of one RuntimeInstance is projected by two store methods in two
 * domains -- schedule executions and running sessions -- in separate
 * transactions. Their result previously depended on call order: the schedule
 * pass flips sessions to failed, and the session pass filters on
 * `status = 'running'`, so running them the other way round appended a second
 * runtime_lost event to every scheduled session. Deduplicating here makes the
 * projection order-independent instead of leaving an unwritten contract
 * between two interfaces (pinned by the both-orders test in
 * session-store.test.ts).
 */
export async function appendRuntimeLostEventTx(
  tx: StoreDatabase["db"],
  input: {
    sessionId: string;
    runtimeInstanceId: string;
    reason: string;
    now: Date;
    sessionNodeId?: string | null;
    observedDeploymentId?: string | null;
  },
): Promise<boolean> {
  const [existing] = await tx
    .select({ id: sessionEvents.id })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.sessionId, input.sessionId),
        eq(sessionEvents.type, "platform.runtime_lost"),
        sql`${sessionEvents.payload}->>'runtimeInstanceId' = ${input.runtimeInstanceId}`,
      ),
    )
    .limit(1);
  if (existing) return false;
  await appendSessionEventRow(tx, {
    id: createId("evt"),
    sessionId: input.sessionId,
    ...(input.sessionNodeId ? { sessionNodeId: input.sessionNodeId } : {}),
    ...(input.observedDeploymentId ? { observedDeploymentId: input.observedDeploymentId } : {}),
    observedRuntimeInstanceId: input.runtimeInstanceId,
    type: "platform.runtime_lost",
    payload: { runtimeInstanceId: input.runtimeInstanceId, reason: input.reason },
    eventAt: input.now,
  });
  return true;
}

/**
 * The one validated jobs insert. Every enqueue -- the JobSource domain's own
 * `enqueueJob` and the transactional flows in the project and schedule stores
 * that must enqueue inside their own transaction -- goes through here, so a
 * payload that does not satisfy its job type's contract can never reach the
 * queue (the claim side would otherwise quarantine it as an invalid row).
 */
export async function insertJobRowTx<Type extends JobType>(
  tx: StoreDatabase["db"],
  input: {
    projectId: string;
    type: Type;
    payload: JobPayloadInput<Type>;
    createdAt?: Date;
    updatedAt?: Date;
  },
): Promise<typeof jobs.$inferSelect> {
  const [row] = await tx
    .insert(jobs)
    .values({
      id: createId("job"),
      projectId: input.projectId,
      type: input.type,
      status: "queued",
      payload: decodeJobPayload(input.type, input.payload ?? {}),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    })
    .returning();
  if (!row) throw new Error(`Failed to enqueue ${input.type} job.`);
  return row;
}

/**
 * Points a Project's scheduler at a Deployment and recomputes every schedule's
 * next run from that Deployment's Release. Shared by the ScheduleStore's
 * `setProjectSchedulerTarget` and by `promoteDeployment`, which must apply the
 * same effect inside its own promotion transaction -- previously a verbatim
 * copy that could drift from the canonical one.
 */
export async function applySchedulerTargetTx(
  tx: StoreDatabase["db"],
  input: {
    projectId: string;
    deploymentId: string;
    sourceRevisionId: string;
    now: Date;
  },
): Promise<typeof projectSchedulerTargets.$inferSelect | undefined> {
  const [target] = await tx
    .insert(projectSchedulerTargets)
    .values({
      projectId: input.projectId,
      deploymentId: input.deploymentId,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: projectSchedulerTargets.projectId,
      set: { deploymentId: input.deploymentId, updatedAt: input.now },
    })
    .returning();

  const scheduleRows = await tx
    .select()
    .from(projectSchedules)
    .where(eq(projectSchedules.projectId, input.projectId));
  for (const scheduleRow of scheduleRows) {
    const [version] = await tx
      .select()
      .from(scheduleVersions)
      .where(
        and(
          eq(scheduleVersions.scheduleId, scheduleRow.id),
          eq(scheduleVersions.sourceRevisionId, input.sourceRevisionId),
        ),
      )
      .limit(1);
    await tx
      .update(projectSchedules)
      .set({
        nextRunAt: version && scheduleRow.enabled ? getNextRunAt(version.cron, input.now) : null,
        updatedAt: input.now,
      })
      .where(eq(projectSchedules.id, scheduleRow.id));
  }
  return target;
}

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

export function normalizeSharedAgentEnvironmentEntries(
  value: unknown,
): SharedAgentEnvironmentRecord["entries"] {
  if (!Array.isArray(value)) throw new Error("Invalid shared Agent environment entries.");
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object")
        throw new Error("Invalid shared Agent environment entry.");
      const candidate = entry as Record<string, unknown>;
      if (
        typeof candidate.key !== "string" ||
        (candidate.kind !== "variable" && candidate.kind !== "secret") ||
        typeof candidate.encryptedValue !== "string"
      ) {
        throw new Error("Invalid shared Agent environment entry.");
      }
      const kind = candidate.kind as "variable" | "secret";
      return { key: candidate.key, kind, encryptedValue: candidate.encryptedValue };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
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
    modelId: row.modelId,
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
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  if (!normalized || !/^[a-z0-9.-]+$/.test(normalized))
    throw new Error(`Invalid Agent base domain: ${value}`);
  return normalized;
}

/**
 * Postgres `text` rejects NUL (`\u0000`) with `22021 invalid byte sequence`,
 * and error strings arriving from a deployment runtime can embed raw binary --
 * a failed query's CBOR params, a file read gone wrong. Persisting one
 * unsanitized poisons the very write that records the failure, so every
 * error column fed from outside the platform passes through here first.
 */
export function sanitizeStoredErrorText(value: string): string;
export function sanitizeStoredErrorText(value: string | null): string | null;
export function sanitizeStoredErrorText(value: string | null): string | null {
  return value === null ? null : value.replaceAll("\u0000", "\uFFFD");
}

export function isUniqueConstraint(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as {
    code?: unknown;
    constraint_name?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  if (
    record.code === "23505" &&
    (record.constraint_name === constraint || record.constraint === constraint)
  )
    return true;
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

/**
 * Folds one root Session into another: re-parents its nodes, its events
 * (renumbered by moveSessionEventsForMerge), and its usage rows, adds its
 * usage counters onto the surviving row, applies any caller-supplied
 * metadata coalescing, and deletes the absorbed row. Both merge paths --
 * completeSession's placeholder merge and the ingest path's subagent
 * re-parent -- go through here, so a new usage counter cannot be folded on
 * one path and silently dropped on the other (pinned by the every-counter
 * merge test in agent-observability-store.test.ts).
 */
export async function mergeSessionRows(
  tx: StoreDatabase["db"],
  absorbed: typeof sessions.$inferSelect,
  survivingSessionId: string,
  metadataPatch: Partial<
    Pick<
      typeof sessions.$inferInsert,
      "rootNodeId" | "deploymentId" | "routeId" | "experimentId" | "variantName"
    >
  > = {},
): Promise<typeof sessions.$inferSelect | undefined> {
  await tx
    .update(sessionNodes)
    .set({ rootSessionId: survivingSessionId })
    .where(eq(sessionNodes.rootSessionId, absorbed.id));
  await moveSessionEventsForMerge(tx, absorbed.id, survivingSessionId);
  await tx
    .update(modelUsageEvents)
    .set({ sessionId: survivingSessionId })
    .where(eq(modelUsageEvents.sessionId, absorbed.id));
  const [surviving] = await tx
    .update(sessions)
    .set({
      ...metadataPatch,
      inputTokens: sql`${sessions.inputTokens} + ${absorbed.inputTokens}`,
      outputTokens: sql`${sessions.outputTokens} + ${absorbed.outputTokens}`,
      cacheReadTokens: sql`${sessions.cacheReadTokens} + ${absorbed.cacheReadTokens}`,
      cacheWriteTokens: sql`${sessions.cacheWriteTokens} + ${absorbed.cacheWriteTokens}`,
      ...(absorbed.costUsd === null
        ? {}
        : { costUsd: sql`coalesce(${sessions.costUsd}, 0) + ${absorbed.costUsd}` }),
      usageReportedSteps: sql`${sessions.usageReportedSteps} + ${absorbed.usageReportedSteps}`,
      usageMissingSteps: sql`${sessions.usageMissingSteps} + ${absorbed.usageMissingSteps}`,
    })
    .where(eq(sessions.id, survivingSessionId))
    .returning();
  await tx.delete(sessions).where(eq(sessions.id, absorbed.id));
  return surviving;
}
