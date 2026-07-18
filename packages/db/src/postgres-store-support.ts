import { and, eq } from "drizzle-orm";
import type {
  AgentRoute,
  Job,
  JobType,
  ModelUsageEvent,
  PlatformSecretProfile,
  PlatformSecretProfileBinding,
  PlatformSecretProfileRecord,
} from "@eveland/core/contracts";
import type { Database } from "./client.js";
import { agentAuthCredentials, modelUsageEvents, platformSecretProfileBindings, platformSecretProfiles } from "./schema.js";
import type { AgentAuthCredentialKey, Store } from "./store-domains.js";

export type PostgresStoreContext = {
  database: Database;
  db: Database["db"];
  ensureDeploymentRoutes(projectId: string, deploymentId: string, baseDomain: string): Promise<AgentRoute[]>;
  ensureDefaultOwner(): Promise<void>;
  createJob(projectId: string, type: JobType, payload: Record<string, unknown>): Promise<Job>;
};

export type PostgresDomain = Partial<Store> & ThisType<Store>;

export function agentAuthCredentialWhere(key: AgentAuthCredentialKey) {
  return and(
    eq(agentAuthCredentials.agentConnectionId, key.agentConnectionId),
    eq(agentAuthCredentials.securityRevision, key.securityRevision),
    eq(agentAuthCredentials.authMethod, key.authMethod),
    eq(agentAuthCredentials.credentialScope, key.credentialScope),
    eq(agentAuthCredentials.scopeSubject, key.scopeSubject),
    eq(agentAuthCredentials.credentialKey, key.credentialKey),
  );
}

export function normalizePlatformSecretProfileEntries(value: unknown): PlatformSecretProfileRecord["entries"] {
  if (!Array.isArray(value)) throw new Error("Invalid Platform Secret Profile entries.");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid Platform Secret Profile entry.");
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.key !== "string"
      || (candidate.kind !== "variable" && candidate.kind !== "secret")
      || typeof candidate.encryptedValue !== "string"
    ) {
      throw new Error("Invalid Platform Secret Profile entry.");
    }
    const kind = candidate.kind as "variable" | "secret";
    return { key: candidate.key, kind, encryptedValue: candidate.encryptedValue };
  }).sort((left, right) => left.key.localeCompare(right.key));
}

export function platformSecretProfileRowToRecord(
  row: typeof platformSecretProfiles.$inferSelect,
): PlatformSecretProfileRecord {
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    entries: normalizePlatformSecretProfileEntries(row.entries),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function platformSecretProfileRowToPublic(
  row: typeof platformSecretProfiles.$inferSelect,
): PlatformSecretProfile {
  const record = platformSecretProfileRowToRecord(row);
  return {
    ...record,
    entries: record.entries.map(({ key, kind }) => ({ key, kind, configured: true })),
  };
}

export function platformSecretProfileBindingRowToPublic(
  row: typeof platformSecretProfileBindings.$inferSelect,
  profile: typeof platformSecretProfiles.$inferSelect,
): PlatformSecretProfileBinding {
  if (row.consumer !== "agent-runtime" && row.consumer !== "agent-connection") {
    throw new Error(`Unsupported Platform Secret Profile consumer: ${row.consumer}.`);
  }
  return {
    id: row.id,
    profileId: row.profileId,
    profileName: profile.name,
    profileRevision: profile.revision,
    projectId: row.projectId,
    deploymentId: row.deploymentId,
    consumer: row.consumer,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function modelUsageRowToModelUsageEvent(
  row: typeof modelUsageEvents.$inferSelect,
): ModelUsageEvent {
  return {
    id: row.id,
    sessionId: row.sessionId,
    eveSessionId: row.eveSessionId,
    agentId: row.agentId,
    agentName: row.agentName,
    turnId: row.turnId,
    stepIndex: row.stepIndex,
    finishReason: row.finishReason,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    costUsd: row.costUsd,
    usageReported: row.usageReported,
    createdAt: row.createdAt.toISOString(),
  };
}

export function normalizeBaseDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!normalized || !/^[a-z0-9.-]+$/.test(normalized)) throw new Error(`Invalid Agent base domain: ${value}`);
  return normalized;
}

export function isUniqueConstraint(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
  if (record.code === "23505" && (record.constraint_name === constraint || record.constraint === constraint)) return true;
  return isUniqueConstraint(record.cause, constraint);
}
