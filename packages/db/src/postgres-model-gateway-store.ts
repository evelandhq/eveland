import {
  DEFAULT_PROJECT_MODEL_GATEWAY_MODE,
  isModelGatewayKind,
  isProjectModelGatewayMode,
  type IssuedModelGatewayKeyRecord,
  type ModelGateway,
  type ModelGatewayRecord,
  type ProjectModelGatewayRecord,
} from "@evelandhq/core/model-gateway";
import { eq } from "drizzle-orm";
import type { PostgresStoreContext } from "./postgres-store-support.js";
import { modelGateway, projectModelGateway } from "./schema.js";
import type { ModelGatewayStore } from "./store-domains.js";

const globalGatewayKey = "global";

type GatewayRow = typeof modelGateway.$inferSelect;
type ProjectRow = typeof projectModelGateway.$inferSelect;

export function createPostgresModelGatewayStore({ db }: PostgresStoreContext): ModelGatewayStore {
  return {
    async getModelGatewayRecord() {
      const [row] = await db
        .select()
        .from(modelGateway)
        .where(eq(modelGateway.key, globalGatewayKey));
      return row ? gatewayRowToRecord(row) : null;
    },

    async saveModelGateway(input) {
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(modelGateway)
          .where(eq(modelGateway.key, globalGatewayKey))
          .for("update");
        if (!existing) {
          const [created] = await tx
            .insert(modelGateway)
            .values({ key: globalGatewayKey, ...input })
            .returning();
          if (!created) throw new Error("Failed to create the Model Gateway.");
          return { gateway: gatewayRowToPublic(created), changed: true };
        }
        if (
          existing.kind === input.kind &&
          existing.baseUrl === input.baseUrl &&
          existing.encryptedCredential === input.encryptedCredential
        ) {
          return { gateway: gatewayRowToPublic(existing), changed: false };
        }
        const [updated] = await tx
          .update(modelGateway)
          .set({ ...input, revision: existing.revision + 1, updatedAt: new Date() })
          .where(eq(modelGateway.key, globalGatewayKey))
          .returning();
        if (!updated) throw new Error("Failed to update the Model Gateway.");
        return { gateway: gatewayRowToPublic(updated), changed: true };
      });
    },

    async deleteModelGateway() {
      const deleted = await db
        .delete(modelGateway)
        .where(eq(modelGateway.key, globalGatewayKey))
        .returning({ key: modelGateway.key });
      return deleted.length > 0;
    },

    async getProjectModelGatewayRecord(projectId) {
      const [row] = await db
        .select()
        .from(projectModelGateway)
        .where(eq(projectModelGateway.projectId, projectId));
      return row ? projectRowToRecord(row) : defaultProjectRecord(projectId);
    },

    async listProjectModelGatewayRecords() {
      const rows = await db.select().from(projectModelGateway);
      return rows.map(projectRowToRecord);
    },

    async saveProjectModelGatewaySettings(projectId, input) {
      const now = new Date();
      const values = {
        mode: input.mode,
        ...(input.encryptedProjectKey === undefined
          ? {}
          : { encryptedProjectKey: input.encryptedProjectKey }),
      };
      const [row] = await db
        .insert(projectModelGateway)
        .values({ projectId, ...values, updatedAt: now })
        .onConflictDoUpdate({
          target: projectModelGateway.projectId,
          set: { ...values, updatedAt: now },
        })
        .returning();
      if (!row) throw new Error("Failed to save the project's Model Gateway settings.");
      return projectRowToRecord(row);
    },

    async saveIssuedModelGatewayKey(projectId, issuedKey) {
      const now = new Date();
      const values = issuedKeyToColumns(issuedKey);
      await db
        .insert(projectModelGateway)
        .values({ projectId, ...values, updatedAt: now })
        .onConflictDoUpdate({
          target: projectModelGateway.projectId,
          set: { ...values, updatedAt: now },
        });
    },

    async savePendingModelGatewayRotationKey(projectId, encryptedKey) {
      const now = new Date();
      await db
        .insert(projectModelGateway)
        .values({ projectId, pendingRotationKeyEncrypted: encryptedKey, updatedAt: now })
        .onConflictDoUpdate({
          target: projectModelGateway.projectId,
          set: { pendingRotationKeyEncrypted: encryptedKey, updatedAt: now },
        });
    },
  };
}

function gatewayRowToRecord(row: GatewayRow): ModelGatewayRecord {
  if (!isModelGatewayKind(row.kind)) throw new Error(`Invalid Model Gateway kind ${row.kind}.`);
  return {
    kind: row.kind,
    baseUrl: row.baseUrl,
    encryptedCredential: row.encryptedCredential,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function gatewayRowToPublic(row: GatewayRow): ModelGateway {
  const { encryptedCredential: _credential, ...record } = gatewayRowToRecord(row);
  return { ...record, credentialConfigured: true };
}

function defaultProjectRecord(projectId: string): ProjectModelGatewayRecord {
  return {
    projectId,
    mode: DEFAULT_PROJECT_MODEL_GATEWAY_MODE,
    encryptedProjectKey: null,
    issuedKey: null,
    encryptedPendingRotationKey: null,
    updatedAt: null,
  };
}

function projectRowToRecord(row: ProjectRow): ProjectModelGatewayRecord {
  if (!isProjectModelGatewayMode(row.mode)) {
    throw new Error(`Invalid project Model Gateway mode ${row.mode}.`);
  }
  return {
    projectId: row.projectId,
    mode: row.mode,
    encryptedProjectKey: row.encryptedProjectKey,
    issuedKey: issuedKeyFromRow(row),
    encryptedPendingRotationKey: row.pendingRotationKeyEncrypted,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function issuedKeyFromRow(row: ProjectRow): IssuedModelGatewayKeyRecord | null {
  if (
    row.issuedKeyAlias === null ||
    row.issuedKeyEncrypted === null ||
    row.issuedKeyGatewayIdentity === null ||
    row.issuedKeyIssuedAt === null ||
    (row.issuedKeyState !== "pending" && row.issuedKeyState !== "registered")
  ) {
    return null;
  }
  return {
    alias: row.issuedKeyAlias,
    encryptedKey: row.issuedKeyEncrypted,
    gatewayIdentity: row.issuedKeyGatewayIdentity,
    state: row.issuedKeyState,
    issuedAt: row.issuedKeyIssuedAt.toISOString(),
  };
}

function issuedKeyToColumns(issuedKey: IssuedModelGatewayKeyRecord | null) {
  return {
    issuedKeyAlias: issuedKey?.alias ?? null,
    issuedKeyEncrypted: issuedKey?.encryptedKey ?? null,
    issuedKeyGatewayIdentity: issuedKey?.gatewayIdentity ?? null,
    issuedKeyState: issuedKey?.state ?? null,
    issuedKeyIssuedAt: issuedKey === null ? null : new Date(issuedKey.issuedAt),
  };
}
