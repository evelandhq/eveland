import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

describe("semantic project slug migration", () => {
  test("backfills URL-friendly unique project names and rebuilds persisted Agent hosts", () => {
    const migration = readMigration();

    expect(migration).toContain('RENAME COLUMN "routing_key" TO "slug"');
    expect(migration).toContain("regexp_replace");
    expect(migration).toContain('UPDATE "projects" SET "slug" = candidate, "name" = candidate');
    expect(migration).toContain('UPDATE "agent_routes" AS route');
    expect(migration).toContain("route.\"kind\" = 'deployment'");
  });

  test("replaces the global deployment key with an eight-character project-local key", () => {
    const migration = readMigration();

    expect(migration).toContain('DROP CONSTRAINT "deployments_deployment_key_unique"');
    expect(migration).toContain("substring(md5(deployment.\"id\" || salt::text), 1, 8)");
    expect(migration).toContain('CREATE UNIQUE INDEX "deployments_project_key_idx"');
    expect(migration).toContain('CHECK ("deployments"."deployment_key" ~ \'^[a-z0-9]{8}$\')');
  });
});

function readMigration(): string {
  const directory = fileURLToPath(new URL("../drizzle", import.meta.url));
  const [filename] = globSync("0013_*.sql", { cwd: directory });
  expect(filename).toBeDefined();
  return readFileSync(resolve(directory, filename!), "utf8");
}
