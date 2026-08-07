import {
  dropTenantPartitions,
  ensureTenantPartitions,
  runMigrations,
} from "@evelandhq/workflow-world/migrate";
import { Pool } from "pg";

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
): Promise<void> {
  const pool = new Pool({ connectionString: worldUrl, max: 1 });
  try {
    await runMigrations(pool);
    await ensureTenantPartitions(pool, projectId);
  } finally {
    await pool.end().catch(() => {});
  }
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
