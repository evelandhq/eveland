import { createId } from "@evelandhq/core/ids";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  modelGatewayApiKeys,
  modelGatewayModelRoutes,
  modelGatewayProviderConnections,
  modelGatewayRegistryEvents,
} from "./schema.js";
import type {
  ModelGatewayApiKeyRecord,
  ModelGatewayModelRouteRecord,
  ModelGatewayProviderConnectionRecord,
  ModelGatewayRegistryEventRecord,
  ModelGatewayRegistryStore,
} from "./store-domains.js";
import type { PostgresStoreContext } from "./postgres-store-support.js";

export function createPostgresModelGatewayStore({
  db,
}: PostgresStoreContext): ModelGatewayRegistryStore {
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  async function appendEvent(
    tx: Tx,
    kind: string,
    subject: string,
    detail: Record<string, unknown> | null,
    now: Date,
  ): Promise<void> {
    await tx.insert(modelGatewayRegistryEvents).values({
      id: createId("mgev"),
      kind,
      subject,
      detail,
      createdAt: now,
    });
  }

  return {
    async upsertModelGatewayProviderConnection(input, now = new Date()) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(modelGatewayProviderConnections)
          .values({
            id: createId("mgpc"),
            providerId: input.providerId,
            name: input.name,
            baseUrl: input.baseUrl,
            encryptedApiKey: input.encryptedApiKey,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: modelGatewayProviderConnections.providerId,
            set: {
              name: input.name,
              baseUrl: input.baseUrl,
              encryptedApiKey: input.encryptedApiKey,
              updatedAt: now,
            },
          })
          .returning();
        if (!row) throw new Error("Failed to upsert the provider connection.");
        await appendEvent(
          tx,
          "provider.upserted",
          input.providerId,
          { name: input.name, baseUrl: input.baseUrl },
          now,
        );
        return connectionRowToRecord(row);
      });
    },

    async listModelGatewayProviderConnections() {
      const rows = await db
        .select()
        .from(modelGatewayProviderConnections)
        .orderBy(modelGatewayProviderConnections.providerId);
      return rows.map(connectionRowToRecord);
    },

    async deleteModelGatewayProviderConnection(providerId, now = new Date()) {
      return db.transaction(async (tx) => {
        const deleted = await tx
          .delete(modelGatewayProviderConnections)
          .where(eq(modelGatewayProviderConnections.providerId, providerId))
          .returning({ id: modelGatewayProviderConnections.id });
        if (deleted.length === 0) return false;
        await appendEvent(tx, "provider.deleted", providerId, null, now);
        return true;
      });
    },

    async upsertModelGatewayModelRoute(input, now = new Date()) {
      return db.transaction(async (tx) => {
        const [connection] = await tx
          .select({ id: modelGatewayProviderConnections.id })
          .from(modelGatewayProviderConnections)
          .where(eq(modelGatewayProviderConnections.providerId, input.providerId))
          .limit(1);
        if (!connection) {
          throw new Error(
            `Cannot route "${input.modelId}" to unknown provider "${input.providerId}".`,
          );
        }
        const [row] = await tx
          .insert(modelGatewayModelRoutes)
          .values({
            id: createId("mgrt"),
            modelId: input.modelId,
            connectionId: connection.id,
            providerModelId: input.providerModelId,
            displayName: input.displayName ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: modelGatewayModelRoutes.modelId,
            set: {
              connectionId: connection.id,
              providerModelId: input.providerModelId,
              displayName: input.displayName ?? null,
              updatedAt: now,
            },
          })
          .returning();
        if (!row) throw new Error("Failed to upsert the model route.");
        await appendEvent(
          tx,
          "route.upserted",
          input.modelId,
          { providerId: input.providerId, providerModelId: input.providerModelId },
          now,
        );
        return {
          id: row.id,
          modelId: row.modelId,
          providerId: input.providerId,
          providerModelId: row.providerModelId,
          displayName: row.displayName,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      });
    },

    async listModelGatewayModelRoutes() {
      const rows = await db
        .select({
          id: modelGatewayModelRoutes.id,
          modelId: modelGatewayModelRoutes.modelId,
          providerId: modelGatewayProviderConnections.providerId,
          providerModelId: modelGatewayModelRoutes.providerModelId,
          displayName: modelGatewayModelRoutes.displayName,
          createdAt: modelGatewayModelRoutes.createdAt,
          updatedAt: modelGatewayModelRoutes.updatedAt,
        })
        .from(modelGatewayModelRoutes)
        .innerJoin(
          modelGatewayProviderConnections,
          eq(modelGatewayProviderConnections.id, modelGatewayModelRoutes.connectionId),
        )
        .orderBy(modelGatewayModelRoutes.modelId);
      return rows.map((row): ModelGatewayModelRouteRecord => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));
    },

    async deleteModelGatewayModelRoute(modelId, now = new Date()) {
      return db.transaction(async (tx) => {
        const deleted = await tx
          .delete(modelGatewayModelRoutes)
          .where(eq(modelGatewayModelRoutes.modelId, modelId))
          .returning({ id: modelGatewayModelRoutes.id });
        if (deleted.length === 0) return false;
        await appendEvent(tx, "route.deleted", modelId, null, now);
        return true;
      });
    },

    async mintModelGatewayApiKey(input, now = new Date()) {
      const [row] = await db
        .insert(modelGatewayApiKeys)
        .values({
          id: createId("mgak"),
          userId: input.userId,
          name: input.name,
          tokenHash: input.tokenHash,
          createdAt: now,
        })
        .returning();
      if (!row) throw new Error("Failed to mint the model gateway API key.");
      return apiKeyRowToRecord(row);
    },

    async listModelGatewayApiKeys() {
      const rows = await db
        .select()
        .from(modelGatewayApiKeys)
        .orderBy(desc(modelGatewayApiKeys.createdAt));
      return rows.map(apiKeyRowToRecord);
    },

    async revokeModelGatewayApiKey(id, now = new Date()) {
      const updated = await db
        .update(modelGatewayApiKeys)
        .set({ revokedAt: now })
        .where(eq(modelGatewayApiKeys.id, id))
        .returning({ id: modelGatewayApiKeys.id });
      return updated.length > 0;
    },

    async findActiveModelGatewayApiKeyByHash(tokenHash) {
      const [row] = await db
        .select({ id: modelGatewayApiKeys.id, userId: modelGatewayApiKeys.userId })
        .from(modelGatewayApiKeys)
        .where(
          and(eq(modelGatewayApiKeys.tokenHash, tokenHash), isNull(modelGatewayApiKeys.revokedAt)),
        )
        .limit(1);
      return row ?? null;
    },

    async listModelGatewayRegistryEvents(limit) {
      const rows = await db
        .select()
        .from(modelGatewayRegistryEvents)
        .orderBy(desc(modelGatewayRegistryEvents.createdAt), desc(modelGatewayRegistryEvents.id))
        .limit(limit);
      return rows.map((row): ModelGatewayRegistryEventRecord => ({
        id: row.id,
        kind: row.kind,
        subject: row.subject,
        detail: (row.detail as Record<string, unknown> | null) ?? null,
        createdAt: row.createdAt.toISOString(),
      }));
    },
  };

  function apiKeyRowToRecord(row: {
    id: string;
    userId: string;
    name: string;
    createdAt: Date;
    revokedAt: Date | null;
  }): ModelGatewayApiKeyRecord {
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
    };
  }

  function connectionRowToRecord(row: {
    id: string;
    providerId: string;
    name: string;
    baseUrl: string;
    encryptedApiKey: string;
    createdAt: Date;
    updatedAt: Date;
  }): ModelGatewayProviderConnectionRecord {
    return {
      id: row.id,
      providerId: row.providerId,
      name: row.name,
      baseUrl: row.baseUrl,
      encryptedApiKey: row.encryptedApiKey,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
