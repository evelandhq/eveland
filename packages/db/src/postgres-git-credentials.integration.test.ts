import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "./client.js";
import { createPostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.EVELAND_POSTGRES_TEST_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => database?.close());

describe.skipIf(!database)("Postgres Git credentials", () => {
  test("upserts and deletes a host credential within its user boundary", async () => {
    const store = createPostgresStore(database!);
    const host = `gitlab-${Date.now()}.example.com`;
    const project = await store.createProject({ name: `Git credential integration ${Date.now()}`, importKind: "git" });

    try {
      const first = await store.upsertGitCredential("user_local_admin", host, "encrypted-one");
      const updated = await store.upsertGitCredential("user_local_admin", host, "encrypted-two");

      expect(updated.id).toBe(first.id);
      await expect(store.getGitCredential("user_local_admin", host)).resolves.toMatchObject({
        encryptedToken: "encrypted-two",
      });
      expect(JSON.stringify(await store.listGitCredentials("user_local_admin"))).not.toContain("encrypted-two");
      await expect(store.deleteGitCredential("another_user", first.id)).resolves.toBe(false);
      await expect(store.deleteGitCredential("user_local_admin", first.id)).resolves.toBe(true);
    } finally {
      await store.deleteProject(project.id);
    }
  });
});
