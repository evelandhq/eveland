import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDatabase, type Database } from "./client.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The database URL the real-Postgres integration tests run against.
 *
 * Resolution: the EVELAND_POSTGRES_TEST_URL environment variable wins (CI
 * sets it explicitly); otherwise the gitignored root `.env.local` supplies a
 * machine-local default, so a developer configures the dedicated test
 * database once instead of exporting the variable per shell.
 *
 * Whatever the source, the result must never be the dev instance's own
 * database: these tests overwrite durable singletons (the shared Agent
 * environment among them), and pointing them at DATABASE_URL once poisoned
 * every deployment activation on a live dev instance. Matching the root
 * `.env`'s DATABASE_URL fails loudly instead of running.
 */
export function resolvePostgresTestUrl(options?: {
  env?: NodeJS.ProcessEnv;
  envLocalPath?: string;
  devDatabaseUrl?: string | null;
}): string | undefined {
  const env = options?.env ?? process.env;
  const url =
    env.EVELAND_POSTGRES_TEST_URL?.trim() ||
    readEnvFileValue(
      options?.envLocalPath ?? path.join(repositoryRoot, ".env.local"),
      "EVELAND_POSTGRES_TEST_URL",
    );
  if (!url) return undefined;
  const devDatabaseUrl =
    options?.devDatabaseUrl !== undefined
      ? options.devDatabaseUrl
      : readEnvFileValue(path.join(repositoryRoot, ".env"), "DATABASE_URL");
  if (devDatabaseUrl && url === devDatabaseUrl.trim()) {
    throw new Error(
      "EVELAND_POSTGRES_TEST_URL points at the dev database (DATABASE_URL). " +
        "These tests overwrite durable state — use a dedicated database such as eveland_test.",
    );
  }
  return url;
}

function readEnvFileValue(filePath: string, key: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  for (const line of raw.split("\n")) {
    const match = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.+?)\\s*$`).exec(line);
    if (match?.[1]) return match[1].replace(/^["']|["']$/g, "");
  }
  return undefined;
}

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
