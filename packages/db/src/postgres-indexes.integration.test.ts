import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "./client.js";

const databaseUrl = process.env.EVELAND_POSTGRES_TEST_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => database?.close());

/**
 * The hot read paths depend on indexes that no unit test can observe: PGlite
 * runs the same migrations but the planner's choice only matters against real
 * Postgres. `enable_seqscan = off` is what makes these assertions meaningful on
 * a nearly-empty test table -- without it Postgres correctly prefers a
 * sequential scan and the plan would say nothing about whether the index
 * actually matches the query shape.
 */
describe.skipIf(!database)("hot-path index usage", () => {
  async function planFor(query: string): Promise<string> {
    const { db } = database!;
    await db.execute(sql.raw("set enable_seqscan = off"));
    try {
      const rows = await db.execute(sql.raw(`explain (costs off) ${query}`));
      return (rows as unknown as Array<Record<string, string>>)
        .map((row) => Object.values(row)[0] ?? "")
        .join("\n");
    } finally {
      await db.execute(sql.raw("set enable_seqscan = on"));
    }
  }

  test("the worker's job claim scan uses the queued partial index", async () => {
    const plan = await planFor(`
      select candidate.id
      from jobs candidate
      join projects project on project.id = candidate.project_id
      where candidate.status = 'queued'
      order by candidate.created_at asc, candidate.sequence asc
      limit 1
    `);

    expect(plan).toContain("jobs_queued_claim_idx");
  });

  test("the per-project mutual-exclusion probe uses the running partial index", async () => {
    const plan = await planFor(`
      select 1 from jobs running
      where running.project_id = 'proj_probe' and running.status = 'running'
    `);

    expect(plan).toContain("jobs_running_project_idx");
  });

  test("project job listings use the project/created index", async () => {
    const plan = await planFor(`
      select * from jobs where project_id = 'proj_probe'
      order by created_at desc limit 20
    `);

    expect(plan).toContain("jobs_project_created_idx");
  });

  test("durable Eve session identity resolves through a project-scoped index", async () => {
    const plan = await planFor(`
      select * from sessions
      where project_id = 'proj_probe' and eve_session_id = 'eve_probe' limit 1
    `);

    expect(plan).toContain("sessions_project_eve_session_idx");
  });

  test("session node listings use the root-session index", async () => {
    const plan = await planFor(`
      select * from session_nodes
      where root_session_id = 'sess_probe' order by created_at
    `);

    expect(plan).toContain("session_nodes_root_session_idx");
  });

  test("project log listings use the project/created index", async () => {
    const plan = await planFor(`
      select * from logs where project_id = 'proj_probe' order by created_at
    `);

    expect(plan).toContain("logs_project_created_idx");
  });
});
