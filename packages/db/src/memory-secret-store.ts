import type {
  PlatformSecretProfile,
  PlatformSecretProfileBinding,
  PlatformSecretProfileRecord,
  PublicSecret,
  SecretRecord,
  SharedAgentEnvironment,
  SharedAgentEnvironmentBinding,
  SharedAgentEnvironmentRecord,
} from "@eveland/core/contracts";
import {
  SHARED_AGENT_ENVIRONMENT_PROFILE_ID,
  SHARED_AGENT_ENVIRONMENT_PROFILE_NAME,
} from "@eveland/core/contracts";
import { createId } from "@eveland/core/ids";
import type { MemoryState } from "./memory-state.js";
import type { MemoryDomain } from "./memory-store-support.js";
import type { SecretStore } from "./store-domains.js";

export function createMemorySecretStore(
  state: MemoryState,
): MemoryDomain<SecretStore> {
  return {
    async listSecrets(projectId) {
      return state.secrets
        .filter((secret) => secret.projectId === projectId)
        .map(toPublicSecret);
    },

    async upsertSecret(projectId, key, value) {
      const now = new Date().toISOString();
      const existing = state.secrets.find(
        (secret) => secret.projectId === projectId && secret.key === key,
      );

      if (existing) {
        existing.encryptedValue = value;
        existing.updatedAt = now;
        return toPublicSecret(existing);
      }

      const secret: SecretRecord = {
        id: createId("secret"),
        projectId,
        key,
        encryptedValue: value,
        createdAt: now,
        updatedAt: now,
      };
      state.secrets.push(secret);
      return toPublicSecret(secret);
    },

    async deleteSecret(projectId, secretId) {
      const before = state.secrets.length;
      state.secrets = state.secrets.filter(
        (secret) => secret.projectId !== projectId || secret.id !== secretId,
      );
      return state.secrets.length !== before;
    },

    async listSecretRecords(projectId) {
      return state.secrets.filter((secret) => secret.projectId === projectId);
    },

    async saveSharedAgentEnvironment(input) {
      const now = new Date().toISOString();
      const entries = normalizePlatformSecretProfileEntries(input.entries);
      const existing = state.platformSecretProfiles.find(
        (profile) => profile.id === SHARED_AGENT_ENVIRONMENT_PROFILE_ID,
      );
      if (existing) {
        if (!platformSecretProfileEntriesEqual(existing.entries, entries)) {
          existing.entries = entries;
          existing.revision += 1;
          existing.updatedAt = now;
        }
        return toSharedAgentEnvironment(existing);
      }
      const profile: PlatformSecretProfileRecord = {
        id: SHARED_AGENT_ENVIRONMENT_PROFILE_ID,
        name: SHARED_AGENT_ENVIRONMENT_PROFILE_NAME,
        revision: 1,
        entries,
        createdAt: now,
        updatedAt: now,
      };
      state.platformSecretProfiles.push(profile);
      return toSharedAgentEnvironment(profile);
    },

    async getSharedAgentEnvironmentRecord() {
      const profile = state.platformSecretProfiles.find(
        (candidate) => candidate.id === SHARED_AGENT_ENVIRONMENT_PROFILE_ID,
      );
      return profile ? toSharedAgentEnvironmentRecord(profile) : null;
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
      const toSharedRecord = (record: PlatformSecretProfileRecord | null) =>
        record?.id === SHARED_AGENT_ENVIRONMENT_PROFILE_ID
          ? toSharedAgentEnvironmentRecord(record)
          : null;
      return {
        project: toSharedRecord(records.project),
        deployment: toSharedRecord(records.deployment),
      };
    },

    async savePlatformSecretProfile(input) {
      const now = new Date().toISOString();
      const entries = normalizePlatformSecretProfileEntries(input.entries);
      const existing = input.id
        ? state.platformSecretProfiles.find(
            (profile) => profile.id === input.id,
          )
        : undefined;
      if (input.id && !existing)
        throw new Error("Platform Secret Profile not found.");

      if (existing) {
        const unchanged =
          existing.name === input.name &&
          platformSecretProfileEntriesEqual(existing.entries, entries);
        if (!unchanged) {
          existing.name = input.name;
          existing.entries = entries;
          existing.revision += 1;
          existing.updatedAt = now;
        }
        return toPlatformSecretProfile(existing);
      }

      const profile: PlatformSecretProfileRecord = {
        id: createId("sp"),
        name: input.name,
        revision: 1,
        entries,
        createdAt: now,
        updatedAt: now,
      };
      state.platformSecretProfiles.push(profile);
      return toPlatformSecretProfile(profile);
    },

    async listPlatformSecretProfiles() {
      return [...state.platformSecretProfiles]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(toPlatformSecretProfile);
    },

    async getPlatformSecretProfileRecord(profileId) {
      return (
        state.platformSecretProfiles.find(
          (profile) => profile.id === profileId,
        ) ?? null
      );
    },

    async bindPlatformSecretProfile(input) {
      if (
        input.profileId === SHARED_AGENT_ENVIRONMENT_PROFILE_ID
        && input.consumer !== "agent-runtime"
      ) {
        throw new Error("The shared Agent environment cannot be used for Agent Connection credentials.");
      }
      const profile = state.platformSecretProfiles.find(
        (candidate) => candidate.id === input.profileId,
      );
      if (!profile) throw new Error("Platform Secret Profile not found.");
      if (!state.projects.some((project) => project.id === input.projectId))
        throw new Error("Project not found.");
      if (input.consumer === "agent-connection" && input.deploymentId) {
        throw new Error(
          "Agent Connection Secret Profile bindings must be Project-scoped.",
        );
      }
      if (
        input.deploymentId &&
        !state.deployments.some(
          (deployment) =>
            deployment.id === input.deploymentId &&
            deployment.projectId === input.projectId,
        )
      ) {
        throw new Error("Deployment not found for Project.");
      }
      const now = new Date().toISOString();
      const existing = state.platformSecretProfileBindings.find(
        (binding) =>
          binding.projectId === input.projectId &&
          binding.deploymentId === input.deploymentId &&
          binding.consumer === input.consumer,
      );
      if (existing) {
        existing.profileId = input.profileId;
        existing.updatedAt = now;
        return toPlatformSecretProfileBinding(existing, profile);
      }
      const binding = {
        id: createId("spb"),
        ...input,
        createdAt: now,
        updatedAt: now,
      };
      state.platformSecretProfileBindings.push(binding);
      return toPlatformSecretProfileBinding(binding, profile);
    },

    async listProjectPlatformSecretBindings(projectId) {
      return state.platformSecretProfileBindings
        .filter((binding) => binding.projectId === projectId)
        .map((binding) => {
          const profile = state.platformSecretProfiles.find(
            (candidate) => candidate.id === binding.profileId,
          );
          if (!profile)
            throw new Error(
              "Platform Secret Profile binding references a missing Profile.",
            );
          return toPlatformSecretProfileBinding(binding, profile);
        })
        .sort(
          (left, right) =>
            left.consumer.localeCompare(right.consumer) ||
            (left.deploymentId ?? "").localeCompare(right.deploymentId ?? ""),
        );
    },

    async listPlatformSecretProfileBindings(profileId) {
      return state.platformSecretProfileBindings
        .filter((binding) => binding.profileId === profileId)
        .map((binding) => {
          const profile = state.platformSecretProfiles.find(
            (candidate) => candidate.id === binding.profileId,
          );
          if (!profile)
            throw new Error(
              "Platform Secret Profile binding references a missing Profile.",
            );
          return toPlatformSecretProfileBinding(binding, profile);
        });
    },

    async deletePlatformSecretProfileBinding(projectId, bindingId) {
      const index = state.platformSecretProfileBindings.findIndex(
        (binding) =>
          binding.projectId === projectId && binding.id === bindingId,
      );
      if (index < 0) return null;
      const [binding] = state.platformSecretProfileBindings.splice(index, 1);
      const profile = state.platformSecretProfiles.find(
        (candidate) => candidate.id === binding!.profileId,
      );
      if (!profile)
        throw new Error(
          "Platform Secret Profile binding references a missing Profile.",
        );
      return toPlatformSecretProfileBinding(binding!, profile);
    },

    async deletePlatformSecretProfile(profileId) {
      const before = state.platformSecretProfiles.length;
      state.platformSecretProfiles = state.platformSecretProfiles.filter(
        (profile) => profile.id !== profileId,
      );
      if (state.platformSecretProfiles.length === before) return false;
      state.platformSecretProfileBindings =
        state.platformSecretProfileBindings.filter(
          (binding) => binding.profileId !== profileId,
        );
      return true;
    },

    async resolvePlatformSecretProfileRecords(input) {
      const find = (deploymentId: string | null) => {
        const binding = state.platformSecretProfileBindings.find(
          (candidate) =>
            candidate.projectId === input.projectId &&
            candidate.deploymentId === deploymentId &&
            candidate.consumer === input.consumer,
        );
        return binding
          ? (state.platformSecretProfiles.find(
              (profile) => profile.id === binding.profileId,
            ) ?? null)
          : null;
      };
      return {
        project: find(null),
        deployment: input.deploymentId ? find(input.deploymentId) : null,
      };
    },
  };
}

