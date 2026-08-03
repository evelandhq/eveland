import { createId } from "@eveland/core/ids";
import { and, desc, eq } from "drizzle-orm";
import { secretRowToPublicSecret, secretRowToSecretRecord } from "./mappers.js";
import type { SecretStore } from "./store-domains.js";
import type { PostgresStoreContext } from "./postgres-store-support.js";
import {
  normalizeSharedAgentEnvironmentEntries,
  sharedAgentEnvironmentRowToPublic,
  sharedAgentEnvironmentRowToRecord,
} from "./postgres-store-support.js";
import { secrets, sharedAgentEnvironment } from "./schema.js";

const globalEnvironmentKey = "global";

export function createPostgresSecretStore({ db }: PostgresStoreContext): SecretStore {
  return {
    async listSecrets(projectId) {
      const rows = await db
        .select()
        .from(secrets)
        .where(eq(secrets.projectId, projectId))
        .orderBy(desc(secrets.updatedAt));
      return rows.map(secretRowToPublicSecret);
    },

    async upsertSecret(projectId, key, value, kind = "secret") {
      const now = new Date();
      const [row] = await db
        .insert(secrets)
        .values({
          id: createId("secret"),
          projectId,
          key,
          kind,
          encryptedValue: value,
        })
        .onConflictDoUpdate({
          target: [secrets.projectId, secrets.key],
          set: {
            encryptedValue: value,
            kind,
            updatedAt: now,
          },
        })
        .returning();

      if (!row) throw new Error("Failed to upsert secret.");
      return secretRowToPublicSecret(row);
    },

    async upsertSecrets(projectId, entries) {
      return db.transaction(async (tx) => {
        const result = [];
        for (const entry of entries) {
          const now = new Date();
          const [row] = await tx
            .insert(secrets)
            .values({
              id: createId("secret"),
              projectId,
              key: entry.key,
              kind: entry.kind ?? "secret",
              encryptedValue: entry.value,
            })
            .onConflictDoUpdate({
              target: [secrets.projectId, secrets.key],
              set: {
                encryptedValue: entry.value,
                kind: entry.kind ?? "secret",
                updatedAt: now,
              },
            })
            .returning();
          if (!row) throw new Error("Failed to upsert project environment entry.");
          result.push(secretRowToPublicSecret(row));
        }
        return result;
      });
    },

    async updateSecret(projectId, secretId, input) {
      const [row] = await db
        .update(secrets)
        .set({
          key: input.key,
          kind: input.kind,
          ...(input.encryptedValue !== undefined ? { encryptedValue: input.encryptedValue } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(secrets.projectId, projectId), eq(secrets.id, secretId)))
        .returning();
      return row ? secretRowToPublicSecret(row) : null;
    },

    async deleteSecret(projectId, secretId) {
      const deleted = await db
        .delete(secrets)
        .where(and(eq(secrets.projectId, projectId), eq(secrets.id, secretId)))
        .returning({ id: secrets.id });
      return deleted.length > 0;
    },

    async listSecretRecords(projectId) {
      const rows = await db.select().from(secrets).where(eq(secrets.projectId, projectId));
      return rows.map(secretRowToSecretRecord);
    },

    async saveSharedAgentEnvironment(input) {
      return db.transaction(async (tx) => {
        const entries = normalizeSharedAgentEnvironmentEntries(input.entries);
        let [existing] = await tx
          .select()
          .from(sharedAgentEnvironment)
          .where(eq(sharedAgentEnvironment.key, globalEnvironmentKey))
          .for("update");
        if (!existing) {
          const [created] = await tx
            .insert(sharedAgentEnvironment)
            .values({ key: globalEnvironmentKey, entries })
            .onConflictDoNothing({ target: sharedAgentEnvironment.key })
            .returning();
          if (created) return sharedAgentEnvironmentRowToPublic(created);
          [existing] = await tx
            .select()
            .from(sharedAgentEnvironment)
            .where(eq(sharedAgentEnvironment.key, globalEnvironmentKey))
            .for("update");
          if (!existing) throw new Error("Failed to create the shared Agent environment.");
        }
        const existingEntries = normalizeSharedAgentEnvironmentEntries(existing.entries);
        if (JSON.stringify(existingEntries) === JSON.stringify(entries)) {
          return sharedAgentEnvironmentRowToPublic(existing);
        }
        const [updated] = await tx
          .update(sharedAgentEnvironment)
          .set({ entries, revision: existing.revision + 1, updatedAt: new Date() })
          .where(eq(sharedAgentEnvironment.key, globalEnvironmentKey))
          .returning();
        if (!updated) throw new Error("Failed to update the shared Agent environment.");
        return sharedAgentEnvironmentRowToPublic(updated);
      });
    },

    async getSharedAgentEnvironmentRecord() {
      const [row] = await db
        .select()
        .from(sharedAgentEnvironment)
        .where(eq(sharedAgentEnvironment.key, globalEnvironmentKey));
      return row ? sharedAgentEnvironmentRowToRecord(row) : null;
    },
  };
}
