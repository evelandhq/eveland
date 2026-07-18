import { createId } from "@eveland/core/ids";
import {
  SHARED_AGENT_ENVIRONMENT_PROFILE_ID,
  SHARED_AGENT_ENVIRONMENT_PROFILE_NAME,
  type PlatformSecretProfileBinding,
  type PlatformSecretProfileRecord,
  type SharedAgentEnvironmentBinding,
  type SharedAgentEnvironmentRecord,
} from "@eveland/core/contracts";
import { and, desc, eq, inArray } from "drizzle-orm";
import { secretRowToPublicSecret, secretRowToSecretRecord } from "./mappers.js";
import {
  deployments,
  platformSecretProfileBindings,
  platformSecretProfiles,
  projects,
  secrets,
} from "./schema.js";

const defaultOwner = {
  id: "user_local_admin",
  email: "admin@example.com",
  name: "Local Admin",
};

import type {
  PostgresDomain,
  PostgresStoreContext,
} from "./postgres-store-support.js";
import {
  normalizePlatformSecretProfileEntries,
  platformSecretProfileBindingRowToPublic,
  platformSecretProfileRowToPublic,
  platformSecretProfileRowToRecord,
  platformSecretProfileRowToSharedEnvironment,
  platformSecretProfileRowToSharedEnvironmentRecord,
} from "./postgres-store-support.js";

