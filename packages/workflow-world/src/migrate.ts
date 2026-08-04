import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { PARTITIONED_TABLES } from "./drizzle/schema.js";
import { assertValidTenantId, dedupIndexName, derivePartitionName } from "./tenant.js";

/**
 * Migrations are hand-written SQL rather than drizzle-kit output because the
 * partitioned tables are not expressible in drizzle-kit's generator, and a
 * generated file that silently drops `PARTITION BY` would be worse than no
 * generator at all.
 */
const MIGRATIONS_TABLE = "workflow.eveland_migrations";

/**
 * Chosen once and never changed: concurrent `bin/setup` invocations (dev server
 * plus test runner, or two workers booting together) must serialize, and
 * `CREATE SCHEMA IF NOT EXISTS` is famously not race-safe.
 */
export const MIGRATION_LOCK_KEY = 0x65_76_65_77; // "evew"

export function resolveMigrationsDir(): string {
  // dist/migrate.js → package root → migrations/
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
}

export async function runMigrations(
  pool: Pool,
  options: { migrationsDir?: string; log?: (message: string) => void } = {},
): Promise<string[]> {
  const migrationsDir = options.migrationsDir ?? resolveMigrationsDir();
  const log = options.log ?? (() => {});
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();

  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query("create schema if not exists workflow");
    await client.query(
      `create table if not exists ${MIGRATIONS_TABLE} (
         name varchar primary key,
         applied_at timestamptz default now() not null
       )`,
    );
    const { rows } = await client.query<{ name: string }>(`select name from ${MIGRATIONS_TABLE}`);
    const seen = new Set(rows.map((row) => row.name));

    for (const name of files) {
      if (seen.has(name)) continue;
      const sql = await readFile(path.join(migrationsDir, name), "utf8");
      // Each migration is one transaction: a half-applied schema is much harder
      // to reason about than a failed boot.
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(`insert into ${MIGRATIONS_TABLE} (name) values ($1)`, [name]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
      applied.push(name);
      log(`applied ${name}`);
    }
    return applied;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/**
 * Creates this tenant's partitions. Idempotent, and safe to call concurrently:
 * the duplicate_table race between two provisioning paths is treated as
 * success, mirroring how the legacy per-project bootstrap handles
 * duplicate_database.
 */
export async function ensureTenantPartitions(pool: Pool, tenantId: string): Promise<void> {
  assertValidTenantId(tenantId);
  for (const table of PARTITIONED_TABLES) {
    const partition = derivePartitionName(table, tenantId);
    try {
      await pool.query(
        `create table workflow.${quoteIdentifier(partition)} ` +
          `partition of workflow.${quoteIdentifier(table)} ` +
          `for values in (${literal(tenantId)})`,
      );
    } catch (error) {
      if (sqlState(error) !== "42P07") throw error;
    }
  }
  await renameDedupIndex(pool, tenantId);
}

/**
 * Give this tenant's correlated-event dedup index a name the storage layer can
 * predict.
 *
 * A unique violation reports the child index's name, and Postgres derives that
 * from the partition name plus columns, truncated to 63 bytes — unpredictable
 * and length-dependent. `events.create` has to recognise the conflict to
 * translate it into EntityConflictError (the dedup signal the runtime expects),
 * so the child is renamed once, here, rather than matched by guesswork.
 *
 * The index is selected as the partition's only *partial* unique index: the
 * primary key is unique but total, so there is no ambiguity.
 */
async function renameDedupIndex(pool: Pool, tenantId: string): Promise<void> {
  const partition = derivePartitionName("workflow_events", tenantId);
  const target = dedupIndexName(tenantId);
  const { rows } = await pool.query<{ relname: string }>(
    `select ci.relname
       from pg_index i
       join pg_class ci on ci.oid = i.indexrelid
       join pg_class ct on ct.oid = i.indrelid
       join pg_namespace n on n.oid = ct.relnamespace
      where n.nspname = 'workflow'
        and ct.relname = $1
        and i.indisunique
        and i.indpred is not null`,
    [partition],
  );
  const current = rows[0]?.relname;
  if (!current || current === target) return;
  await pool.query(
    `alter index workflow.${quoteIdentifier(current)} rename to ${quoteIdentifier(target)}`,
  );
}

/**
 * Project deletion's reclaim path: DROP TABLE on a partition detaches and drops
 * in one step, returning the space immediately instead of leaving dead tuples
 * for autovacuum — the lesson from issue #213, where one project's chunk table
 * reached 14 GB.
 */
export async function dropTenantPartitions(pool: Pool, tenantId: string): Promise<void> {
  assertValidTenantId(tenantId);
  for (const table of PARTITIONED_TABLES) {
    const partition = derivePartitionName(table, tenantId);
    await pool.query(`drop table if exists workflow.${quoteIdentifier(partition)}`);
  }
}

export async function tenantPartitionsExist(pool: Pool, tenantId: string): Promise<boolean> {
  assertValidTenantId(tenantId);
  for (const table of PARTITIONED_TABLES) {
    const partition = derivePartitionName(table, tenantId);
    const { rowCount } = await pool.query(
      "select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'workflow' and c.relname = $1",
      [partition],
    );
    if (!rowCount) return false;
  }
  return true;
}

/**
 * `CREATE TABLE ... PARTITION OF ... FOR VALUES IN (...)` takes a literal, not a
 * bind parameter, so the tenant id is escaped explicitly. `assertValidTenantId`
 * has already restricted it to `[A-Za-z0-9_-]`, making this belt-and-braces.
 */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlState(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? (error as { code?: string }).code : undefined;
}

/** SQLSTATE raised when a row's tenant has no partition. */
export const NO_PARTITION_SQLSTATE = "23514";
