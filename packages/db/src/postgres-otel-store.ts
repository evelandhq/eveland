import { createHash } from "node:crypto";
import { createId } from "@eveland/core/ids";
import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import {
  modelUsageEvents,
  otlpBatches,
  sessionEvents,
  sessionNodes,
  sessions,
} from "./schema.js";
import type { ObservabilityStore } from "./store-domains.js";
import type { PostgresStoreContext } from "./postgres-store-support.js";

type PostgresOtlpDomain = Pick<
  ObservabilityStore,
  | "ingestOtlpBatch"
  | "latestOtlpBatchReceivedAt"
  | "pruneOtlpTelemetry"
  | "pruneDerivedAgentTelemetry"
>;

export function createPostgresOtlpStore(
  context: PostgresStoreContext,
): PostgresOtlpDomain {
  const { db } = context;
  return {
    async ingestOtlpBatch(input) {
      const payloadHash = createHash("sha256")
        .update(stableJson(input.payload))
        .digest("hex");
      const [inserted] = await db
        .insert(otlpBatches)
        .values({
          id: createId("otb"),
          signal: input.signal,
          payloadHash,
        })
        .onConflictDoNothing({
          target: [otlpBatches.signal, otlpBatches.payloadHash],
        })
        .returning();
      if (inserted) {
        return {
          id: inserted.id,
          accepted: true as const,
          duplicate: false,
        };
      }

      const [existing] = await db
        .select({ id: otlpBatches.id })
        .from(otlpBatches)
        .where(
          and(
            eq(otlpBatches.signal, input.signal),
            eq(otlpBatches.payloadHash, payloadHash),
          ),
        )
        .limit(1);
      if (!existing) {
        throw new Error("OTLP batch deduplication state is unavailable.");
      }
      return {
        id: existing.id,
        accepted: true as const,
        duplicate: true,
      };
    },

    async latestOtlpBatchReceivedAt(input = {}) {
      const rows = input.signal
        ? await db
            .select({ receivedAt: otlpBatches.receivedAt })
            .from(otlpBatches)
            .where(eq(otlpBatches.signal, input.signal))
            .orderBy(desc(otlpBatches.receivedAt))
            .limit(1)
        : await db
            .select({ receivedAt: otlpBatches.receivedAt })
            .from(otlpBatches)
            .orderBy(desc(otlpBatches.receivedAt))
            .limit(1);
      return rows[0]?.receivedAt.toISOString() ?? null;
    },

    async pruneOtlpTelemetry(input) {
      const receipts = await db
        .delete(otlpBatches)
        .where(lt(otlpBatches.receivedAt, input.receiptsBefore))
        .returning({ id: otlpBatches.id });
      return { receipts: receipts.length };
    },

    async pruneDerivedAgentTelemetry(before) {
      return db.transaction(async (tx) => {
        const expired = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              ne(sessions.status, "running"),
              sql`coalesce(${sessions.completedAt}, ${sessions.startedAt}) < ${before.toISOString()}::timestamptz`,
            ),
          );
        const sessionIds = expired.map((row) => row.id);
        if (sessionIds.length === 0) {
          return {
            sessions: 0,
            nodes: 0,
            events: 0,
            usageEvents: 0,
          };
        }

        const usageRows = await tx
          .delete(modelUsageEvents)
          .where(inArray(modelUsageEvents.sessionId, sessionIds))
          .returning({ id: modelUsageEvents.id });
        const eventRows = await tx
          .delete(sessionEvents)
          .where(inArray(sessionEvents.sessionId, sessionIds))
          .returning({ id: sessionEvents.id });
        const nodeRows = await tx
          .delete(sessionNodes)
          .where(inArray(sessionNodes.rootSessionId, sessionIds))
          .returning({ id: sessionNodes.id });
        const sessionRows = await tx
          .delete(sessions)
          .where(inArray(sessions.id, sessionIds))
          .returning({ id: sessions.id });
        return {
          sessions: sessionRows.length,
          nodes: nodeRows.length,
          events: eventRows.length,
          usageEvents: usageRows.length,
        };
      });
    },
  };
}

/**
 * Key-order-independent serialization. The batch hash is the replay guard, so two
 * encodings of the same payload must not produce different receipts.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
