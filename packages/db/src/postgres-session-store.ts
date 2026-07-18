import { createId } from "@eveland/core/ids";
import { and, eq, sql } from "drizzle-orm";
import {
  sessionEventRowToSessionEvent,
  sessionRowToSession,
} from "./mappers.js";
import {
  modelUsageEvents,
  projects,
  sessionBindings,
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

export function createPostgresSessionStore({
  db,
  ensureDeploymentRoutes,
  ensureDefaultOwner,
  createJob,
}: PostgresStoreContext): PostgresDomain {
  return {
    async createSession(input) {
      const [row] = await db
        .insert(sessions)
        .values({
          id: createId("sess"),
          projectId: input.projectId,
          deploymentId: input.deploymentId ?? null,
          eveSessionId: input.eveSessionId ?? null,
          continuationToken: input.continuationToken ?? null,
          trigger: input.trigger,
          scheduleId: input.scheduleId ?? null,
          status: "running",
        })
        .returning();

      if (!row) {
        throw new Error("Failed to create session.");
      }

      await db
        .update(projects)
        .set({
          latestSessionStatus: "running",
          updatedAt: new Date(),
        })
        .where(eq(projects.id, input.projectId));

      return sessionRowToSession(row);
    },

    async getSessionByEveSessionId(projectId, eveSessionId) {
      const [row] = await db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.projectId, projectId),
            eq(sessions.eveSessionId, eveSessionId),
          ),
        )
        .limit(1);
      return row ? sessionRowToSession(row) : null;
    },

    async appendSessionEvent(sessionId, type, payload) {
      const existingEvents = await db
        .select({ index: sessionEvents.index })
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      const [row] = await db
        .insert(sessionEvents)
        .values({
          id: createId("evt"),
          sessionId,
          index: existingEvents.length,
          type,
          payload,
        })
        .returning();

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
                eq(
                  modelUsageEvents.eveSessionId,
                  usage.eveSessionId ?? sessionId,
                ),
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
        let [current] = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
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
            await tx
              .update(sessionNodes)
              .set({ rootSessionId: sessionId })
              .where(eq(sessionNodes.rootSessionId, observed.id));
            await tx
              .update(sessionEvents)
              .set({ sessionId })
              .where(eq(sessionEvents.sessionId, observed.id));
            await tx
              .update(modelUsageEvents)
              .set({ sessionId })
              .where(eq(modelUsageEvents.sessionId, observed.id));
            [current] = await tx
              .update(sessions)
              .set({
                rootNodeId: current.rootNodeId ?? observed.rootNodeId,
                deploymentId: current.deploymentId ?? observed.deploymentId,
                routeId: current.routeId ?? observed.routeId,
                experimentId: current.experimentId ?? observed.experimentId,
                variantName: current.variantName ?? observed.variantName,
                inputTokens: sql`${sessions.inputTokens} + ${observed.inputTokens}`,
                outputTokens: sql`${sessions.outputTokens} + ${observed.outputTokens}`,
                cacheReadTokens: sql`${sessions.cacheReadTokens} + ${observed.cacheReadTokens}`,
                cacheWriteTokens: sql`${sessions.cacheWriteTokens} + ${observed.cacheWriteTokens}`,
                costUsd:
                  observed.costUsd === null
                    ? current.costUsd
                    : sql`coalesce(${sessions.costUsd}, 0) + ${observed.costUsd}`,
                usageReportedSteps: sql`${sessions.usageReportedSteps} + ${observed.usageReportedSteps}`,
                usageMissingSteps: sql`${sessions.usageMissingSteps} + ${observed.usageMissingSteps}`,
              })
              .where(eq(sessions.id, sessionId))
              .returning();
            await tx.delete(sessions).where(eq(sessions.id, observed.id));
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
            eveSessionId: input.eveSessionId,
            continuationToken: input.continuationToken,
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
              input.status === "completed" || input.status === "failed"
                ? new Date()
                : null,
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
  };
}
