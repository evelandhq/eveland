import { createDatabase } from "./client.js";
import type { Database } from "./client.js";
import { createPostgresStore } from "./postgres-store.js";
import { createMemoryStore, type Store } from "./store.js";

export type StoreFactoryResult = {
  store: Store;
  database: Database | null;
  close(): Promise<void>;
};

export function createStoreFromEnv(): StoreFactoryResult {
  if (process.env.STORE_DRIVER === "memory") {
    return {
      store: createMemoryStore(),
      database: null,
      async close() {},
    };
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. The API and worker must share a Postgres store — set DATABASE_URL (e.g. in .env) so they use the same database. " +
        "To intentionally use an in-process store (tests only; the API and worker will NOT share state), set STORE_DRIVER=memory.",
    );
  }

  const database = createDatabase(databaseUrl);
  return {
    store: createPostgresStore(database),
    database,
    close: database.close,
  };
}
