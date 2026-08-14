import type { Pool } from "pg";
import { describe, expect, test, vi } from "vitest";
import { createSharedWorkflowWorldReaper } from "./shared-workflow-world-reaper.js";

describe("createSharedWorkflowWorldReaper", () => {
  test("returns an unconfigured no-op without creating a pool", async () => {
    const createPool = vi.fn();
    const prune = vi.fn();
    const reaper = createSharedWorkflowWorldReaper({ createPool, prune });

    await expect(reaper.sweep({})).resolves.toEqual({
      configured: false,
      deletedRows: 0,
      batches: 0,
      hitBatchLimit: false,
      lockAcquired: false,
    });
    expect(createPool).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });

  test("prefers the bootstrap URL and passes the production defaults", async () => {
    const pool = fakePool();
    const createPool = vi.fn(() => pool);
    const prune = vi.fn(async () => ({
      deletedRows: 17,
      batches: 2,
      hitBatchLimit: false,
      lockAcquired: true,
    }));
    const reaper = createSharedWorkflowWorldReaper({ createPool, prune });

    await expect(
      reaper.sweep({
        EVELAND_WORKFLOW_WORLD_URL: "postgres://runtime:secret@runtime-db/world",
        EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL: "postgres://host:secret@host-db/world",
      }),
    ).resolves.toEqual({
      configured: true,
      deletedRows: 17,
      batches: 2,
      hitBatchLimit: false,
      lockAcquired: true,
    });

    expect(createPool).toHaveBeenCalledWith("postgres://host:secret@host-db/world");
    expect(prune).toHaveBeenCalledWith(pool, {
      retentionMs: 86_400_000,
      batchSize: 50_000,
      maxBatches: 20,
    });
  });

  test("sanitizes invalid environment values and reuses its one-connection pool", async () => {
    const pool = fakePool();
    const createPool = vi.fn(() => pool);
    const prune = vi.fn(async () => ({
      deletedRows: 0,
      batches: 1,
      hitBatchLimit: false,
      lockAcquired: true,
    }));
    const reaper = createSharedWorkflowWorldReaper({ createPool, prune });
    const env = {
      EVELAND_WORKFLOW_WORLD_URL: "postgres://host:secret@host-db/world",
      EVELAND_WORKFLOW_STREAM_RETENTION_MS: "not-a-number",
      EVELAND_WORKFLOW_SWEEP_BATCH_SIZE: "0",
      EVELAND_WORKFLOW_SHARED_SWEEP_MAX_BATCHES: "1.5",
    };

    await reaper.sweep(env);
    await reaper.sweep(env);

    expect(createPool).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledTimes(2);
    expect(prune).toHaveBeenLastCalledWith(pool, {
      retentionMs: 86_400_000,
      batchSize: 50_000,
      maxBatches: 20,
    });
  });

  test("closes the retained pool and may be closed repeatedly", async () => {
    const pool = fakePool();
    const createPool = vi.fn(() => pool);
    const prune = vi.fn(async () => ({
      deletedRows: 0,
      batches: 0,
      hitBatchLimit: false,
      lockAcquired: false,
    }));
    const reaper = createSharedWorkflowWorldReaper({ createPool, prune });

    await reaper.sweep({ EVELAND_WORKFLOW_WORLD_URL: "postgres://host:secret@host-db/world" });
    await reaper.close();
    await reaper.close();

    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});

function fakePool(): Pool {
  return { end: vi.fn(async () => {}) } as unknown as Pool;
}
