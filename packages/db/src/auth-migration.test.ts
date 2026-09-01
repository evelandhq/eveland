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

describe("Better Auth 1.7 issuer migration", () => {
  test("adds issuer with an inline DEFAULT so the migrate->restart gap and a 1.6 rollback stay writable", () => {
    const migration = readFileSync(
      fileURLToPath(new URL("../drizzle/0058_better_auth_issuer.sql", import.meta.url)),
      "utf8",
    );
    // One atomic ALTER: DEFAULT and NOT NULL together means rows written by
    // still-running 1.6 code (which omits the column) keep inserting cleanly,
    // and 1.7 sign-in finds issuer = 'local:credential' on every account.
    expect(migration).toContain(
      'ALTER TABLE "auth_accounts" ADD COLUMN "issuer" text DEFAULT \'local:credential\' NOT NULL;',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "auth_accounts_issuer_account_idx" ON "auth_accounts" USING btree ("issuer","account_id");',
    );
  });
});

describe("CLI device authorization migration", () => {
  test("creates the device-code and oauth-provider tables with their uniqueness invariants", () => {
    const migration = readFileSync(
      fileURLToPath(new URL("../drizzle/0059_cli_device_authorization.sql", import.meta.url)),
      "utf8",
    );
    for (const table of [
      "auth_device_codes",
      "oauth_clients",
      "oauth_resources",
      "oauth_client_resources",
      "oauth_refresh_tokens",
      "oauth_access_tokens",
      "oauth_consents",
      "oauth_client_assertions",
    ]) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
    }
    // The one-time-claim and lookup invariants of RFC 8628 and opaque tokens
    // live in these unique indexes.
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "auth_device_codes_device_code_idx" ON "auth_device_codes" USING btree ("device_code");',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "auth_device_codes_user_code_idx" ON "auth_device_codes" USING btree ("user_code");',
    );
    // The unauthenticated code-request admission sweep filters on expiry.
    expect(migration).toContain(
      'CREATE INDEX "auth_device_codes_expires_idx" ON "auth_device_codes" USING btree ("expires_at");',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "oauth_clients_client_id_idx" ON "oauth_clients" USING btree ("client_id");',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "oauth_access_tokens_token_idx" ON "oauth_access_tokens" USING btree ("token");',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "oauth_refresh_tokens_token_idx" ON "oauth_refresh_tokens" USING btree ("token");',
    );
  });
});

function readMigration(): string {
  return readFileSync(
    fileURLToPath(new URL("../drizzle/0011_colossal_puppet_master.sql", import.meta.url)),
    "utf8",
  );
}
