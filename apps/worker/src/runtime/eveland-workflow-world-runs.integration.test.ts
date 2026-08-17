import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { listDeploymentsWithActiveWorkflowRuns } from "./eveland-workflow-world-runs.js";

/**
 * Runs the real query against a real Postgres. The table here is a minimal
 * stand-in for `@evelandhq/workflow-world`'s run and dead-letter tables,
 * carrying exactly the columns the retention query touches. A typo in any
 * table or column name therefore fails here rather than in production. The
 * full schema arrives with the package dependency and is exercised end to end
 * by the wake harness.
 */
const databaseUrl = process.env.EVELAND_POSTGRES_TEST_URL;
const sql = databaseUrl ? postgres(databaseUrl, { max: 1 }) : null;

beforeAll(async () => {
  if (!sql) return;
  await sql`create schema if not exists "workflow"`;
  await sql`
    create table if not exists "workflow"."workflow_runs" (
      tenant_id varchar not null,
      id varchar not null,
      deployment_id varchar not null,
      status varchar not null,
      constraint workflow_runs_test_pkey primary key (tenant_id, id)
    )
  `;
  await sql`
    create table if not exists "workflow"."dispatch_dead_letters" (
      tenant_id varchar not null,
      run_id varchar,
      resolved_at timestamptz
    )
  `;
});

afterAll(async () => {
  if (!sql) return;
  await sql`drop schema if exists "workflow" cascade`;
  await sql.end();
});

describe.skipIf(!sql)("listDeploymentsWithActiveWorkflowRuns", () => {
  test("returns only this tenant's deployments with non-terminal runs", async () => {
    const tenant = `proj_runs_${Date.now().toString(36)}`;
    const other = `${tenant}_other`;
    await sql!`
      insert into "workflow"."workflow_runs" (tenant_id, id, deployment_id, status) values
        (${tenant}, 'run_sleeping', 'dep_sleeping', 'running'),
        (${tenant}, 'run_queued', 'dep_queued', 'pending'),
        (${tenant}, 'run_done', 'dep_done', 'completed'),
        (${tenant}, 'run_failed', 'dep_failed', 'failed'),
        (${tenant}, 'run_dead_lettered', 'dep_dead_lettered', 'running'),
        (${tenant}, 'run_dead_letter_resolved', 'dep_recoverable', 'running'),
        (${other}, 'run_foreign', 'dep_foreign', 'running')
    `;
    await sql!`
      insert into "workflow"."dispatch_dead_letters" (tenant_id, run_id, resolved_at) values
        (${tenant}, 'run_dead_lettered', null),
        (${tenant}, 'run_dead_letter_resolved', now())
    `;

    await expect(listDeploymentsWithActiveWorkflowRuns(databaseUrl, tenant)).resolves.toEqual(
      new Set(["dep_sleeping", "dep_queued", "dep_recoverable"]),
    );
  });

  test("an unconfigured world contributes no protected deployments", async () => {
    await expect(listDeploymentsWithActiveWorkflowRuns(undefined, "proj_any")).resolves.toEqual(
      new Set(),
    );
  });

  test("a configured world that cannot answer propagates instead of failing open", async () => {
    const missingDatabase = new URL(databaseUrl!);
    missingDatabase.pathname = "/eveland_workflow_runs_missing_db";
    await expect(
      listDeploymentsWithActiveWorkflowRuns(missingDatabase.toString(), "proj_any"),
    ).rejects.toThrow(/Failed to read active workflow runs/);
  });
});
