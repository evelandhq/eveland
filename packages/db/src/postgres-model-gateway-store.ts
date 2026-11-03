import {
  DEFAULT_PROJECT_MODEL_GATEWAY_MODE,
  isModelGatewayKind,
  isProjectModelGatewayMode,
  type ModelGateway,
  type ProjectModelGateway,
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
    async getModelGateway() {
      const [row] = await db
        .select()
        .from(modelGateway)
        .where(eq(modelGateway.key, globalGatewayKey));
      return row ? gatewayRowToPublic(row) : null;
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
        if (existing.kind === input.kind && existing.baseUrl === input.baseUrl) {
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

    async getProjectModelGateway(projectId) {
      const [row] = await db
        .select()
        .from(projectModelGateway)
        .where(eq(projectModelGateway.projectId, projectId));
      return row ? projectRowToPublic(row) : defaultProjectSetting(projectId);
    },

    async listProjectModelGateways() {
      const rows = await db.select().from(projectModelGateway);
      return rows.map(projectRowToPublic);
    },

    async saveProjectModelGatewayMode(projectId, mode) {
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(projectModelGateway)
          .where(eq(projectModelGateway.projectId, projectId))
          .for("update");
        const previousMode = existing?.mode ?? DEFAULT_PROJECT_MODEL_GATEWAY_MODE;
        const now = new Date();
        const [row] = await tx
          .insert(projectModelGateway)
          .values({ projectId, mode, updatedAt: now })
          .onConflictDoUpdate({
            target: projectModelGateway.projectId,
            set: { mode, updatedAt: now },
          })
          .returning();
        if (!row) throw new Error("Failed to save the project's Model Gateway setting.");
        return { setting: projectRowToPublic(row), changed: previousMode !== mode };
      });
    },
  };
}

function gatewayRowToPublic(row: GatewayRow): ModelGateway {
  if (!isModelGatewayKind(row.kind)) throw new Error(`Invalid Model Gateway kind ${row.kind}.`);
  return {
    kind: row.kind,
    baseUrl: row.baseUrl,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function defaultProjectSetting(projectId: string): ProjectModelGateway {
  return { projectId, mode: DEFAULT_PROJECT_MODEL_GATEWAY_MODE, updatedAt: null };
}

function projectRowToPublic(row: ProjectRow): ProjectModelGateway {
  if (!isProjectModelGatewayMode(row.mode)) {
    throw new Error(`Invalid project Model Gateway mode ${row.mode}.`);
  }
  return { projectId: row.projectId, mode: row.mode, updatedAt: row.updatedAt.toISOString() };
}
