import {
  createDefaultObservabilityPolicy,
  observabilityPolicySchema,
  type ObservabilityPolicy,
} from "@eveland/core/observability";
import { eq } from "drizzle-orm";
import { observabilityPolicies } from "./schema.js";
import type { ObservabilityStore } from "./store-domains.js";
import type {
  PostgresDomain,
  PostgresStoreContext,
} from "./postgres-store-support.js";

export function createPostgresObservabilityStore(
  context: PostgresStoreContext,
): PostgresDomain & Partial<ObservabilityStore> {
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
