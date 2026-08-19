import type { WorkflowDispatcherRegistration } from "@evelandhq/core/contracts";
import { desc, eq } from "drizzle-orm";
import { timestampToIso } from "./mappers.js";
import { workflowDispatcherRegistrations } from "./schema.js";
import type { WorkflowDispatcherStore } from "./store-domains.js";
import type { PostgresStoreContext } from "./postgres-store-support.js";

export function createPostgresWorkflowDispatcherStore(
  context: PostgresStoreContext,
): WorkflowDispatcherStore {
  const { db } = context;

  return {
    async recordWorkflowDispatcherHeartbeat(input) {
      const now = new Date();
      const values = {
        instanceId: input.instanceId,
        generation: input.generation,
        state: input.state,
        ownershipAcquired: input.ownershipAcquired,
        bootRecoveryCompleted: input.bootRecoveryCompleted,
        reenqueuedRuns: input.reenqueuedRuns,
        worldDatabaseIdentity: input.worldDatabaseIdentity,
        schemaGeneration: input.schemaGeneration,
        protocolMin: input.protocolMin,
        protocolMax: input.protocolMax,
        cutoverOperationId: input.cutoverOperationId,
        unscopedRunnableJobs: input.unscopedRunnableJobs,
        unresolvedQuarantines: input.unresolvedQuarantines,
        startedAt: new Date(input.startedAt),
        readyAt: input.readyAt ? new Date(input.readyAt) : null,
        lastHeartbeatAt: now,
      };
      const [row] = await db
        .insert(workflowDispatcherRegistrations)
        .values({
          ...values,
          // A dispatcher that reports `ready` was started unpaused; anything
          // else waits for an explicit, authenticated resume.
          desiredState: input.state === "ready" ? "ready" : "paused",
        })
        .onConflictDoUpdate({
          target: workflowDispatcherRegistrations.instanceId,
          // desiredState is deliberately not in the update set: the heartbeat
          // reports state, it never grants itself permission to claim.
          set: values,
        })
        .returning();
      if (!row) throw new Error("Failed to record the workflow dispatcher heartbeat.");
      return rowToRegistration(row);
    },

    async getWorkflowDispatcherRegistration() {
      const [row] = await db
        .select()
        .from(workflowDispatcherRegistrations)
        .orderBy(desc(workflowDispatcherRegistrations.lastHeartbeatAt))
        .limit(1);
      return row ? rowToRegistration(row) : null;
    },

    async setWorkflowDispatcherDesiredState(instanceId, desiredState) {
      const [row] = await db
        .update(workflowDispatcherRegistrations)
        .set({ desiredState })
        .where(eq(workflowDispatcherRegistrations.instanceId, instanceId))
        .returning();
      return row ? rowToRegistration(row) : null;
    },
  };
}

function rowToRegistration(row: {
  instanceId: string;
  generation: string;
  state: string;
  ownershipAcquired: boolean;
  bootRecoveryCompleted: boolean;
  reenqueuedRuns: number | null;
  worldDatabaseIdentity: string;
  schemaGeneration: string | null;
  protocolMin: number;
  protocolMax: number;
  cutoverOperationId: string | null;
  unscopedRunnableJobs: number | null;
  unresolvedQuarantines: number | null;
  desiredState: string;
  startedAt: Date;
  readyAt: Date | null;
  lastHeartbeatAt: Date;
}): WorkflowDispatcherRegistration {
  return {
    instanceId: row.instanceId,
    generation: row.generation,
    state: row.state as WorkflowDispatcherRegistration["state"],
    ownershipAcquired: row.ownershipAcquired,
    bootRecoveryCompleted: row.bootRecoveryCompleted,
    reenqueuedRuns: row.reenqueuedRuns,
    worldDatabaseIdentity: row.worldDatabaseIdentity,
    schemaGeneration: row.schemaGeneration,
    protocolMin: row.protocolMin,
    protocolMax: row.protocolMax,
    cutoverOperationId: row.cutoverOperationId,
    unscopedRunnableJobs: row.unscopedRunnableJobs,
    unresolvedQuarantines: row.unresolvedQuarantines,
    desiredState: row.desiredState as WorkflowDispatcherRegistration["desiredState"],
    startedAt: timestampToIso(row.startedAt),
    readyAt: timestampToIso(row.readyAt),
    lastHeartbeatAt: timestampToIso(row.lastHeartbeatAt),
  };
}
