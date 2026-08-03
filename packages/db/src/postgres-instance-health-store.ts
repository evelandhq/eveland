import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { createId } from "@eveland/core/ids";
import { HEAVY_JOB_TYPES } from "@eveland/core/jobs";
import type { HostMetricSample, WorkerHeartbeat } from "@eveland/core/instance-health";
import { hostMetricSamples, jobs, runtimeInstances, workerHeartbeats } from "./schema.js";
import type { InstanceHealthStore } from "./store-domains.js";
import type { PostgresStoreContext } from "./postgres-store-support.js";

export function createPostgresInstanceHealthStore(
  context: PostgresStoreContext,
): InstanceHealthStore {
  const { db } = context;
  return {
    async upsertWorkerHeartbeat(heartbeat) {
      const values = toHeartbeatRow(heartbeat);
      const [row] = await db
        .insert(workerHeartbeats)
        .values(values)
        .onConflictDoUpdate({
          target: workerHeartbeats.workerId,
          set: values,
          // Metrics delivery is at least once, so an older batch can be
          // redelivered. Letting it win would move observedAt backwards and make
          // a healthy worker look stale on the health page.
          setWhere: lte(workerHeartbeats.observedAt, values.observedAt),
        })
        .returning();
      if (row) return heartbeatRowToRecord(row);
      const [current] = await db
        .select()
        .from(workerHeartbeats)
        .where(eq(workerHeartbeats.workerId, heartbeat.workerId))
        .limit(1);
      if (!current) throw new Error("Failed to publish Worker heartbeat.");
      return heartbeatRowToRecord(current);
    },

    async listWorkerHeartbeats() {
      const rows = await db
        .select()
        .from(workerHeartbeats)
        .orderBy(desc(workerHeartbeats.observedAt));
      return rows.map(heartbeatRowToRecord);
    },

    async recordHostMetric(sample) {
      const [row] = await db
        .insert(hostMetricSamples)
        .values({
          ...sample,
          id: createId("metric"),
          observedAt: new Date(sample.observedAt),
        })
        .onConflictDoUpdate({
          target: [hostMetricSamples.workerId, hostMetricSamples.observedAt],
          set: {
            cpuPercent: sample.cpuPercent,
            load1: sample.load1,
            memoryTotalBytes: sample.memoryTotalBytes,
            memoryAvailableBytes: sample.memoryAvailableBytes,
            diskTotalBytes: sample.diskTotalBytes,
            diskAvailableBytes: sample.diskAvailableBytes,
            diskInodesTotal: sample.diskInodesTotal,
            diskInodesAvailable: sample.diskInodesAvailable,
            cpuCores: sample.cpuCores,
            pgConnections: sample.pgConnections,
          },
        })
        .returning();
      if (!row) throw new Error("Failed to record host metric sample.");
      return metricRowToRecord(row);
    },

    async listHostMetrics(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1) {
        throw new Error("Host metric list limit must be positive.");
      }
      const predicates = [
        ...(input.workerId ? [eq(hostMetricSamples.workerId, input.workerId)] : []),
        ...(input.since ? [gte(hostMetricSamples.observedAt, input.since)] : []),
      ];
      const rows = await db
        .select()
        .from(hostMetricSamples)
        .where(predicates.length ? and(...predicates) : undefined)
        .orderBy(desc(hostMetricSamples.observedAt))
        .limit(input.limit);
      return rows.reverse().map(metricRowToRecord);
    },

    async pruneHostMetrics(before) {
      const rows = await db
        .delete(hostMetricSamples)
        .where(lt(hostMetricSamples.observedAt, before))
        .returning({ id: hostMetricSamples.id });
      return rows.length;
    },

    async getInstanceWorkload() {
      const heavyTypes = sql.join(
        HEAVY_JOB_TYPES.map((type) => sql`${type}`),
        sql`, `,
      );
      const [jobGroups, runtimeGroups] = await Promise.all([
        db
          .select({
            status: jobs.status,
            count: sql<number>`count(*)::int`,
            heavyCount: sql<number>`count(*) filter (where ${jobs.type} in (${heavyTypes}))::int`,
            oldest: sql<Date | null>`min(${jobs.createdAt})`,
          })
          .from(jobs)
          .where(inArray(jobs.status, ["queued", "running"]))
          .groupBy(jobs.status)
          .orderBy(asc(jobs.status)),
        db
          .select({ status: runtimeInstances.status, count: sql<number>`count(*)::int` })
          .from(runtimeInstances)
          .groupBy(runtimeInstances.status),
      ]);
      const runtimeCounts = { starting: 0, ready: 0, draining: 0, stopped: 0, failed: 0 };
      for (const group of runtimeGroups) {
        if (group.status in runtimeCounts)
          runtimeCounts[group.status as keyof typeof runtimeCounts] = group.count;
      }
      const queued = jobGroups.find((group) => group.status === "queued");
      const running = jobGroups.find((group) => group.status === "running");
      return {
        queuedJobs: queued?.count ?? 0,
        runningJobs: running?.count ?? 0,
        runningHeavyJobs: running?.heavyCount ?? 0,
        oldestQueuedAt: timestampToIso(queued?.oldest),
        runtimeInstances: runtimeCounts,
      };
    },
  };
}

function timestampToIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return null;
}

function toHeartbeatRow(heartbeat: WorkerHeartbeat) {
  return {
    ...heartbeat,
    startedAt: new Date(heartbeat.startedAt),
    observedAt: new Date(heartbeat.observedAt),
  };
}

function heartbeatRowToRecord(row: typeof workerHeartbeats.$inferSelect): WorkerHeartbeat {
  return {
    ...row,
    startedAt: row.startedAt.toISOString(),
    observedAt: row.observedAt.toISOString(),
  };
}

function metricRowToRecord(row: typeof hostMetricSamples.$inferSelect): HostMetricSample {
  return { ...row, observedAt: row.observedAt.toISOString() };
}
