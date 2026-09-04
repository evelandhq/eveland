import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { defaultDeadLetterStore } from "./dead-letter-store.ts";

/**
 * The real SQL against a real Postgres. The two tables are the minimal
 * stand-in for `@evelandhq/workflow-world`'s, carrying exactly the columns
 * these queries touch, so a typo in a name or a wrong join fails here rather
 * than the first time an operator runs the command on a wedged machine.
 *
 * `EVELAND_POSTGRES_TEST_URL` (CI) or the root `.env.local` (developers)
 * points at a server; the test makes and drops its own database. The env-file
 * fallback is duplicated rather than imported: ctl may depend on core alone.
 */
const baseUrl = resolveTestUrl();
const databaseName = `eveland_ctl_dl_${randomBytes(6).toString("hex")}`;
const admin = baseUrl ? postgres(baseUrl, { max: 1 }) : null;
const store = defaultDeadLetterStore();
let worldUrl = "";
let sql: postgres.Sql | null = null;

beforeAll(async () => {
  if (!admin || !baseUrl) return;
  await admin.unsafe(`create database ${databaseName}`);
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
      constraint workflow_runs_ctl_test_pkey primary key (tenant_id, id)
    )
  `;
  await sql`
    create table "workflow"."dispatch_dead_letters" (
      id bigserial primary key,
      tenant_id varchar not null,
      deployment_id varchar,
      run_id varchar,
      reason text not null,
      created_at timestamptz not null default now(),
      resolved_at timestamptz
    )
  `;
}, 60_000);

afterAll(async () => {
  await sql?.end();
  if (admin) {
    await admin.unsafe(`drop database if exists ${databaseName} with (force)`);
    await admin.end();
  }
});

describe.skipIf(!baseUrl)("the dead-letter store", () => {
  beforeEach(async () => {
    await sql!`delete from "workflow"."dispatch_dead_letters"`;
    await sql!`delete from "workflow"."workflow_runs"`;
    await sql!`
      insert into "workflow"."workflow_runs" (tenant_id, id, status) values
        ('proj_a', 'run_stuck', 'running'),
        ('proj_a', 'run_settled', 'cancelled'),
        ('proj_b', 'run_stuck', 'pending')
    `;
    await sql!`
      insert into "workflow"."dispatch_dead_letters"
        (tenant_id, deployment_id, run_id, reason, created_at, resolved_at) values
        ('proj_a', 'dep_1', 'run_stuck',   'oldest',        '2026-08-13T09:27:43Z', null),
        ('proj_a', 'dep_1', 'run_settled', 'newest',        '2026-08-20T00:00:00Z', null),
        ('proj_a', 'dep_1', null,          'no run',        '2026-08-14T00:00:00Z', null),
        ('proj_a', 'dep_1', 'run_stuck',   'already dealt', '2026-08-12T00:00:00Z', '2026-08-12T01:00:00Z'),
        ('proj_b', 'dep_2', 'run_stuck',   'other project', '2026-08-30T00:00:00Z', null)
    `;
  });

  test("summarize groups by deployment and separates stuck runs from history", async () => {
    expect(await store.summarize(worldUrl)).toEqual([
      {
        projectId: "proj_a",
        deploymentId: "dep_1",
        letters: 3,
        runs: 2,
        activeRuns: 1,
        runlessLetters: 1,
        oldestAt: new Date("2026-08-13T09:27:43Z"),
        // The most recent reason, not an arbitrary one: it is the closest thing
        // to "why is this still happening".
        latestReason: "newest",
      },
      {
        projectId: "proj_b",
        deploymentId: "dep_2",
        letters: 1,
        runs: 1,
        activeRuns: 1,
        runlessLetters: 0,
        oldestAt: new Date("2026-08-30T00:00:00Z"),
        latestReason: "other project",
      },
    ]);
  });

  test("resolving one deployment leaves the others, and counts the runs it frees", async () => {
    expect(await store.resolve(worldUrl, { kind: "deployment", deploymentId: "dep_1" })).toEqual({
      letters: 3,
      // Only run_stuck: the settled run is not replayed, and the run-less
      // letter frees no run at all.
      replayableRuns: 1,
    });
    const remaining = await store.summarize(worldUrl);
    expect(remaining.map((group) => group.deploymentId)).toEqual(["dep_2"]);
  });

  // Run ids are minted by the World and unique, so a `--run` selector is not
  // project-scoped. The fixture duplicates one across projects anyway: it is
  // what proves the run join carries `tenant_id`, and two distinct
  // (project, run) pairs are what the freed-run count has to report.
  test("resolving one run takes its letters everywhere and leaves other runs alone", async () => {
    expect(await store.resolve(worldUrl, { kind: "run", runId: "run_stuck" })).toEqual({
      letters: 2,
      replayableRuns: 2,
    });
    const [remaining, ...rest] = await store.summarize(worldUrl);
    expect(rest).toEqual([]);
    expect(remaining).toMatchObject({ deploymentId: "dep_1", letters: 2, activeRuns: 0 });
    const reasons = await sql!<{ reason: string }[]>`
      select reason from "workflow"."dispatch_dead_letters"
       where resolved_at is null order by reason
    `;
    expect(reasons.map((row) => row.reason)).toEqual(["newest", "no run"]);
  });

  test("an already-resolved letter keeps its own timestamp", async () => {
    await store.resolve(worldUrl, { kind: "all" });
    const [row] = await sql!<{ resolved_at: Date }[]>`
      select resolved_at from "workflow"."dispatch_dead_letters" where reason = 'already dealt'
    `;
    expect(row!.resolved_at.toISOString()).toBe("2026-08-12T01:00:00.000Z");
    expect(await store.summarize(worldUrl)).toEqual([]);
  });

  test("resolving a world with nothing outstanding is a no-op, not an error", async () => {
    await store.resolve(worldUrl, { kind: "all" });
    expect(await store.resolve(worldUrl, { kind: "all" })).toEqual({
      letters: 0,
      replayableRuns: 0,
    });
  });
});

function resolveTestUrl(): string | undefined {
  const fromEnv = process.env.EVELAND_POSTGRES_TEST_URL?.trim();
  if (fromEnv) return fromEnv;
  const envLocal = path.join(fileURLToPath(new URL("../../../", import.meta.url)), ".env.local");
  try {
    for (const line of readFileSync(envLocal, "utf8").split("\n")) {
      const match = /^\s*(?:export\s+)?EVELAND_POSTGRES_TEST_URL\s*=\s*(.*?)\s*$/.exec(line);
      if (match) return match[1]!.replace(/^["']|["']$/g, "") || undefined;
    }
  } catch {
    // No .env.local: the suite skips, exactly as it does in a checkout with no
    // Postgres configured.
  }
  return undefined;
}
