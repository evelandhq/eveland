import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "./client.js";
import { createPostgresStore } from "./postgres-store.js";
import { resolvePostgresTestUrl } from "./postgres-integration.test-support.js";

const databaseUrl = resolvePostgresTestUrl();
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => database?.close());

describe.skipIf(!database)("Postgres shared Agent environment", () => {
  test("persists the singleton environment", async () => {
    const store = createPostgresStore(database!);
    const suffix = Date.now().toString();
    const environment = await store.saveSharedAgentEnvironment({
      entries: [{ key: "OPENAI_API_KEY", kind: "secret", encryptedValue: `encrypted-${suffix}` }],
    });
    expect(environment.entries).toEqual([
      { key: "OPENAI_API_KEY", kind: "secret", configured: true },
    ]);
    expect(JSON.stringify(environment)).not.toContain(`encrypted-${suffix}`);
    await expect(store.getSharedAgentEnvironmentRecord()).resolves.toMatchObject({
      entries: [{ key: "OPENAI_API_KEY", kind: "secret", encryptedValue: `encrypted-${suffix}` }],
    });
  });

  test("serializes concurrent writes", async () => {
    const store = createPostgresStore(database!);
    const suffix = Date.now().toString();
    const results = await Promise.all([
      store.saveSharedAgentEnvironment({
        entries: [
          { key: "MODEL_ACCOUNT", kind: "variable", encryptedValue: `account-a-${suffix}` },
        ],
      }),
      store.saveSharedAgentEnvironment({
        entries: [
          { key: "MODEL_ACCOUNT", kind: "variable", encryptedValue: `account-b-${suffix}` },
        ],
      }),
    ]);

    expect(results).toHaveLength(2);
    await expect(store.getSharedAgentEnvironmentRecord()).resolves.toMatchObject({
      entries: [expect.objectContaining({ key: "MODEL_ACCOUNT" })],
    });
  });
});
