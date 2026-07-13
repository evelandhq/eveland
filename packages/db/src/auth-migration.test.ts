import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

describe("team auth migration", () => {
  test("creates the default team before backfilling project ownership", () => {
    const migration = readFileSync(
      fileURLToPath(new URL("../drizzle/0011_colossal_puppet_master.sql", import.meta.url)),
      "utf8",
    );
    const teamInsert = migration.indexOf('INSERT INTO "teams"');
    const projectColumn = migration.indexOf('ALTER TABLE "projects" ADD COLUMN "team_id"');

    expect(teamInsert).toBeGreaterThan(-1);
    expect(teamInsert).toBeLessThan(projectColumn);
    expect(migration).toContain('WHERE "id" = \'user_local_admin\'');
  });
});
