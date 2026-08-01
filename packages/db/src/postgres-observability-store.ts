import {
  createDefaultObservabilityPolicy,
  observabilityPolicySchema,
  type ObservabilityPolicy,
} from "@eveland/core/observability";
import { eq } from "drizzle-orm";
import {
  observabilityDestinationHealth,
  observabilityPolicies,
} from "./schema.js";
import type { ObservabilityStore } from "./store-domains.js";
import type { PostgresStoreContext } from "./postgres-store-support.js";

type PostgresObservabilityPolicyDomain = Pick<
  ObservabilityStore,
  | "getObservabilityPolicy"
  | "saveObservabilityPolicy"
  | "listExternalObservabilityDestinationHealth"
  | "upsertExternalObservabilityDestinationHealth"
>;

export function createPostgresObservabilityStore(
  context: PostgresStoreContext,
): PostgresObservabilityPolicyDomain {
  const { db } = context;
  return {
    async getObservabilityPolicy(teamId) {
      const [row] = await db
        .select()
        .from(observabilityPolicies)
        .where(eq(observabilityPolicies.teamId, teamId))
        .limit(1);
      return row ? policyFromRow(row) : createDefaultObservabilityPolicy(1);
    },

    async saveObservabilityPolicy(input) {
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(observabilityPolicies)
          .where(eq(observabilityPolicies.teamId, input.teamId))
          .for("update")
          .limit(1);
        const currentRevision = existing?.revision ?? 1;
        if (currentRevision !== input.expectedRevision) return null;

        const policy = observabilityPolicySchema.parse({
          schemaVersion: 1,
          revision: currentRevision + 1,
          agentCapture: input.agentCapture,
          externalDestinations: input.externalDestinations,
        });
        if (!existing) {
          const [created] = await tx
            .insert(observabilityPolicies)
            .values({
              teamId: input.teamId,
              revision: policy.revision,
              document: policy,
            })
            .onConflictDoNothing({
              target: observabilityPolicies.teamId,
            })
            .returning();
          return created ? policyFromRow(created) : null;
        }

        const [updated] = await tx
          .update(observabilityPolicies)
          .set({
            revision: policy.revision,
            document: policy,
            updatedAt: new Date(),
          })
          .where(eq(observabilityPolicies.teamId, input.teamId))
          .returning();
        return updated ? policyFromRow(updated) : null;
      });
    },

    async listExternalObservabilityDestinationHealth() {
      const rows = await db
        .select()
        .from(observabilityDestinationHealth);
      return rows.map(healthFromRow);
    },

    async upsertExternalObservabilityDestinationHealth(health) {
      const values = {
        destinationId: health.destinationId,
        status: health.status,
        checkedAt: health.checkedAt ? new Date(health.checkedAt) : null,
        lastSuccessAt: health.lastSuccessAt
          ? new Date(health.lastSuccessAt)
          : null,
        lastError: health.lastError,
        updatedAt: new Date(),
      };
      const [row] = await db
        .insert(observabilityDestinationHealth)
        .values(values)
        .onConflictDoUpdate({
          target: observabilityDestinationHealth.destinationId,
          set: values,
        })
        .returning();
      if (!row) {
        throw new Error(
          "Failed to update observability destination health.",
        );
      }
      return healthFromRow(row);
    },
  };
}

function healthFromRow(
  row: typeof observabilityDestinationHealth.$inferSelect,
) {
  return {
    destinationId: row.destinationId,
    status: row.status as
      | "pending"
      | "healthy"
      | "degraded"
      | "paused",
    checkedAt: row.checkedAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastError: row.lastError,
  };
}

function policyFromRow(
  row: typeof observabilityPolicies.$inferSelect,
): ObservabilityPolicy {
  return observabilityPolicySchema.parse({
    ...asRecord(row.document),
    revision: row.revision,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid stored observability policy.");
  }
  return value as Record<string, unknown>;
}
