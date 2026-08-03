import { makeWorkerUtils } from "graphile-worker";
import { Pool } from "pg";
import { resolveConnectionString } from "./config.js";
import { runMigrations } from "./migrate.js";

function redact(connectionString: string): string {
  return connectionString.replace(/^(\w+:\/\/)([^@]+)@/, "$1[redacted]@");
}

export async function setupDatabase(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const connectionString = resolveConnectionString(env);
  console.log("🔧 Setting up the Eveland workflow world…");
  console.log(`📍 Connection: ${redact(connectionString)}`);

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const applied = await runMigrations(pool, { log: (message) => console.log(`   ${message}`) });
    console.log(
      applied.length > 0
        ? `✅ Applied ${String(applied.length)} migration(s).`
        : "✅ Schema already up to date.",
    );

    // Bootstrap graphile-worker's schema here, single-process, rather than
    // leaving it to whichever consumer calls start() first. graphile's
    // installSchema is not race-safe, and concurrent callers on a fresh
    // database collide on pg_namespace's unique index.
    console.log("📂 Bootstrapping graphile-worker schema…");
    const workerUtils = await makeWorkerUtils({ pgPool: pool });
    try {
      await workerUtils.migrate();
    } finally {
      await workerUtils.release();
    }
    console.log("✅ Workflow world ready.");
  } finally {
    await pool.end().catch(() => {});
  }
}
