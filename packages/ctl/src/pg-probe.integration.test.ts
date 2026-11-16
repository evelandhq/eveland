import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { defaultPgJournalProbe } from "./pg-probe.ts";

/**
 * The journal query against a real Postgres, with the table shape the Drizzle
 * migrator creates (`created_at` is a bigint, which the driver returns as a
 * string). `eveland-ctl update` decides from `oldestAppliedAt` whether the
 * database predates the checkout's baseline, so the value must survive the
 * round trip as the exact journal `when`.
 */
const baseUrl = resolveTestUrl();
const databaseName = `eveland_ctl_journal_${randomBytes(6).toString("hex")}`;
const admin = baseUrl ? postgres(baseUrl, { max: 1 }) : null;
let databaseUrl = "";

beforeAll(async () => {
  if (!admin || !baseUrl) return;
  await admin.unsafe(`create database ${databaseName}`);
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();
});

afterAll(async () => {
  if (!admin) return;
  await admin.unsafe(`drop database if exists ${databaseName} with (force)`);
  await admin.end();
});

describe.skipIf(!baseUrl)("defaultPgJournalProbe on a real database", () => {
  test("no journal, an empty journal, then the oldest applied migration's `when`", async () => {
    const probe = defaultPgJournalProbe();
    expect(await probe(databaseUrl)).toEqual({ status: "unmigrated" });

    const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    try {
      await sql`create schema drizzle`;
      await sql`
        create table drizzle.__drizzle_migrations (
          id serial primary key, hash text not null, created_at bigint
        )
      `;
      expect(await probe(databaseUrl)).toEqual({
        status: "migrated",
        count: 0,
        oldestAppliedAt: null,
      });

      await sql`
        insert into drizzle.__drizzle_migrations (hash, created_at)
        values ('b', 1794823282194), ('a', 1757000000000)
      `;
      expect(await probe(databaseUrl)).toEqual({
        status: "migrated",
        count: 2,
        oldestAppliedAt: 1757000000000,
      });
    } finally {
      await sql.end();
    }
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
