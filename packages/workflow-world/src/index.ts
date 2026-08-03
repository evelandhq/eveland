import type { Storage, World } from "@workflow/world";
import { SPEC_VERSION_CURRENT } from "@workflow/world";
import { Pool } from "pg";
import {
  type EvelandWorldConfig,
  type ResolvedWorldConfig,
  resolveConnectionString,
  resolveRunnerMode,
} from "./config.js";
import { createClient, type Drizzle } from "./drizzle/index.js";
import { createQueue } from "./queue.js";
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from "./storage.js";
import { createStreamer } from "./streamer.js";
import { assertValidTenantId } from "./tenant.js";
import { reenqueueTenantRuns } from "./recovery.js";

export type { EvelandWorldConfig, WorkflowRunnerMode } from "./config.js";
export * from "./dispatch-contract.js";
export { MessageData } from "./message.js";
export {
  dropTenantPartitions,
  ensureTenantPartitions,
  resolveMigrationsDir,
  runMigrations,
  tenantPartitionsExist,
} from "./migrate.js";
export { reenqueueTenantRuns } from "./recovery.js";
export { derivePartitionName, tenantStreamChannel } from "./tenant.js";
export * from "./drizzle/schema.js";

function createStorage(drizzle: Drizzle, tenantId: string): Storage {
  return {
    runs: createRunsStorage(drizzle, tenantId),
    events: createEventsStorage(drizzle, tenantId),
    hooks: createHooksStorage(drizzle, tenantId),
    steps: createStepsStorage(drizzle, tenantId),
  };
}

function getDefaultMaxPoolSize(): number | undefined {
  const parsed = parseInt(process.env.WORKFLOW_POSTGRES_MAX_POOL_SIZE || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `${name} is required by @eveland/workflow-world. The platform injects it into every deployment; a missing value means the build did not go through Eveland's release preparation.`,
    );
  }
  return value;
}

function resolveConfig(config: EvelandWorldConfig): ResolvedWorldConfig {
  const tenantId = required(
    config.tenantId ?? process.env.EVELAND_PROJECT_ID,
    "EVELAND_PROJECT_ID",
  );
  assertValidTenantId(tenantId);
  return {
    tenantId,
    deploymentId: required(
      config.deploymentId ?? process.env.EVELAND_DEPLOYMENT_ID,
      "EVELAND_DEPLOYMENT_ID",
    ),
    runner: config.runner ?? resolveRunnerMode(process.env.EVELAND_WORKFLOW_RUNNER),
    ...(config.port !== undefined ? { port: config.port } : {}),
    queueConcurrency:
      config.queueConcurrency ??
      parseInt(process.env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY || "", 10) ??
      50,
    ...(config.streamFlushIntervalMs !== undefined
      ? { streamFlushIntervalMs: config.streamFlushIntervalMs }
      : {}),
  };
}

export function createWorld(
  config: EvelandWorldConfig = {} as EvelandWorldConfig,
): World & { start(): Promise<void> } {
  const resolved = resolveConfig(config);
  if (!Number.isFinite(resolved.queueConcurrency) || resolved.queueConcurrency <= 0) {
    resolved.queueConcurrency = 50;
  }

  const maxPoolSize = config.maxPoolSize ?? getDefaultMaxPoolSize();
  const pool =
    config.pool ||
    new Pool({
      connectionString: config.connectionString || resolveConnectionString(process.env),
      ...(maxPoolSize !== undefined ? { max: maxPoolSize } : {}),
    });

  const drizzle = createClient(pool);
  const queue = createQueue(resolved, pool);
  const storage = createStorage(drizzle, resolved.tenantId);
  const streamer = createStreamer(pool, drizzle, resolved.tenantId);

  return {
    /**
     * eve compiles a literal `world.specVersion !== 5` check per release, so
     * this must track the `@workflow/world` line the package depends on. The
     * contract test asserts the two still agree against the installed eve.
     */
    specVersion: SPEC_VERSION_CURRENT,
    ...storage,
    ...streamer,
    ...queue,
    ...(resolved.streamFlushIntervalMs !== undefined && {
      streamFlushIntervalMs: resolved.streamFlushIntervalMs,
    }),
    /**
     * Deliberately left false even though external mode looks like the managed
     * platform case this flag describes. eve reacts to `true` by calling
     * `process.exit(1)` when a run exhausts its replay budget, and this process
     * also serves the project's chat and scheduler traffic — recycling one run
     * must not drop unrelated in-flight sessions. Failures surface through the
     * event log instead.
     */
    processExitTriggersQueueRedelivery: false,
    /**
     * The promote-follows hook: eve calls this when a run is started with
     * `deploymentId: 'latest'`. Resolving it to the project's currently
     * promoted deployment is what makes new runs land on the newest code while
     * in-flight runs stay pinned to the deployment that created them.
     *
     * The promoted deployment is whichever one is serving this process, so the
     * ambient deployment id is the answer — no control-plane call needed.
     */
    async resolveLatestDeploymentId() {
      return resolved.deploymentId;
    },
    async start() {
      await queue.start();
      // Upstream calls `reenqueueActiveRuns`, which lists runs unfiltered and
      // would re-enqueue every project's active runs from any agent's boot.
      // This is the tenant-scoped equivalent, and it is the root fix for the
      // class of bug that per-project databases were papering over.
      await reenqueueTenantRuns({
        runs: storage.runs,
        enqueue: queue.queue,
        tenantId: resolved.tenantId,
      });
    },
    async close() {
      await streamer.close();
      await queue.close();
      if (pool !== config.pool) {
        await pool.end();
      }
    },
  };
}
