import { afterAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase } from "./client.js";
import { createPostgresStore } from "./postgres-store.js";
import { hostMetricSamples, workerHeartbeats } from "./schema.js";

const databaseUrl = process.env.EVELAND_POSTGRES_TEST_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => database?.close());

describe.skipIf(!database)("Postgres instance health", () => {
  test("persists heartbeat replacement and ordered metric history", async () => {
    const workerId = `integration-worker-${Date.now()}`;
    const store = createPostgresStore(database!);
    try {
      await store.upsertWorkerHeartbeat({
        workerId,
        startedAt: "2026-07-18T08:00:00.000Z",
        observedAt: "2026-07-18T10:00:00.000Z",
        intervalMs: 5_000,
        lastTickDurationMs: 80,
        lastError: null,
        maxConcurrentHeavyJobs: 2,
      });
      await store.upsertWorkerHeartbeat({
        workerId,
        startedAt: "2026-07-18T08:00:00.000Z",
        observedAt: "2026-07-18T10:00:05.000Z",
        intervalMs: 5_000,
        lastTickDurationMs: 90,
        lastError: null,
        maxConcurrentHeavyJobs: 2,
      });
      for (const observedAt of ["2026-07-18T09:59:00.000Z", "2026-07-18T10:00:00.000Z"]) {
        await store.recordHostMetric({
          workerId,
          observedAt,
          cpuPercent: 25,
          load1: 0.5,
          memoryTotalBytes: 16_000,
          memoryAvailableBytes: 8_000,
          diskTotalBytes: 100_000,
          diskAvailableBytes: 60_000,
          diskInodesTotal: 10_000,
          diskInodesAvailable: 9_000,
          cpuCores: 4,
          pgConnections: [
            { role: "shared", usedConnections: 42, maxConnections: 100, agentPoolSize: 10 },
          ],
        });
      }

      expect(
        (await store.listWorkerHeartbeats()).filter((entry) => entry.workerId === workerId),
      ).toEqual([
        expect.objectContaining({ observedAt: "2026-07-18T10:00:05.000Z", lastTickDurationMs: 90 }),
      ]);
      expect(
        (await store.listHostMetrics({ workerId, limit: 10 })).map((sample) => sample.observedAt),
      ).toEqual(["2026-07-18T09:59:00.000Z", "2026-07-18T10:00:00.000Z"]);
    } finally {
      await database!.db.delete(hostMetricSamples).where(eq(hostMetricSamples.workerId, workerId));
      await database!.db.delete(workerHeartbeats).where(eq(workerHeartbeats.workerId, workerId));
    }
  });
});
