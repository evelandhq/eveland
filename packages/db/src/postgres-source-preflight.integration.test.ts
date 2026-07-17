import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "./client.js";
import { createPostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.EVELAND_POSTGRES_TEST_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => database?.close());

describe.skipIf(!database)("Postgres source preflights", () => {
  test("atomically consumes a validated snapshot into one Project import", async () => {
    const store = createPostgresStore(database!);
    const suffix = Date.now().toString(36);
    const preflight = await store.createSourcePreflight({
      userId: "user_local_admin",
      kind: "zip",
      sourcePath: `/tmp/preflight-${suffix}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const claimed = await store.claimNextSourcePreflight("integration-worker");
    await store.completeSourcePreflight(preflight.id, claimed!.attempts, {
      sourcePath: `/tmp/preflight-${suffix}`,
      commitSha: null,
      summary: { eveVersion: "0.24.4" },
    });

    const created = await store.createProjectFromSourcePreflight({
      preflightId: preflight.id,
      userId: "user_local_admin",
      name: `preflight-${suffix}`,
      deployAfterImport: true,
      secrets: [{ key: "OPENAI_API_KEY", encryptedValue: "postgres-encrypted-key" }],
    });
    expect(created.outcome).toBe("created");
    if (created.outcome !== "created") throw new Error("Expected Project creation.");

    try {
      await expect(store.createProjectFromSourcePreflight({
        preflightId: preflight.id,
        userId: "user_local_admin",
        name: `preflight-second-${suffix}`,
      })).resolves.toEqual({ outcome: "consumed" });
      await expect(store.listProjectJobs(created.project.id)).resolves.toEqual([
        expect.objectContaining({
          type: "import_source",
          payload: expect.objectContaining({
            sourcePath: `/tmp/preflight-${suffix}`,
            deployAfterImport: true,
          }),
        }),
      ]);
      await expect(store.listSecretRecords(created.project.id)).resolves.toEqual([
        expect.objectContaining({ key: "OPENAI_API_KEY", encryptedValue: "postgres-encrypted-key" }),
      ]);
    } finally {
      await store.deleteProject(created.project.id);
      await store.expireSourcePreflights(new Date(Date.now() + 120_000));
    }
  });
});
