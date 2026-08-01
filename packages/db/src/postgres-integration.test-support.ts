import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDatabase, type Database } from "./client.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export type IsolatedPostgresDatabase = {
  database: Database;
  drop: () => Promise<void>;
};

/**
 * Creates a migrated, dedicated database for one integration-test file.
 *
 * Tests that exercise the shared work queues (claimNextJob,
 * claimNextSourcePreflight, recoverStaleJobs) cannot share the common test
 * database: concurrently running test files enqueue their own work there, so
 * a global claim or recovery sweep can observe another file's jobs. Tests
 * that only touch rows they created stay on the shared database.
 */
export async function createIsolatedPostgresDatabase(
  baseUrl: string,
): Promise<IsolatedPostgresDatabase> {
  const name = `eveland_test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(baseUrl, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const database = createDatabase(url.toString());
  await migrate(database.db, { migrationsFolder });
  return {
    database,
    async drop() {
      await database.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