function toPublicSecret(secret: SecretRecord): PublicSecret {
  const { encryptedValue: _encryptedValue, ...publicSecret } = secret;
  return publicSecret;
}

function normalizePlatformSecretProfileEntries(
  entries: PlatformSecretProfileRecord["entries"],
): PlatformSecretProfileRecord["entries"] {
  return [...entries]
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function platformSecretProfileEntriesEqual(
  left: PlatformSecretProfileRecord["entries"],
  right: PlatformSecretProfileRecord["entries"],
): boolean {
  return (
    JSON.stringify(normalizePlatformSecretProfileEntries(left)) ===
    JSON.stringify(right)
  );
}

function toPlatformSecretProfile(
  profile: PlatformSecretProfileRecord,
): PlatformSecretProfile {
  return {
    ...profile,
    entries: profile.entries.map(({ key, kind }) => ({
      key,
      kind,
      configured: true,
    })),
  };
}

function toSharedAgentEnvironmentRecord(
  profile: PlatformSecretProfileRecord,
): SharedAgentEnvironmentRecord {
  const { id: _id, name: _name, ...environment } = profile;
  return environment;
}

function toSharedAgentEnvironment(
  profile: PlatformSecretProfileRecord,
): SharedAgentEnvironment {
  const { id: _id, name: _name, ...environment } = toPlatformSecretProfile(profile);
  return environment;
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

function toPlatformSecretProfileBinding(
  binding: Omit<
    PlatformSecretProfileBinding,
    "profileName" | "profileRevision"
  >,
  profile: PlatformSecretProfileRecord,
): PlatformSecretProfileBinding {
  return {
    ...binding,
    profileName: profile.name,
    profileRevision: profile.revision,
  };
}
