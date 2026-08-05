import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { createPostgresStore } from "./postgres-store.js";
import * as schema from "./schema.js";
import type { Store } from "./store-domains.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * Migrations seed open access as the platform Identity Provider, and only one
 * Provider may be enabled at a time. A test that enables a Provider of its own
 * has to stand that seed down first, exactly as an administrator would.
 */
export async function disableSeededOpenIdentityProvider(store: Store): Promise<void> {
  const seeded = (await store.listIdentityProviderConnections()).find(
    (provider) => provider.type === "open" && provider.enabled,
  );
  if (!seeded) return;
  await store.updateIdentityProviderConnection({
    id: seeded.id,
    expectedSecurityRevision: seeded.securityRevision,
    displayName: seeded.displayName,
    enabled: false,
    securityChanged: false,
  });
}

export async function migratePgliteDatabase(db: ReturnType<typeof drizzle<typeof schema>>) {
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
