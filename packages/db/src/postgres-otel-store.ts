import { createHash } from "node:crypto";
import type {
  ObservabilitySignal,
  TelemetryDomain,
} from "@eveland/core/observability";
import { createId } from "@eveland/core/ids";
import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import {
  modelUsageEvents,
  otlpBatches,
  otlpLogRecords,
  otlpSpans,
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

    async ingestOtlpSpans(spans) {
      if (spans.length === 0) return { inserted: 0 };
      const inserted = await db
        .insert(otlpSpans)
        .values(
          spans.map((span) => ({
            id: createId("otsp"),
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            serviceName: span.resource.serviceName,
            domain: span.resource.domain,
            projectId: span.resource.projectId,
            deploymentId: span.resource.deploymentId,
            name: span.name,
            kind: span.kind,
            startedAt: new Date(span.startedAt),
            endedAt: new Date(span.endedAt),
            durationMs: span.durationMs,
            statusCode: span.statusCode,
            statusMessage: span.statusMessage,
            scopeName: span.scopeName,
            attributes: span.attributes,
            resourceAttributes: span.resource.attributes,
            payload: span.payload,
          })),
        )
        .onConflictDoNothing({
          target: [otlpSpans.traceId, otlpSpans.spanId],
        })
        .returning({ id: otlpSpans.id });
      return { inserted: inserted.length };
    },

    async listOtlpSpans(input) {
      const conditions = [sql`true`];
      if (input.domain) {
        conditions.push(eq(otlpSpans.domain, input.domain));
      }
      if (input.serviceName) {
        conditions.push(
          eq(otlpSpans.serviceName, input.serviceName),
        );
      }
      if (input.projectId) {
        conditions.push(eq(otlpSpans.projectId, input.projectId));
      }
      const rows = await db
        .select()
        .from(otlpSpans)
        .where(and(...conditions))
        .orderBy(desc(otlpSpans.startedAt))
        .limit(clampActivityLimit(input.limit));
      return rows.map((row) => ({
        id: row.id,
        traceId: row.traceId,
        spanId: row.spanId,
        parentSpanId: row.parentSpanId,
        name: row.name,
        kind: row.kind,
        startedAt: row.startedAt.toISOString(),
        endedAt: row.endedAt.toISOString(),
        durationMs: row.durationMs,
        statusCode: row.statusCode,
        statusMessage: row.statusMessage,
        scopeName: row.scopeName,
        attributes: asRecord(row.attributes),
        resource: {
          serviceName: row.serviceName,
          domain: row.domain as TelemetryDomain,
          projectId: row.projectId,
          deploymentId: row.deploymentId,
          attributes: asRecord(row.resourceAttributes),
        },
        payload: asRecord(row.payload),
        receivedAt: row.receivedAt.toISOString(),
      }));
    },

    async ingestOtlpLogRecords(records) {
      if (records.length === 0) return { inserted: 0 };
      const inserted = await db
        .insert(otlpLogRecords)
        .values(
          records.map((record) => ({
            id: createId("otlg"),
            fingerprint: createHash("sha256")
              .update(JSON.stringify(record))
              .digest("hex"),
            traceId: record.traceId,
            spanId: record.spanId,
            serviceName: record.resource.serviceName,
            domain: record.resource.domain,
            projectId: record.resource.projectId,
            deploymentId: record.resource.deploymentId,
            timestamp: new Date(record.timestamp),
            observedTimestamp: record.observedTimestamp
              ? new Date(record.observedTimestamp)
              : null,
            severityNumber: record.severityNumber,
            severityText: record.severityText,
            eventName: record.eventName,
            scopeName: record.scopeName,
            body: record.body ?? null,
            attributes: record.attributes,
            resourceAttributes: record.resource.attributes,
            payload: record.payload,
          })),
        )
        .onConflictDoNothing({
          target: otlpLogRecords.fingerprint,
        })
        .returning({ id: otlpLogRecords.id });
      return { inserted: inserted.length };
    },

    async listOtlpLogRecords(input) {
      const conditions = [sql`true`];
      if (input.domain) {
        conditions.push(eq(otlpLogRecords.domain, input.domain));
      }
      if (input.serviceName) {
        conditions.push(
          eq(otlpLogRecords.serviceName, input.serviceName),
        );
      }
      if (input.projectId) {
        conditions.push(
          eq(otlpLogRecords.projectId, input.projectId),
        );
      }
      const rows = await db
        .select()
        .from(otlpLogRecords)
        .where(and(...conditions))
        .orderBy(desc(otlpLogRecords.timestamp))
        .limit(clampActivityLimit(input.limit));
      return rows.map((row) => ({
        id: row.id,
        traceId: row.traceId,
        spanId: row.spanId,
        timestamp: row.timestamp.toISOString(),
        observedTimestamp:
          row.observedTimestamp?.toISOString() ?? null,
        severityNumber: row.severityNumber,
        severityText: row.severityText,
        eventName: row.eventName,
        scopeName: row.scopeName,
        body: row.body,
        attributes: asRecord(row.attributes),
        resource: {
          serviceName: row.serviceName,
          domain: row.domain as TelemetryDomain,
          projectId: row.projectId,
          deploymentId: row.deploymentId,
          attributes: asRecord(row.resourceAttributes),
        },
        payload: asRecord(row.payload),
        receivedAt: row.receivedAt.toISOString(),
      }));
    },

    async pruneOtlpTelemetry(input) {
      const cutoffs = {
        traces: input.tracesBefore,
        logs: input.logsBefore,
        metrics: input.metricsBefore,
      } as const;
      const rawCounts = await Promise.all(
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
      const [spans, logs] = await Promise.all([
        db
          .delete(otlpSpans)
          .where(lt(otlpSpans.startedAt, input.tracesBefore))
          .returning({ id: otlpSpans.id }),
        db
          .delete(otlpLogRecords)
          .where(lt(otlpLogRecords.timestamp, input.logsBefore))
          .returning({ id: otlpLogRecords.id }),
      ]);
      const counts = Object.fromEntries(rawCounts) as Record<
        ObservabilitySignal,
        number
      >;
      return {
        traces: counts.traces + spans.length,
        logs: counts.logs + logs.length,
        metrics: counts.metrics,
      };
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

function clampActivityLimit(value: number): number {
  return Math.max(1, Math.min(1_000, value));
}
