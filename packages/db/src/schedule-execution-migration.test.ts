import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test } from "vitest";

describe("ScheduleRun execution migration", () => {
  test("backfills active execution links for existing scheduled Sessions", async () => {
    const database = new PGlite();
    await database.exec(`
      create table schedule_runs (
        id text primary key,
        status text not null,
        completed_at timestamptz,
        updated_at timestamptz not null
      );
      create table sessions (
        id text primary key,
        schedule_run_id text,
        status text not null,
        completed_at timestamptz
      );
      create table session_events (
        id text primary key,
        session_id text not null,
        created_at timestamptz not null
      );
      create table runtime_instances (
        id text primary key
      );
      create table session_nodes (
        id text primary key,
        status text not null
      );
      insert into schedule_runs (id, status, completed_at, updated_at)
      values (
        'srun_existing',
        'succeeded',
        '2026-07-28T02:25:00.000Z',
        '2026-07-28T02:25:00.000Z'
      );
      insert into sessions (id, schedule_run_id, status)
      values ('sess_existing', 'srun_existing', 'running');
      insert into session_events (id, session_id, created_at)
      values ('evt_existing', 'sess_existing', '2026-07-28T02:26:00.000Z');
    `);
    const migration = await readFile(
      new URL("../drizzle/0033_puzzling_madame_masque.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }

    const result = await database.query<{
      schedule_run_id: string;
      session_id: string;
      status: string;
      last_observed_at: Date;
    }>(`
      select schedule_run_id, session_id, status, last_observed_at
      from schedule_run_sessions
    `);

    expect(result.rows).toEqual([
      {
        schedule_run_id: "srun_existing",
        session_id: "sess_existing",
        status: "running",
        last_observed_at: new Date("2026-07-28T02:26:00.000Z"),
      },
    ]);
    await expect(
      database.query<{
        status: string;
        completed_at: Date | null;
      }>(`
      select status, completed_at
      from schedule_runs
      where id = 'srun_existing'
    `),
    ).resolves.toMatchObject({
      rows: [{ status: "running", completed_at: null }],
    });
    await database.close();
  });
});
