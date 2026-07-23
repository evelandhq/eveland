import { createHash } from "node:crypto";
import type { ObservabilitySignal } from "@eveland/core/observability";
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
import type {
  PostgresDomain,
  PostgresStoreContext,
} from "./postgres-store-support.js";

export function createPostgresOtlpStore(
  context: PostgresStoreContext,
): PostgresDomain & Partial<ObservabilityStore> {
  const { db } = context;
  return {
    async ingestOtlpBatch(input) {
      const payloadHash = createHash("sha256")
        .update(JSON.stringify(input.payload))
        .digest("hex");
      const [inserted] = await db
        .insert(otlpBatches)
        .values({
          id: createId("otb"),
          signal: input.signal,
          payloadHash,
          payload: input.payload,
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

    async listOtlpBatches(input = {}) {
      const limit = Math.max(1, Math.min(1_000, input.limit ?? 100));
      const rows = input.signal
        ? await db
            .select()
            .from(otlpBatches)
            .where(eq(otlpBatches.signal, input.signal))
            .orderBy(desc(otlpBatches.receivedAt))
            .limit(limit)
        : await db
            .select()
            .from(otlpBatches)
            .orderBy(desc(otlpBatches.receivedAt))
            .limit(limit);
      return rows.map((row) => ({
        id: row.id,
        signal: row.signal as ObservabilitySignal,
        payload: asRecord(row.payload),
        receivedAt: row.receivedAt.toISOString(),
      }));
    },

    async pruneOtlpBatches(input) {
      const cutoffs = {
        traces: input.tracesBefore,
        logs: input.logsBefore,
        metrics: input.metricsBefore,
      } as const;
      const counts = await Promise.all(
        (["traces", "logs", "metrics"] as const).map(async (signal) => {
          const rows = await db
            .delete(otlpBatches)
            .where(
              and(
                eq(otlpBatches.signal, signal),
                lt(otlpBatches.receivedAt, cutoffs[signal]),
              ),
            )
            .returning({ id: otlpBatches.id });
          return [signal, rows.length] as const;
        }),
      );
      return Object.fromEntries(counts) as Record<
        ObservabilitySignal,
        number
      >;
    },

    async pruneDerivedAgentTelemetry(before) {
      return db.transaction(async (tx) => {
        const expired = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              ne(sessions.status, "running"),
              lt(
                sql<Date>`coalesce(${sessions.completedAt}, ${sessions.startedAt})`,
                before,
              ),
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

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid stored OTLP batch.");
  }
  return value as Record<string, unknown>;
}
