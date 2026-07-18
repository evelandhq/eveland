import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { createPostgresStore } from "./postgres-store.js";
import * as schema from "./schema.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export async function migratePgliteDatabase(
  db: ReturnType<typeof drizzle<typeof schema>>,
) {
  await migrate(db, { migrationsFolder });
}

export async function createPgliteTestStore() {
  const client = await PGlite.create();
  const db = drizzle(client, { schema });

  try {
    await migratePgliteDatabase(db);
  } catch (error) {
    await client.close();
    throw error;
  }

  return {
    db,
    client,
    store: createPostgresStore({ db }),
    async close() {
      await client.close();
    },
  };
}
