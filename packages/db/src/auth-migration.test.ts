import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

describe("Better Auth team migration", () => {
  test("creates Better Auth identity tables", () => {
    const migration = readMigration();

    expect(migration).toContain('CREATE TABLE "auth_accounts"');
    expect(migration).toContain('CREATE TABLE "auth_verifications"');
    expect(migration).toContain('CREATE TABLE "auth_sessions"');
    expect(migration).toContain('"token" text NOT NULL');
  });

  test("backfills legacy users and the default team before adding stricter constraints", () => {
    const migration = readMigration();
    const normalizeUser = migration.indexOf('UPDATE "users" SET "name"');
    const requireName = migration.indexOf('ALTER COLUMN "name" SET NOT NULL');
    const teamInsert = migration.indexOf('INSERT INTO "teams"');
    const projectColumn = migration.indexOf('ALTER TABLE "projects" ADD COLUMN "team_id"');

    expect(normalizeUser).toBeGreaterThan(-1);
    expect(normalizeUser).toBeLessThan(requireName);
    expect(teamInsert).toBeGreaterThan(-1);
    expect(teamInsert).toBeLessThan(projectColumn);
  });
});

function readMigration(): string {
  return readFileSync(
    fileURLToPath(new URL("../drizzle/0011_colossal_puppet_master.sql", import.meta.url)),
    "utf8",
  );
}
