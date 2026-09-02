import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test } from "vitest";

/**
 * Migration 0061 makes `sessions(project_id, eve_session_id)` unique. Installs
 * that predate it can hold duplicate pairs (a Playground completion or a
 * ScheduleRun completion that raced ingest), so the migration folds them first
 * with the rules of mergeSessionRows. These tests seed the pre-migration shape
 * of every table the fold touches -- the same idea as the other migration
 * tests here, since the drizzle migrator cannot stop before one migration to
 * seed the state it is meant to repair.
 */
describe("Session identity unique index migration", () => {
  async function applyMigration(database: PGlite): Promise<void> {
    const migration = await readFile(
      new URL("../drizzle/0061_session_identity_unique.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  }

  async function seedPreMigrationSchema(database: PGlite): Promise<void> {
    await database.exec(`
      create table sessions (
        id text primary key,
        project_id text not null,
        deployment_id text,
        eve_session_id text,
        root_node_id text,
        route_id text,
        experiment_id text,
        variant_name text,
        trigger text not null,
        schedule_id text,
        schedule_run_id text,
        status text not null,
        started_at timestamptz not null,
        input_tokens bigint not null default 0,
        output_tokens bigint not null default 0,
        cache_read_tokens bigint not null default 0,
        cache_write_tokens bigint not null default 0,
        cost_usd double precision,
        usage_reported_steps integer not null default 0,
        usage_missing_steps integer not null default 0
      );
      create index sessions_project_eve_session_idx on sessions (project_id, eve_session_id);
      create table session_nodes (
        id text primary key,
        root_session_id text not null references sessions (id)
      );
      create table session_events (
        id text primary key,
        session_id text not null references sessions (id) on delete cascade,
        "index" integer not null,
        unique (session_id, "index")
      );
      create table model_usage_events (
        id text primary key,
        session_id text not null references sessions (id) on delete cascade,
        eve_session_id text not null,
        turn_id text not null,
        step_index integer not null,
        unique (session_id, eve_session_id, turn_id, step_index)
      );
      create table schedule_run_sessions (
        schedule_run_id text not null,
        session_id text not null references sessions (id) on delete cascade,
        primary key (schedule_run_id, session_id)
      );
    `);
  }

  async function seedDuplicates(database: PGlite): Promise<void> {
    await database.exec(`
      insert into sessions (id, project_id, deployment_id, eve_session_id, root_node_id, route_id, trigger,
        schedule_id, schedule_run_id, status, started_at,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
        usage_reported_steps, usage_missing_steps)
      values
        -- the older row: a Playground-shaped Session that learned its id late
        ('sess_old', 'proj_a', 'dep_a', 'eve_dup', null, null, 'direct_http',
         null, null, 'completed', '2026-09-01T10:00:00Z', 1, 2, 3, 4, 0.5, 1, 0),
        -- a scheduled placeholder that raced it
        ('sess_new', 'proj_a', null, 'eve_dup', 'node_new', 'route_x', 'cron',
         'sch_1', 'srun_1', 'running', '2026-09-01T10:05:00Z', 10, 20, 30, 40, 1.25, 2, 3),
        -- and a third copy, to prove the fold is not pairwise-only
        ('sess_newest', 'proj_a', 'dep_b', 'eve_dup', 'node_newest', null, 'webhook',
         null, null, 'running', '2026-09-01T10:10:00Z', 100, 200, 300, 400, null, 4, 5),
        -- the same Eve id in another Project is a different identity
        ('sess_other_project', 'proj_b', null, 'eve_dup', null, null, 'direct_http',
         null, null, 'running', '2026-09-01T10:00:00Z', 7, 0, 0, 0, null, 0, 0),
        -- an unrelated Session and two that have no Eve id yet
        ('sess_unrelated', 'proj_a', null, 'eve_solo', null, null, 'direct_http',
         null, null, 'running', '2026-09-01T10:00:00Z', 0, 0, 0, 0, null, 0, 0),
        ('sess_pending_1', 'proj_a', null, null, null, null, 'playground',
         null, null, 'running', '2026-09-01T10:00:00Z', 0, 0, 0, 0, null, 0, 0),
        ('sess_pending_2', 'proj_a', null, null, null, null, 'playground',
         null, null, 'running', '2026-09-01T10:00:00Z', 0, 0, 0, 0, null, 0, 0);
      insert into session_nodes (id, root_session_id)
      values ('node_new', 'sess_new'), ('node_new_child', 'sess_new'), ('node_newest', 'sess_newest');
      insert into session_events (id, session_id, "index")
      values ('evt_old_0', 'sess_old', 0), ('evt_old_1', 'sess_old', 1),
             ('evt_new_0', 'sess_new', 0), ('evt_new_1', 'sess_new', 1), ('evt_new_2', 'sess_new', 2),
             ('evt_newest_0', 'sess_newest', 0);
      insert into model_usage_events (id, session_id, eve_session_id, turn_id, step_index)
      values ('usage_old', 'sess_old', 'eve_dup', 'turn_1', 0),
             ('usage_new', 'sess_new', 'eve_dup', 'turn_2', 0),
             ('usage_newest', 'sess_newest', 'eve_dup', 'turn_3', 0);
      insert into schedule_run_sessions (schedule_run_id, session_id)
      values ('srun_1', 'sess_new');
    `);
  }

  async function snapshot(database: PGlite) {
    const sessions = await database.query<Record<string, unknown>>(
      `select * from sessions order by id`,
    );
    const nodes = await database.query<{ id: string; root_session_id: string }>(
      `select id, root_session_id from session_nodes order by id`,
    );
    const events = await database.query<{ id: string; session_id: string; index: number }>(
      `select id, session_id, "index" from session_events order by session_id, "index"`,
    );
    const usage = await database.query<{ id: string; session_id: string }>(
      `select id, session_id from model_usage_events order by id`,
    );
    const links = await database.query<{ schedule_run_id: string; session_id: string }>(
      `select schedule_run_id, session_id from schedule_run_sessions order by 1, 2`,
    );
    return {
      sessions: sessions.rows,
      nodes: nodes.rows,
      events: events.rows,
      usage: usage.rows,
      links: links.rows,
    };
  }

  test("folds duplicate pairs onto the oldest row with mergeSessionRows' rules, then makes the pair unique", async () => {
    const database = new PGlite();
    await seedPreMigrationSchema(database);
    await seedDuplicates(database);

    await applyMigration(database);

    const after = await snapshot(database);
    expect(after.sessions.map((row) => row.id)).toEqual([
      "sess_old",
      "sess_other_project",
      "sess_pending_1",
      "sess_pending_2",
      "sess_unrelated",
    ]);
    // Metadata gaps fill from the absorbed rows (older first); every usage
    // counter the schema carries is summed; a `direct_http` survivor takes the
    // discovered trigger; the ScheduleRun link survives the fold.
    expect(after.sessions[0]).toMatchObject({
      id: "sess_old",
      eve_session_id: "eve_dup",
      deployment_id: "dep_a",
      root_node_id: "node_new",
      route_id: "route_x",
      trigger: "cron",
      schedule_id: "sch_1",
      schedule_run_id: "srun_1",
      status: "completed",
      input_tokens: 111,
      output_tokens: 222,
      cache_read_tokens: 333,
      cache_write_tokens: 444,
      cost_usd: 1.75,
      usage_reported_steps: 7,
      usage_missing_steps: 8,
    });
    expect(after.sessions[1]).toMatchObject({ id: "sess_other_project", input_tokens: 7 });
    expect(after.nodes).toEqual([
      { id: "node_new", root_session_id: "sess_old" },
      { id: "node_new_child", root_session_id: "sess_old" },
      { id: "node_newest", root_session_id: "sess_old" },
    ]);
    // Events keep their relative order and land after the survivor's own.
    expect(after.events).toEqual([
      { id: "evt_old_0", session_id: "sess_old", index: 0 },
      { id: "evt_old_1", session_id: "sess_old", index: 1 },
      { id: "evt_new_0", session_id: "sess_old", index: 2 },
      { id: "evt_new_1", session_id: "sess_old", index: 3 },
      { id: "evt_new_2", session_id: "sess_old", index: 4 },
      { id: "evt_newest_0", session_id: "sess_old", index: 5 },
    ]);
    expect(after.usage).toEqual([
      { id: "usage_new", session_id: "sess_old" },
      { id: "usage_newest", session_id: "sess_old" },
      { id: "usage_old", session_id: "sess_old" },
    ]);
    expect(after.links).toEqual([{ schedule_run_id: "srun_1", session_id: "sess_old" }]);

    await expect(
      database.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where indexname = 'sessions_project_eve_session_idx'`,
      ),
    ).resolves.toMatchObject({
      rows: [{ indexdef: expect.stringMatching(/^CREATE UNIQUE INDEX/) }],
    });
    await expect(
      database.exec(`
        insert into sessions (id, project_id, eve_session_id, trigger, status, started_at)
        values ('sess_again', 'proj_a', 'eve_dup', 'direct_http', 'running', now())
      `),
    ).rejects.toThrow(/sessions_project_eve_session_idx/);
    // NULL stays multi-valued.
    await database.exec(`
      insert into sessions (id, project_id, eve_session_id, trigger, status, started_at)
      values ('sess_pending_3', 'proj_a', null, 'playground', 'running', now())
    `);
    await database.close();
  });

  test("re-applies cleanly against an already-folded database", async () => {
    const database = new PGlite();
    await seedPreMigrationSchema(database);
    await seedDuplicates(database);
    await applyMigration(database);
    const once = await snapshot(database);

    await applyMigration(database);

    await expect(snapshot(database)).resolves.toEqual(once);
    await database.close();
  });

  test("refuses to fold rows that both carry the same model usage step", async () => {
    const database = new PGlite();
    await seedPreMigrationSchema(database);
    await seedDuplicates(database);
    await database.exec(`
      insert into model_usage_events (id, session_id, eve_session_id, turn_id, step_index)
      values ('usage_new_copy', 'sess_new', 'eve_dup', 'turn_1', 0)
    `);
    const before = await snapshot(database);

    // Summing the counters would count that step twice and moving the rows
    // would collide on the usage index, so the migration stops before
    // touching anything and names the query the operator needs.
    await expect(applyMigration(database)).rejects.toThrow(/cannot fold Sessions/);
    await expect(snapshot(database)).resolves.toEqual(before);
    await expect(
      database.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where indexname = 'sessions_project_eve_session_idx'`,
      ),
    ).resolves.toMatchObject({ rows: [{ indexdef: expect.stringMatching(/^CREATE INDEX/) }] });
    await database.close();
  });
});
