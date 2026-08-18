import type {
  WorkflowCutoverOperation,
  WorkflowCutoverPhase,
  WorkflowFence,
} from "@evelandhq/core/contracts";
import { createId } from "@evelandhq/core/ids";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { timestampToIso } from "./mappers.js";
import {
  activationLeases,
  operationBindings,
  scheduleRuns,
  sessionBindings,
  sessionNodes,
  sessions,
  workflowCutoverOperations,
  workflowFences,
} from "./schema.js";
import type { WorkflowCutoverStore } from "./store-domains.js";
import type { PostgresStoreContext } from "./postgres-store-support.js";

/** Monotonic saga order; a step can hold its phase but never move it back. */
const PHASE_ORDER: WorkflowCutoverPhase[] = [
  "pending",
  "fenced",
  "workflow_safe",
  "control_plane_converged",
  "completed",
];

export function createPostgresWorkflowCutoverStore(
  context: PostgresStoreContext,
): WorkflowCutoverStore {
  const { db } = context;

  return {
    async ensureWorkflowCutoverOperation(input) {
      const [inserted] = await db
        .insert(workflowCutoverOperations)
        .values({
          id: input.id,
          kind: input.kind,
          phase: "pending",
          scope: input.scope,
          checkpoints: {},
        })
        .onConflictDoNothing({ target: workflowCutoverOperations.id })
        .returning();
      if (inserted) return operationRowToOperation(inserted);
      const [existing] = await db
        .select()
        .from(workflowCutoverOperations)
        .where(eq(workflowCutoverOperations.id, input.id))
        .limit(1);
      if (!existing) throw new Error("Failed to ensure the cutover operation.");
      return operationRowToOperation(existing);
    },

    async getWorkflowCutoverOperation(id) {
      const [row] = await db
        .select()
        .from(workflowCutoverOperations)
        .where(eq(workflowCutoverOperations.id, id))
        .limit(1);
      return row ? operationRowToOperation(row) : null;
    },

    async advanceWorkflowCutoverOperation(id, input) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(workflowCutoverOperations)
          .where(eq(workflowCutoverOperations.id, id))
          .limit(1)
          .for("update");
        if (!current) return null;
        const currentIndex = PHASE_ORDER.indexOf(current.phase as WorkflowCutoverPhase);
        let phase = current.phase as WorkflowCutoverPhase;
        if (input.phase !== undefined) {
          const nextIndex = PHASE_ORDER.indexOf(input.phase);
          // Monotonic and idempotent: a re-run reporting an earlier phase
          // holds the operation where it is rather than reopening it.
          if (nextIndex > currentIndex) phase = input.phase;
        }
        const checkpoints = {
          ...(current.checkpoints as Record<string, unknown>),
          ...(input.checkpoint ? { [input.checkpoint.key]: input.checkpoint.value } : {}),
        };
        const [updated] = await tx
          .update(workflowCutoverOperations)
          .set({
            phase,
            checkpoints,
            ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
            updatedAt: new Date(),
          })
          .where(eq(workflowCutoverOperations.id, id))
          .returning();
        return updated ? operationRowToOperation(updated) : null;
      });
    },

    async writeWorkflowFences(operationId, fences) {
      if (fences.length === 0) return [];
      const written: WorkflowFence[] = [];
      for (const fence of fences) {
        const [row] = await db
          .insert(workflowFences)
          .values({
            id: createId("wff"),
            scopeKind: fence.scopeKind,
            scopeId: fence.scopeId,
            operationId,
            reason: fence.reason,
          })
          .onConflictDoUpdate({
            target: [workflowFences.scopeKind, workflowFences.scopeId],
            // Re-fencing a scope is idempotent: a resolved fence reopens under
            // the new operation, an unresolved one keeps standing.
            set: { operationId, reason: fence.reason, resolvedAt: null, resolvedBy: null },
          })
          .returning();
        if (row) {
          written.push(fenceRowToFence(row));
          continue;
        }
        const [existing] = await db
          .select()
          .from(workflowFences)
          .where(
            and(
              eq(workflowFences.scopeKind, fence.scopeKind),
              eq(workflowFences.scopeId, fence.scopeId),
            ),
          )
          .limit(1);
        if (existing) written.push(fenceRowToFence(existing));
      }
      return written;
    },

    async getActiveWorkflowFence(scopeKind, scopeId) {
      const [row] = await db
        .select()
        .from(workflowFences)
        .where(
          and(
            eq(workflowFences.scopeKind, scopeKind),
            eq(workflowFences.scopeId, scopeId),
            isNull(workflowFences.resolvedAt),
          ),
        )
        .limit(1);
      return row ? fenceRowToFence(row) : null;
    },

    async listWorkflowFences(operationId) {
      const rows = await db
        .select()
        .from(workflowFences)
        .where(eq(workflowFences.operationId, operationId));
      return rows.map(fenceRowToFence);
    },

    async resolveWorkflowFence(scopeKind, scopeId, resolvedBy) {
      const [row] = await db
        .update(workflowFences)
        .set({ resolvedAt: new Date(), resolvedBy })
        .where(
          and(
            eq(workflowFences.scopeKind, scopeKind),
            eq(workflowFences.scopeId, scopeId),
            isNull(workflowFences.resolvedAt),
          ),
        )
        .returning();
      return row ? fenceRowToFence(row) : null;
    },

    async convergeWorkflowTermination(operationId, deploymentIds) {
      if (deploymentIds.length === 0) {
        return {
          failedSessions: 0,
          failedSessionNodes: 0,
          tombstonedFamilies: 0,
          removedSessionBindings: 0,
          removedOperationBindings: 0,
          releasedLeases: 0,
          cancelledScheduleRuns: 0,
        };
      }
      return db.transaction(async (tx) => {
        const failedSessions = await tx
          .update(sessions)
          .set({ status: "failed" })
          .where(
            and(
              inArray(sessions.deploymentId, deploymentIds),
              inArray(sessions.status, ["running", "waiting"]),
            ),
          )
          .returning({ id: sessions.id });
        // Session-family tombstones for EVERY Eve family on the retired
        // deployments — including Sessions corruption already marked failed
        // before this operation ran. A late or replayed OTLP batch must never
        // re-materialize any of them, whatever state they were in.
        const families = await tx
          .select({
            id: sessions.id,
            projectId: sessions.projectId,
            eveSessionId: sessions.eveSessionId,
          })
          .from(sessions)
          .where(inArray(sessions.deploymentId, deploymentIds));
        for (const family of families) {
          if (!family.eveSessionId) continue;
          await tx
            .insert(workflowFences)
            .values({
              id: createId("wff"),
              scopeKind: "session_family",
              scopeId: `${family.projectId}:${family.eveSessionId}`,
              operationId,
              reason: "session family managed-terminated",
            })
            .onConflictDoNothing({
              target: [workflowFences.scopeKind, workflowFences.scopeId],
            });
        }
        // SessionNodes converge with their families: a node left `running`
        // would keep reading as live work in every read model.
        const failedNodes =
          families.length === 0
            ? []
            : await tx
                .update(sessionNodes)
                .set({ status: "failed", updatedAt: new Date() })
                .where(
                  and(
                    inArray(
                      sessionNodes.rootSessionId,
                      families.map((family) => family.id),
                    ),
                    eq(sessionNodes.status, "running"),
                  ),
                )
                .returning({ id: sessionNodes.id });
        const removedSessionBindings = await tx
          .delete(sessionBindings)
          .where(inArray(sessionBindings.deploymentId, deploymentIds))
          .returning({ id: sessionBindings.id });
        const removedOperationBindings = await tx
          .delete(operationBindings)
          .where(inArray(operationBindings.deploymentId, deploymentIds))
          .returning({ id: operationBindings.id });
        const releasedLeases = await tx
          .update(activationLeases)
          .set({ releasedAt: new Date() })
          .where(
            and(
              inArray(activationLeases.deploymentId, deploymentIds),
              isNull(activationLeases.releasedAt),
            ),
          )
          .returning({ id: activationLeases.id });
        // The schedule-run status vocabulary has no dedicated "cancelled";
        // a managed termination is a failure with an explicit, stable reason.
        const cancelledScheduleRuns = await tx
          .update(scheduleRuns)
          .set({
            status: "failed",
            error: "workflow_unavailable: cancelled by a managed-termination operation.",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              inArray(scheduleRuns.deploymentId, deploymentIds),
              inArray(scheduleRuns.status, ["queued", "activating", "dispatching", "running"]),
            ),
          )
          .returning({ id: scheduleRuns.id });
        return {
          failedSessions: failedSessions.length,
          failedSessionNodes: failedNodes.length,
          tombstonedFamilies: families.filter((family) => family.eveSessionId).length,
          removedSessionBindings: removedSessionBindings.length,
          removedOperationBindings: removedOperationBindings.length,
          releasedLeases: releasedLeases.length,
          cancelledScheduleRuns: cancelledScheduleRuns.length,
        };
      });
    },
  };
}

function operationRowToOperation(row: {
  id: string;
  kind: string;
  phase: string;
  scope: unknown;
  checkpoints: unknown;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}): WorkflowCutoverOperation {
  return {
    id: row.id,
    kind: row.kind as WorkflowCutoverOperation["kind"],
    phase: row.phase as WorkflowCutoverPhase,
    scope: (row.scope ?? {}) as Record<string, unknown>,
    checkpoints: (row.checkpoints ?? {}) as Record<string, unknown>,
    lastError: row.lastError,
    createdAt: timestampToIso(row.createdAt),
    updatedAt: timestampToIso(row.updatedAt),
  };
}

function fenceRowToFence(row: {
  id: string;
  scopeKind: string;
  scopeId: string;
  operationId: string;
  reason: string;
  createdAt: Date;
  resolvedAt: Date | null;
}): WorkflowFence {
  return {
    id: row.id,
    scopeKind: row.scopeKind as WorkflowFence["scopeKind"],
    scopeId: row.scopeId,
    operationId: row.operationId,
    reason: row.reason,
    createdAt: timestampToIso(row.createdAt),
    resolvedAt: timestampToIso(row.resolvedAt),
  };
}
