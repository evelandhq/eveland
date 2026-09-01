import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

describe("logs seq cursor migration", () => {
  const migration = readFileSync(
    fileURLToPath(new URL("../drizzle/0060_logs_seq_cursor.sql", import.meta.url)),
    "utf8",
  );

  test("stages the column instead of a blocking bigserial rewrite", () => {
    // ADD COLUMN with no default is metadata-only; the naive
    // `ADD COLUMN seq bigserial NOT NULL` would rewrite and exclusively lock
    // the whole (unbounded) logs table for the duration of the upgrade.
    expect(migration).toContain('ALTER TABLE "logs" ADD COLUMN "seq" bigint;');
    expect(migration).not.toContain("bigserial");
    const stages = [
      'ADD COLUMN "seq" bigint',
      'CREATE SEQUENCE "logs_seq_seq"',
      'UPDATE "logs" SET "seq"',
      "setval('logs_seq_seq'",
      `SET DEFAULT nextval('logs_seq_seq')`,
      '"seq" SET NOT NULL',
      'CREATE INDEX "logs_project_seq_idx"',
    ];
    let position = -1;
    for (const stage of stages) {
      const next = migration.indexOf(stage);
      expect(next, stage).toBeGreaterThan(position);
      position = next;
    }
  });

  test("backfills historical rows deterministically, not in physical scan order", () => {
    expect(migration).toContain('row_number() OVER (ORDER BY "created_at", "id")');
  });

  test("drops the created_at index no query orders by any more", () => {
    expect(migration).toContain('DROP INDEX "logs_project_created_idx";');
  });
});