export function createPostgresSecretStore({
  db,
  ensureDeploymentRoutes,
  ensureDefaultOwner,
  createJob,
}: PostgresStoreContext): PostgresDomain {
  return {
    async listSecrets(projectId) {
      const rows = await db
        .select()
        .from(secrets)
        .where(eq(secrets.projectId, projectId))
        .orderBy(desc(secrets.updatedAt));
      return rows.map(secretRowToPublicSecret);
    },

    async upsertSecret(projectId, key, value) {
      const now = new Date();
      const [row] = await db
        .insert(secrets)
        .values({
          id: createId("secret"),
          projectId,
          key,
          encryptedValue: value,
        })
        .onConflictDoUpdate({
          target: [secrets.projectId, secrets.key],
          set: {
            encryptedValue: value,
            updatedAt: now,
          },
        })
        .returning();

      if (!row) {
        throw new Error("Failed to upsert secret.");
      }

      return secretRowToPublicSecret(row);
    },

    async deleteSecret(projectId, secretId) {
      const deleted = await db
        .delete(secrets)
        .where(and(eq(secrets.projectId, projectId), eq(secrets.id, secretId)))
        .returning({ id: secrets.id });
      return deleted.length > 0;
    },

    async listSecretRecords(projectId) {
      const rows = await db
        .select()
        .from(secrets)
        .where(eq(secrets.projectId, projectId));
      return rows.map(secretRowToSecretRecord);
    },

    async saveSharedAgentEnvironment(input) {
      return db.transaction(async (tx) => {
        const entries = normalizePlatformSecretProfileEntries(input.entries);
        let [existing] = await tx
          .select()
          .from(platformSecretProfiles)
          .where(eq(platformSecretProfiles.id, SHARED_AGENT_ENVIRONMENT_PROFILE_ID))
          .for("update");
        if (!existing) {
          const [created] = await tx
            .insert(platformSecretProfiles)
            .values({
              id: SHARED_AGENT_ENVIRONMENT_PROFILE_ID,
              name: SHARED_AGENT_ENVIRONMENT_PROFILE_NAME,
              entries,
            })
            .onConflictDoNothing({ target: platformSecretProfiles.id })
            .returning();
          if (created) return platformSecretProfileRowToSharedEnvironment(created);
          [existing] = await tx
            .select()
            .from(platformSecretProfiles)
            .where(eq(platformSecretProfiles.id, SHARED_AGENT_ENVIRONMENT_PROFILE_ID))
            .for("update");
          if (!existing) throw new Error("Failed to create the shared Agent environment.");
        }
        const existingEntries = normalizePlatformSecretProfileEntries(existing.entries);
        if (JSON.stringify(existingEntries) === JSON.stringify(entries)) {
          return platformSecretProfileRowToSharedEnvironment(existing);
        }
        const [updated] = await tx
          .update(platformSecretProfiles)
          .set({ entries, revision: existing.revision + 1, updatedAt: new Date() })
          .where(eq(platformSecretProfiles.id, SHARED_AGENT_ENVIRONMENT_PROFILE_ID))
          .returning();
        if (!updated) throw new Error("Failed to update the shared Agent environment.");
        return platformSecretProfileRowToSharedEnvironment(updated);
      });
    },

    async getSharedAgentEnvironmentRecord() {
      const [row] = await db
        .select()
        .from(platformSecretProfiles)
        .where(eq(platformSecretProfiles.id, SHARED_AGENT_ENVIRONMENT_PROFILE_ID));
      return row ? platformSecretProfileRowToSharedEnvironmentRecord(row) : null;
    },

    async bindSharedAgentEnvironment(input) {
      const binding = await this.bindPlatformSecretProfile({
        ...input,
        profileId: SHARED_AGENT_ENVIRONMENT_PROFILE_ID,
        consumer: "agent-runtime",
      });
      return toSharedAgentEnvironmentBinding(binding);
    },

    async listProjectSharedAgentEnvironmentBindings(projectId) {
      return (await this.listProjectPlatformSecretBindings(projectId))
        .filter(isSharedAgentEnvironmentBinding)
        .map(toSharedAgentEnvironmentBinding);
    },

    async listSharedAgentEnvironmentBindings() {
      return (await this.listPlatformSecretProfileBindings(
        SHARED_AGENT_ENVIRONMENT_PROFILE_ID,
      ))
        .filter(isSharedAgentEnvironmentBinding)
        .map(toSharedAgentEnvironmentBinding);
    },

    async deleteSharedAgentEnvironmentBinding(projectId, bindingId) {
      const existing = (await this.listProjectPlatformSecretBindings(projectId))
        .find((binding) => binding.id === bindingId && isSharedAgentEnvironmentBinding(binding));
      if (!existing) return null;
      const deleted = await this.deletePlatformSecretProfileBinding(projectId, bindingId);
      return deleted ? toSharedAgentEnvironmentBinding(deleted) : null;
    },

    async resolveSharedAgentEnvironmentRecords(input) {
      const records = await this.resolvePlatformSecretProfileRecords({
        ...input,
        consumer: "agent-runtime",
      });
      const toSharedRecord = (record: PlatformSecretProfileRecord | null): SharedAgentEnvironmentRecord | null =>
        record?.id === SHARED_AGENT_ENVIRONMENT_PROFILE_ID
          ? platformSecretProfileRecordToSharedEnvironmentRecord(record)
          : null;
      return {
        project: toSharedRecord(records.project),
        deployment: toSharedRecord(records.deployment),
      };
    },

    async savePlatformSecretProfile(input) {
      return db.transaction(async (tx) => {
        const entries = normalizePlatformSecretProfileEntries(input.entries);
        if (!input.id) {
          const [created] = await tx
            .insert(platformSecretProfiles)
            .values({
              id: createId("sp"),
              name: input.name,
              entries,
            })
            .returning();
          if (!created)
            throw new Error("Failed to create Platform Secret Profile.");
          return platformSecretProfileRowToPublic(created);
        }

        const [existing] = await tx
          .select()
          .from(platformSecretProfiles)
          .where(eq(platformSecretProfiles.id, input.id))
          .for("update");
        if (!existing) throw new Error("Platform Secret Profile not found.");

        const existingEntries = normalizePlatformSecretProfileEntries(
          existing.entries,
        );
        const unchanged =
          existing.name === input.name &&
          JSON.stringify(existingEntries) === JSON.stringify(entries);
        if (unchanged) return platformSecretProfileRowToPublic(existing);

        const [updated] = await tx
          .update(platformSecretProfiles)
          .set({
            name: input.name,
            entries,
            revision: existing.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(platformSecretProfiles.id, input.id))
          .returning();
        if (!updated)
          throw new Error("Failed to update Platform Secret Profile.");
        return platformSecretProfileRowToPublic(updated);
      });
    },

    async listPlatformSecretProfiles() {
      const rows = await db
        .select()
        .from(platformSecretProfiles)
        .orderBy(desc(platformSecretProfiles.updatedAt));
      return rows.map(platformSecretProfileRowToPublic);
    },

    async getPlatformSecretProfileRecord(profileId) {
      const [row] = await db
        .select()
        .from(platformSecretProfiles)
        .where(eq(platformSecretProfiles.id, profileId))
        .limit(1);
      return row ? platformSecretProfileRowToRecord(row) : null;
    },

    async bindPlatformSecretProfile(input) {
      if (
        input.profileId === SHARED_AGENT_ENVIRONMENT_PROFILE_ID
        && input.consumer !== "agent-runtime"
      ) {
        throw new Error("The shared Agent environment cannot be used for Agent Connection credentials.");
      }
      if (input.consumer === "agent-connection" && input.deploymentId) {
        throw new Error(
          "Agent Connection Secret Profile bindings must be Project-scoped.",
        );
      }
      const [profile] = await db
        .select()
        .from(platformSecretProfiles)
        .where(eq(platformSecretProfiles.id, input.profileId))
        .limit(1);
      if (!profile) throw new Error("Platform Secret Profile not found.");
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);
      if (!project) throw new Error("Project not found.");
      if (input.deploymentId) {
        const [deployment] = await db
          .select({ id: deployments.id })
          .from(deployments)
          .where(
            and(
              eq(deployments.id, input.deploymentId),
              eq(deployments.projectId, input.projectId),
            ),
          )
          .limit(1);
        if (!deployment) throw new Error("Deployment not found for Project.");
      }
      const [row] = await db
        .insert(platformSecretProfileBindings)
        .values({
          id: createId("spb"),
          profileId: input.profileId,
          projectId: input.projectId,
          deploymentId: input.deploymentId,
          targetKey: input.deploymentId ?? "",
          consumer: input.consumer,
        })
        .onConflictDoUpdate({
          target: [
            platformSecretProfileBindings.projectId,
            platformSecretProfileBindings.targetKey,
            platformSecretProfileBindings.consumer,
          ],
          set: { profileId: input.profileId, updatedAt: new Date() },
        })
        .returning();
      if (!row) throw new Error("Failed to bind Platform Secret Profile.");
      return platformSecretProfileBindingRowToPublic(row, profile);
    },

    async listProjectPlatformSecretBindings(projectId) {
      const rows = await db
        .select({
          binding: platformSecretProfileBindings,
          profile: platformSecretProfiles,
        })
        .from(platformSecretProfileBindings)
        .innerJoin(
          platformSecretProfiles,
          eq(
            platformSecretProfiles.id,
            platformSecretProfileBindings.profileId,
          ),
        )
        .where(eq(platformSecretProfileBindings.projectId, projectId));
      return rows
        .map(({ binding, profile }) =>
          platformSecretProfileBindingRowToPublic(binding, profile),
        )
        .sort(
          (left, right) =>
            left.consumer.localeCompare(right.consumer) ||
            (left.deploymentId ?? "").localeCompare(right.deploymentId ?? ""),
        );
    },

    async listPlatformSecretProfileBindings(profileId) {
      const rows = await db
        .select({
          binding: platformSecretProfileBindings,
          profile: platformSecretProfiles,
        })
        .from(platformSecretProfileBindings)
        .innerJoin(
          platformSecretProfiles,
          eq(
            platformSecretProfiles.id,
            platformSecretProfileBindings.profileId,
          ),
        )
        .where(eq(platformSecretProfileBindings.profileId, profileId));
      return rows.map(({ binding, profile }) =>
        platformSecretProfileBindingRowToPublic(binding, profile),
      );
    },

    async deletePlatformSecretProfileBinding(projectId, bindingId) {
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select({
            binding: platformSecretProfileBindings,
            profile: platformSecretProfiles,
          })
          .from(platformSecretProfileBindings)
          .innerJoin(
            platformSecretProfiles,
            eq(
              platformSecretProfiles.id,
              platformSecretProfileBindings.profileId,
            ),
          )
          .where(
            and(
              eq(platformSecretProfileBindings.projectId, projectId),
              eq(platformSecretProfileBindings.id, bindingId),
            ),
          )
          .for("update")
          .limit(1);
        if (!existing) return null;
        await tx
          .delete(platformSecretProfileBindings)
          .where(eq(platformSecretProfileBindings.id, bindingId));
        return platformSecretProfileBindingRowToPublic(
          existing.binding,
          existing.profile,
        );
      });
    },

    async deletePlatformSecretProfile(profileId) {
      const deleted = await db
        .delete(platformSecretProfiles)
        .where(eq(platformSecretProfiles.id, profileId))
        .returning({ id: platformSecretProfiles.id });
      return deleted.length > 0;
    },

    async resolvePlatformSecretProfileRecords(input) {
      const targetKeys = input.deploymentId ? ["", input.deploymentId] : [""];
      const rows = await db
        .select({
          binding: platformSecretProfileBindings,
          profile: platformSecretProfiles,
        })
        .from(platformSecretProfileBindings)
        .innerJoin(
          platformSecretProfiles,
          eq(
            platformSecretProfiles.id,
            platformSecretProfileBindings.profileId,
          ),
        )
        .where(
          and(
            eq(platformSecretProfileBindings.projectId, input.projectId),
            eq(platformSecretProfileBindings.consumer, input.consumer),
            inArray(platformSecretProfileBindings.targetKey, targetKeys),
          ),
        );
      const find = (targetKey: string) =>
        rows.find(({ binding }) => binding.targetKey === targetKey)?.profile;
      const projectProfile = find("");
      const deploymentProfile = input.deploymentId
        ? find(input.deploymentId)
        : undefined;
      return {
        project: projectProfile
          ? platformSecretProfileRowToRecord(projectProfile)
          : null,
        deployment: deploymentProfile
          ? platformSecretProfileRowToRecord(deploymentProfile)
          : null,
      };
    },
  };
}

function isSharedAgentEnvironmentBinding(
  binding: PlatformSecretProfileBinding,
): boolean {
  return binding.profileId === SHARED_AGENT_ENVIRONMENT_PROFILE_ID
    && binding.consumer === "agent-runtime";
}

function toSharedAgentEnvironmentBinding(
  binding: PlatformSecretProfileBinding,
): SharedAgentEnvironmentBinding {
  return {
    id: binding.id,
    projectId: binding.projectId,
    deploymentId: binding.deploymentId,
    environmentRevision: binding.profileRevision,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

function platformSecretProfileRecordToSharedEnvironmentRecord(
  profile: PlatformSecretProfileRecord,
): SharedAgentEnvironmentRecord {
  const { id: _id, name: _name, ...environment } = profile;
  return environment;
}
