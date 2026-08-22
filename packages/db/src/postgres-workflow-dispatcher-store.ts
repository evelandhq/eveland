import type { WorkflowDispatcherRegistration } from "@evelandhq/core/contracts";
import { desc } from "drizzle-orm";
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
        startedAt: new Date(input.startedAt),
        readyAt: input.readyAt ? new Date(input.readyAt) : null,
        lastHeartbeatAt: now,
      };
      const [row] = await db
        .insert(workflowDispatcherRegistrations)
        .values(values)
        .onConflictDoUpdate({
          target: workflowDispatcherRegistrations.instanceId,
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
    startedAt: timestampToIso(row.startedAt),
    readyAt: timestampToIso(row.readyAt),
    lastHeartbeatAt: timestampToIso(row.lastHeartbeatAt),
  };
}
