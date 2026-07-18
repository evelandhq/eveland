import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { onTestFinished } from "vitest";
import { createPostgresStore } from "./postgres-store.js";
import * as schema from "./schema.js";
import { users } from "./schema.js";
import type { Store } from "./store-domains.js";
import { migratePgliteDatabase } from "./test-store.js";

export function createTestStore(): Store {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const sqlStore = createPostgresStore({ db });
  const ready = client.waitReady
    .then(() => migratePgliteDatabase(db))
    .then(() => db
      .insert(users)
      .values([
        { id: "user_local_admin", email: "admin@example.com", name: "Local Admin" },
        { id: "user_a", email: "user-a@example.com", name: "Test User A" },
        { id: "user_b", email: "user-b@example.com", name: "Test User B" },
        { id: "user_one", email: "user-one@example.com", name: "Test User One" },
        { id: "user_two", email: "user-two@example.com", name: "Test User Two" },
        { id: "another_user", email: "another-user@example.com", name: "Another Test User" },
      ])
      .onConflictDoNothing({ target: users.id }))
    .then(() => undefined);

  onTestFinished(async () => {
    await ready.catch(() => undefined);
    await client.close();
  });

  return Object.fromEntries(
    Object.entries(sqlStore).map(([name, method]) => [
      name,
      async (...args: unknown[]) => {
        await ready;
        return Reflect.apply(method, sqlStore, args);
      },
    ]),
  ) as unknown as Store;
}
