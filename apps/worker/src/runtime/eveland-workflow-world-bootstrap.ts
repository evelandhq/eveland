import {
  dropTenantPartitions,
  ensureTenantPartitions as ensureTenantPartitionsDefault,
  runMigrations,
} from "@evelandhq/workflow-world/migrate";
import { Pool } from "pg";
import { resolveWorkflowWorldPlatformUrl } from "./eveland-workflow-world-url.js";

export type EvelandWorkflowWorldBootstrapDeps = {
  createPool: (connectionString: string) => Pool;
  runMigrations: typeof runMigrations;
  ensureTenantPartitions: typeof ensureTenantPartitionsDefault;
};

const disruptiveMigration = "0006_event_slots.sql";

const defaultBootstrapDeps: EvelandWorkflowWorldBootstrapDeps = {
  createPool: (connectionString) => new Pool({ connectionString, max: 1 }),
  runMigrations,
  ensureTenantPartitions: ensureTenantPartitionsDefault,
};

/** Apply shared-World migrations once at worker startup, before retention runs. */
export async function bootstrapEvelandWorkflowWorld(
  env: NodeJS.ProcessEnv,
  overrides: Partial<EvelandWorkflowWorldBootstrapDeps> = {},
): Promise<boolean> {
  const worldUrl = resolveWorkflowWorldPlatformUrl(env);
  if (!worldUrl) return false;

  const deps = { ...defaultBootstrapDeps, ...overrides };
  const pool = deps.createPool(worldUrl);
  try {
    await assertDisruptiveMigrationReady(pool);
    await deps.runMigrations(pool);
    return true;
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * Provisioning for the platform workflow world (`@evelandhq/workflow-world`).
 *
 * The legacy world provisions a whole database per project
 * ([workflow-world-bootstrap.ts](./workflow-world-bootstrap.ts)); this one only
 * has to create the project's partitions in the shared database. Both are
 * idempotent and both run before any process starts with the world configured.
 *
 * Migrations run here too so a fresh platform install does not require a
 * separate setup step before the first deploy. `runMigrations` takes an
 * advisory lock, so concurrent workers serialize rather than racing.
 */
export async function ensureEvelandWorkflowTenant(
  worldUrl: string,
  projectId: string,
  overrides: Partial<EvelandWorkflowWorldBootstrapDeps> = {},
): Promise<void> {
  const deps = { ...defaultBootstrapDeps, ...overrides };
  const pool = deps.createPool(worldUrl);
  try {
    await assertDisruptiveMigrationReady(pool);
    await deps.runMigrations(pool);
    await deps.ensureTenantPartitions(pool, projectId);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function assertDisruptiveMigrationReady(pool: Pool): Promise<void> {
  const registryResult = await pool.query<{ registry: string | null }>(
    "select to_regclass('workflow.eveland_migrations')::text as registry",
  );
  if (!registryResult.rows[0]?.registry) return;

  const applied = await pool.query<{ name: string }>(
    "select name from workflow.eveland_migrations where name = $1",
    [disruptiveMigration],
  );
  if (applied.rows.length > 0) return;

  throw new Error(
    `Shared workflow-world migration ${disruptiveMigration} requires a maintenance window and will not run during unattended Worker startup or tenant provisioning. Stop workflow traffic, apply it explicitly with EVELAND_WORKFLOW_WORLD_URL=<worker-reachable-url> pnpm --filter @evelandhq/worker exec workflow-world-setup, then restart the Worker.`,
  );
}

/**
 * Deleting a project drops its partitions, which returns the storage
 * immediately instead of leaving dead tuples behind — the same reason the
 * legacy path drops the whole database.
 */
export async function dropEvelandWorkflowTenant(
  worldUrl: string,
  projectId: string,
): Promise<void> {
  const pool = new Pool({ connectionString: worldUrl, max: 1 });
  try {
    await dropTenantPartitions(pool, projectId);
  } finally {
    await pool.end().catch(() => {});
  }
}
