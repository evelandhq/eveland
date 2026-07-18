import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, onTestFinished } from "vitest";
import { createPostgresStore } from "./postgres-store.js";
import * as schema from "./schema.js";
import { users } from "./schema.js";
import type { Store } from "./store-domains.js";
import { migratePgliteDatabase } from "./test-store.js";

const templateClient = new PGlite();
const templateDb = drizzle(templateClient, { schema });
const templateStoreShape = createPostgresStore({ db: templateDb });
const templateReady = templateClient.waitReady
  .then(() => migratePgliteDatabase(templateDb))
  .then(() => templateDb
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

afterAll(async () => {
  await templateReady.catch(() => undefined);
  await templateClient.close();
});

export function createTestStore(): Store {
  let client: PGlite | undefined;
  let sqlStore: Store | undefined;
  const ready = templateReady.then(async () => {
    client = await templateClient.clone() as PGlite;
    const db = drizzle(client, { schema });
    sqlStore = createPostgresStore({ db });
  });

  onTestFinished(async () => {
    await ready.catch(() => undefined);
    await client?.close();
  });

  return Object.fromEntries(
    Object.keys(templateStoreShape).map((name) => [
      name,
      async (...args: unknown[]) => {
        await ready;
        const method = Reflect.get(sqlStore!, name);
        return Reflect.apply(method, sqlStore, args);
      },
    ]),
  ) as unknown as Store;
}
