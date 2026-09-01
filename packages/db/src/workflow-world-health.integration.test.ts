import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { collectWorkflowDispatchWorkload } from "./workflow-world-health.js";
import { resolvePostgresTestUrl } from "./postgres-integration.test-support.js";

/**
 * Runs the real counting query against a real Postgres. The tables are a
 * minimal stand-in for `@evelandhq/workflow-world`'s run and dead-letter
 * tables, carrying exactly the columns the workload query touches, so a typo
 * in any table or column name fails here rather than in production. A
 * dedicated database (not the shared test database) keeps this from colliding
 * with the worker's own `workflow`-schema stand-ins.
 */
const baseUrl = resolvePostgresTestUrl();
const databaseName = `eveland_wf_health_${randomBytes(6).toString("hex")}`;
const admin = baseUrl ? postgres(baseUrl, { max: 1 }) : null;
let worldUrl: string | undefined;
let sql: postgres.Sql | null = null;

beforeAll(async () => {
  if (!admin || !baseUrl) return;
  await admin.unsafe(`CREATE DATABASE ${databaseName}`);
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  worldUrl = url.toString();
  sql = postgres(worldUrl, { max: 1 });
  await sql`create schema "workflow"`;
  await sql`
    create table "workflow"."workflow_runs" (
      tenant_id varchar not null,
      id varchar not null,
      status varchar not null,
      constraint workflow_runs_health_test_pkey primary key (tenant_id, id)
    )
  `;
  await sql`
    create table "workflow"."dispatch_dead_letters" (
      tenant_id varchar not null,
      run_id varchar,
      created_at timestamptz not null,
      resolved_at timestamptz
    )
  `;
});

afterAll(async () => {
  await sql?.end();
  if (admin) {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});

describe.skipIf(!baseUrl)("collectWorkflowDispatchWorkload", () => {
  test("counts unresolved dead letters and splits active runs by quarantine", async () => {
    await sql!`
      insert into "workflow"."workflow_runs" (tenant_id, id, status) values
        ('proj_a', 'run_queued', 'pending'),
        ('proj_a', 'run_live', 'running'),
        ('proj_a', 'run_stuck', 'running'),
        ('proj_a', 'run_recovered', 'running'),
        ('proj_b', 'run_stuck_pending', 'pending'),
        ('proj_b', 'run_done', 'completed'),
        ('proj_b', 'run_failed', 'failed')
    `;
    await sql!`
      insert into "workflow"."dispatch_dead_letters" (tenant_id, run_id, created_at, resolved_at) values
        ('proj_a', 'run_stuck', '2026-07-02T00:00:00Z', null),
        ('proj_a', 'run_recovered', '2026-07-01T00:00:00Z', '2026-07-03T00:00:00Z'),
        ('proj_b', 'run_stuck_pending', '2026-07-04T00:00:00Z', null),
        -- A dead letter can carry no run (e.g. a wake for a run that was
        -- never created); it still counts as dropped work.
        ('proj_b', null, '2026-07-05T00:00:00Z', null),
        -- Same run id under another tenant must not quarantine proj_a's run.
        ('proj_b', 'run_live', '2026-07-06T00:00:00Z', null)
    `;

    await expect(collectWorkflowDispatchWorkload(worldUrl)).resolves.toEqual({
      pendingRuns: 2,
      runningRuns: 3,
      stuckRuns: 2,
      unresolvedDeadLetters: 4,
      oldestUnresolvedDeadLetterAt: "2026-07-02T00:00:00.000Z",
    });
  });

  test("an unconfigured world reports null rather than zeros", async () => {
    await expect(collectWorkflowDispatchWorkload(undefined)).resolves.toBeNull();
  });

  test("a configured world that cannot answer propagates instead of zeroing", async () => {
    const missingDatabase = new URL(worldUrl!);
    missingDatabase.pathname = "/eveland_wf_health_missing_db";
    await expect(collectWorkflowDispatchWorkload(missingDatabase.toString())).rejects.toThrow(
      /Failed to read dispatch workload/,
    );
  });
});
