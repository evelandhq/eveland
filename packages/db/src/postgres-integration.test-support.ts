import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDatabase, type Database } from "./client.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

// Every real-Postgres integration file gates itself with
// `describe.skipIf(!EVELAND_POSTGRES_TEST_URL)`. On a developer machine that
// is a feature; under CI it is how a renamed workflow env var silently turns
// the whole integration layer into green-but-skipped. The import of this
// module still executes in skipped files, so this refuses to let CI run
// without the database it is supposed to be testing against.
if (process.env.CI && !process.env.EVELAND_POSTGRES_TEST_URL) {
  throw new Error(
    "CI is set but EVELAND_POSTGRES_TEST_URL is not: the real-Postgres integration suite would silently skip. Configure the database service or the env wiring in the workflow.",
  );
}

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
