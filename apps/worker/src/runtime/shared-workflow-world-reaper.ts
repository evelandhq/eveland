import { pruneTerminalStreamChunks, type StreamRetentionResult } from "@evelandhq/workflow-world";
import { Pool } from "pg";
import { resolveWorkflowWorldPlatformUrl } from "./eveland-workflow-world-url.js";

export type SharedWorkflowWorldSweepResult = StreamRetentionResult & {
  configured: boolean;
};

export type SharedWorkflowWorldReaperDeps = {
  createPool: (connectionString: string) => Pool;
  prune: typeof pruneTerminalStreamChunks;
};

const defaultDeps: SharedWorkflowWorldReaperDeps = {
  createPool: (connectionString) => new Pool({ connectionString, max: 1 }),
  prune: pruneTerminalStreamChunks,
};

/**
 * Owns the worker's single small administrative pool for shared-World stream
 * retention. SQL and locking remain inside @evelandhq/workflow-world; this
 * wrapper owns product policy, URL selection and lifecycle only.
 */
export function createSharedWorkflowWorldReaper(
  overrides: Partial<SharedWorkflowWorldReaperDeps> = {},
): {
  sweep(env: NodeJS.ProcessEnv): Promise<SharedWorkflowWorldSweepResult>;
  close(): Promise<void>;
} {
  const deps = { ...defaultDeps, ...overrides };
  let pool: Pool | undefined;
  let poolUrl: string | undefined;

  return {
    async sweep(env) {
      const connectionString = resolveWorkflowWorldPlatformUrl(env);
      if (!connectionString) {
        return {
          configured: false,
          deletedRows: 0,
          batches: 0,
          hitBatchLimit: false,
          lockAcquired: false,
        };
      }

      if (pool && poolUrl !== connectionString) {
        await pool.end();
        pool = undefined;
      }
      pool ??= deps.createPool(connectionString);
      poolUrl = connectionString;

      const result = await deps.prune(pool, {
        retentionMs: positiveInteger(env.EVELAND_WORKFLOW_STREAM_RETENTION_MS, 86_400_000, true),
        batchSize: positiveInteger(env.EVELAND_WORKFLOW_SWEEP_BATCH_SIZE, 50_000),
        maxBatches: positiveInteger(env.EVELAND_WORKFLOW_SHARED_SWEEP_MAX_BATCHES, 20),
      });
      return { configured: true, ...result };
    },

    async close() {
      const current = pool;
      pool = undefined;
      poolUrl = undefined;
      if (current) await current.end();
    },
  };
}

function positiveInteger(value: string | undefined, fallback: number, allowZero = false): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}
