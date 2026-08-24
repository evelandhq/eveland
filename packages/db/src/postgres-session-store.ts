import { createId } from "@evelandhq/core/ids";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { sessionEventRowToSessionEvent, sessionRowToSession } from "./mappers.js";
import {
  activationLeases,
  modelUsageEvents,
  projects,
  scheduleRunSessions,
  scheduleRuns,
  sessionBindings,
  sessionNodes,
  sessions,
} from "./schema.js";
import type { SessionStore } from "./store-domains.js";
import type { PostgresStoreContext } from "./postgres-store-support.js";
import {
  appendRuntimeLostEventTx,
  appendSessionEventRow,
  mergeSessionRows,
  modelUsageRowToModelUsageEvent,
  sanitizeStoredErrorText,
} from "./postgres-store-support.js";

type PostgresSessionMutationDomain = Pick<
  SessionStore,
  | "createSession"
  | "getSessionByEveSessionId"
  | "appendSessionEvent"
  | "recordModelUsage"
  | "completeSession"
  | "failRunningSessionsForRuntimeInstance"
>;

export function createPostgresSessionStore({
  db,
}: PostgresStoreContext): PostgresSessionMutationDomain {
  return {
    async createSession(input) {
      // The session row and the project's latestSessionStatus denormalization
      // are one fact: a crash between them leaves the project card stale
      // forever. Every other writer of that projection is transactional.
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(sessions)
          .values({
            id: createId("sess"),
            projectId: input.projectId,
            deploymentId: input.deploymentId ?? null,
            eveSessionId: input.eveSessionId ?? null,
            trigger: input.trigger,
            scheduleId: input.scheduleId ?? null,
            status: "running",
          })
          .returning();

        if (!row) {
          throw new Error("Failed to create session.");
        }

        await tx
          .update(projects)
          .set({
            latestSessionStatus: "running",
            updatedAt: new Date(),
          })
          .where(eq(projects.id, input.projectId));

        return sessionRowToSession(row);
      });
    },

    async getSessionByEveSessionId(projectId, eveSessionId) {
      const [row] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.projectId, projectId), eq(sessions.eveSessionId, eveSessionId)))
        .limit(1);
      return row ? sessionRowToSession(row) : null;
    },

    async appendSessionEvent(sessionId, type, payload) {
      const row = await db.transaction((tx) =>
        appendSessionEventRow(tx, {
          id: createId("evt"),
          sessionId,
          type,
          payload,
        }),
      );

      if (!row) {
        throw new Error("Failed to append session event.");
      }

      return sessionEventRowToSessionEvent(row);
    },

    async recordModelUsage(sessionId, usage) {
      return db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(modelUsageEvents)
          .values({
            id: createId("usage"),
            sessionId,
            eveSessionId: usage.eveSessionId ?? sessionId,
            agentId: usage.agentId ?? null,
            agentName: usage.agentName ?? null,
            turnId: usage.turnId,
            stepIndex: usage.stepIndex,
            finishReason: usage.finishReason,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            costUsd: usage.costUsd,
            usageReported: usage.usageReported,
          })
          .onConflictDoNothing({
            target: [
              modelUsageEvents.sessionId,
              modelUsageEvents.eveSessionId,
              modelUsageEvents.turnId,
              modelUsageEvents.stepIndex,
            ],
          })
          .returning();

        if (!inserted) {
          const [existing] = await tx
            .select()
            .from(modelUsageEvents)
            .where(
              and(
                eq(modelUsageEvents.sessionId, sessionId),
                eq(modelUsageEvents.eveSessionId, usage.eveSessionId ?? sessionId),
                eq(modelUsageEvents.turnId, usage.turnId),
                eq(modelUsageEvents.stepIndex, usage.stepIndex),
              ),
            )
            .limit(1);
          if (!existing) {
            throw new Error("Failed to read the existing model usage event.");
          }
          return modelUsageRowToModelUsageEvent(existing);
        }

        await tx
          .update(sessions)
          .set({
            inputTokens: sql`${sessions.inputTokens} + ${usage.inputTokens ?? 0}`,
            outputTokens: sql`${sessions.outputTokens} + ${usage.outputTokens ?? 0}`,
            cacheReadTokens: sql`${sessions.cacheReadTokens} + ${usage.cacheReadTokens ?? 0}`,
            cacheWriteTokens: sql`${sessions.cacheWriteTokens} + ${usage.cacheWriteTokens ?? 0}`,
            ...(usage.costUsd === null
              ? {}
              : {
                  costUsd: sql`coalesce(${sessions.costUsd}, 0) + ${usage.costUsd}`,
                }),
            ...(usage.usageReported
              ? { usageReportedSteps: sql`${sessions.usageReportedSteps} + 1` }
              : { usageMissingSteps: sql`${sessions.usageMissingSteps} + 1` }),
          })
          .where(eq(sessions.id, sessionId));

        return modelUsageRowToModelUsageEvent(inserted);
      });
    },

    async completeSession(sessionId, input) {
      return db.transaction(async (tx) => {
        let [current] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
        if (!current) return null;

        if (input.eveSessionId) {
          const [observed] = await tx
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.projectId, current.projectId),
                eq(sessions.eveSessionId, input.eveSessionId),
                sql`${sessions.id} <> ${sessionId}`,
              ),
            )
            .limit(1);
          if (observed) {
            current =
              (await mergeSessionRows(tx, observed, sessionId, {
                rootNodeId: current.rootNodeId ?? observed.rootNodeId,
                deploymentId: current.deploymentId ?? observed.deploymentId,
                routeId: current.routeId ?? observed.routeId,
                experimentId: current.experimentId ?? observed.experimentId,
                variantName: current.variantName ?? observed.variantName,
              })) ?? current;
          }
        }

        const [binding] = input.eveSessionId
          ? await tx
              .select()
              .from(sessionBindings)
              .where(
                and(
                  eq(sessionBindings.projectId, current!.projectId),
                  eq(sessionBindings.eveSessionId, input.eveSessionId),
                ),
              )
              .limit(1)
          : [];

        const [row] = await tx
          .update(sessions)
          .set({
            status: input.status,
            error:
              input.status === "failed"
                ? input.error !== undefined
                  ? sanitizeStoredErrorText(input.error)
                  : current!.error
                : null,
            eveSessionId: input.eveSessionId,
            ...(binding
              ? {
                  trigger: binding.trigger,
                  routeId: binding.routeId,
                  experimentId: binding.experimentId,
                  variantName: binding.variantName,
                  deploymentId: binding.deploymentId,
                }
              : {}),
            completedAt:
              input.status === "completed" || input.status === "failed" ? new Date() : null,
          })
          .where(eq(sessions.id, sessionId))
          .returning();
        if (!row) return null;

        await tx
          .update(projects)
          .set({ latestSessionStatus: input.status, updatedAt: new Date() })
          .where(eq(projects.id, row.projectId));
        return sessionRowToSession(row);
      });
    },

    async failRunningSessionsForRuntimeInstance(runtimeInstanceId, reason, now = new Date()) {
      return db.transaction(async (tx) => {
        const interrupted = await tx
          .select({
            sessionId: sessions.id,
            projectId: sessions.projectId,
            nodeId: sessionNodes.id,
            deploymentId: sessionNodes.lastObservedDeploymentId,
          })
          .from(sessions)
          .innerJoin(
            sessionNodes,
            and(eq(sessionNodes.rootSessionId, sessions.id), isNull(sessionNodes.parentNodeId)),
          )
          .where(
            and(
              eq(sessions.status, "running"),
              eq(sessionNodes.lastObservedRuntimeInstanceId, runtimeInstanceId),
            ),
          );
        if (interrupted.length === 0) return 0;

        const sessionIds = interrupted.map((session) => session.sessionId);
        const nodeIds = interrupted.map((session) => session.nodeId);
        await tx
          .update(sessions)
          .set({ status: "failed", error: sanitizeStoredErrorText(reason), completedAt: now })
          .where(and(inArray(sessions.id, sessionIds), eq(sessions.status, "running")));
        await tx
          .update(sessionNodes)
          .set({ status: "failed", updatedAt: now })
          .where(inArray(sessionNodes.id, nodeIds));
        for (const session of interrupted) {
          await appendRuntimeLostEventTx(tx, {
            sessionId: session.sessionId,
            sessionNodeId: session.nodeId,
            observedDeploymentId: session.deploymentId,
            runtimeInstanceId,
            reason,
            now,
          });
        }
        // The ScheduleRun's activation lease may point at a different (live)
        // RuntimeInstance than the one that was observed executing -- that is
        // the #270 wedge. Failing only the Session would leave the run
        // `running` and its lease pinning that Deployment until the 24 h TTL,
        // so the executions, their runs, and the runs' leases fail here too.
        const interruptedExecutions = await tx
          .select({ scheduleRunId: scheduleRunSessions.scheduleRunId })
          .from(scheduleRunSessions)
          .where(
            and(
              inArray(scheduleRunSessions.sessionId, sessionIds),
              eq(scheduleRunSessions.status, "running"),
            ),
          );
        const runIds = [
          ...new Set(interruptedExecutions.map((execution) => execution.scheduleRunId)),
        ];
        if (runIds.length > 0) {
          await tx
            .update(scheduleRunSessions)
            .set({ status: "failed", completedAt: now, error: reason })
            .where(
              and(
                inArray(scheduleRunSessions.scheduleRunId, runIds),
                inArray(scheduleRunSessions.sessionId, sessionIds),
                eq(scheduleRunSessions.status, "running"),
              ),
            );
          await tx
            .update(scheduleRuns)
            .set({ status: "failed", error: reason, completedAt: now, updatedAt: now })
            .where(and(inArray(scheduleRuns.id, runIds), eq(scheduleRuns.status, "running")));
          await tx
            .update(activationLeases)
            .set({ releasedAt: now })
            .where(
              and(
                eq(activationLeases.kind, "schedule_run"),
                inArray(activationLeases.ownerId, runIds),
                isNull(activationLeases.releasedAt),
              ),
            );
        }
        await tx
          .update(projects)
          .set({ latestSessionStatus: "failed", updatedAt: now })
          .where(
            inArray(projects.id, [...new Set(interrupted.map((session) => session.projectId))]),
          );
        return interrupted.length;
      });
    },
  };
}
