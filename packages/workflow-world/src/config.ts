import type { Pool } from "pg";

/**
 * `embedded` keeps today's topology: the world runs its own graphile runner
 * in-process and POSTs vqs messages to the executor over loopback, exactly as
 * world-postgres does. It stays supported forever because it is the local
 * development story.
 *
 * `external` starts no runner at all — the platform dispatcher claims this
 * tenant's jobs out of the shared database and POSTs them back in. That is what
 * makes a durable timer fire on a project whose agent has been idle-reaped.
 */
export type WorkflowRunnerMode = "embedded" | "external";

type PgConnectionConfig =
  | { connectionString: string; maxPoolSize?: number; pool?: undefined }
  | { pool: Pool; connectionString?: undefined; maxPoolSize?: undefined };

export type EvelandWorldConfig = PgConnectionConfig & {
  /** Eveland project id. Falls back to `EVELAND_PROJECT_ID`. */
  tenantId?: string;
  /** Eveland deployment id. Falls back to `EVELAND_DEPLOYMENT_ID`. */
  deploymentId?: string;
  /** Falls back to `EVELAND_WORKFLOW_RUNNER`, then `embedded`. */
  runner?: WorkflowRunnerMode;
  /** Port of the local eve executor, for embedded dispatch. */
  port?: number;
  queueConcurrency?: number;
  /**
   * Override the flush interval (in ms) for buffered stream writes.
   * Default is 10ms. Set to 0 for immediate flushing.
   */
  streamFlushIntervalMs?: number;
};

/**
 * Resolved, fully-defaulted configuration. Everything downstream reads this
 * rather than `process.env`, so tests can construct a world without touching
 * the ambient environment.
 */
export type ResolvedWorldConfig = {
  tenantId: string;
  deploymentId: string;
  runner: WorkflowRunnerMode;
  port?: number;
  queueConcurrency: number;
  streamFlushIntervalMs?: number;
};

export function resolveRunnerMode(value: string | undefined): WorkflowRunnerMode {
  if (value === "external") return "external";
  if (value === "embedded" || value === undefined || value === "") return "embedded";
  throw new Error(`Invalid workflow runner mode "${value}": expected "embedded" or "external".`);
}

export function resolveConnectionString(env: NodeJS.ProcessEnv): string {
  return (
    env.EVELAND_WORKFLOW_WORLD_URL ||
    env.WORKFLOW_POSTGRES_URL ||
    env.DATABASE_URL ||
    "postgres://world:world@localhost:5432/world"
  );
}
