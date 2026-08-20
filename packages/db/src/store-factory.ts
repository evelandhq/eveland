import { createDatabase } from "./client.js";
import type { Database } from "./client.js";
import { createPostgresStore } from "./postgres-store.js";
import type { Store } from "./store.js";

export type StoreFactoryResult = {
  store: Store;
  database: Database;
  close(): Promise<void>;
};

export function createStoreFromEnv(): StoreFactoryResult {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. The API, Agent Gateway, and Worker must share a Postgres store — set DATABASE_URL (e.g. in .env) so they use the same database.",
    );
  }

  const database = createDatabase(databaseUrl);
  return {
    store: createPostgresStore(database),
    database,
    close: database.close,
  };
}
