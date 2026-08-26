import type { Job, Project, PublicSecret, ScheduleRun } from "./api";
import type {
  AgentConnection,
  AuthPrincipal,
  PublicGitCredential,
  SharedAgentEnvironment,
  TeamInvitation,
  TeamMember,
} from "@evelandhq/core/contracts";
import type {
  AgentAuthMethodDescriptor,
  AgentAuthSecretReference,
} from "@evelandhq/core/agent-auth";
import type { IdentityRealm, IdentityReturnTarget } from "@evelandhq/core/identity";
import type { PublicIdentityProvider } from "./api";
import type {
  AgentCapturePolicy,
  ExternalDestinationConfigPatch,
  PublicObservabilityPolicy,
} from "@evelandhq/core/observability";

import { apiRequest, type ApiRequestOptions } from "./api-transport";

// Aliases of the shared contracts, not copies: the api-contract typecheck
// pins them, so a divergence fails to compile instead of drifting silently.
export type Member = TeamMember;
export type CurrentMember = AuthPrincipal;
export type Invitation = TeamInvitation;

// The decrypted view the identity routes return in place of the sealed record.
export type AgentConnectionView = Omit<AgentConnection, "configEncrypted"> & {
  config: Record<string, unknown>;
};

export type AgentAuthStatus =
  | { state: "not_required" }
  | { state: "credential_available" }
  | { state: "interaction_required"; interaction?: { type: "redirect"; url: string } }
  | { state: "misconfigured"; message: string };

export type AgentAuthSecretReferenceOption = AgentAuthSecretReference & {
  label: string;
  revision?: number;
};

export async function getAgentAuthMethods(): Promise<AgentAuthMethodDescriptor[]> {
  return clientRequest<{ methods: AgentAuthMethodDescriptor[] }>("/agent-auth/methods", {
    method: "GET",
  }).then((data) => data.methods);
}

export async function getProjectAgentConnection(projectId: string): Promise<{
  connection: AgentConnectionView;
  status: AgentAuthStatus;
}> {
  return clientRequest(`/projects/${projectId}/playground/connection`, { method: "GET" });
}

export async function getAgentAuthSecretReferences(
  projectId: string,
): Promise<AgentAuthSecretReferenceOption[]> {
  return clientRequest<{ references: AgentAuthSecretReferenceOption[] }>(
    `/projects/${projectId}/agent-auth/secret-references`,
    { method: "GET" },
  ).then((data) => data.references);
}

export async function updateAgentConnection(
  connectionId: string,
  input: { expectedSecurityRevision: number; method: string; config: Record<string, unknown> },
): Promise<{ connection: AgentConnectionView; status: AgentAuthStatus }> {
  return clientRequest(`/agent-connections/${connectionId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function completeAgentAuthCallback(search: string): Promise<{ returnPath: string }> {
  return clientRequest("/agent-auth/callback/oidc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ search }),
  });
}

export async function signIn(email: string, password: string): Promise<CurrentMember> {
  await clientRequest("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    // A rejected credential is this endpoint's answer, not an expired session.
    unauthorized: "surface",
  });
  return clientRequest<{ member: CurrentMember }>("/auth/session", { method: "GET" }).then(
    (data) => data.member,
  );
}

export async function signOut(): Promise<void> {
  await clientRequest("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export async function getCurrentMember(): Promise<CurrentMember> {
  return clientRequest<{ member: CurrentMember }>("/auth/session", { method: "GET" }).then(
    (data) => data.member,
  );
}

export async function listProjects(): Promise<Project[]> {
  return clientRequest<{ projects: Project[] }>("/projects", { method: "GET" }).then(
    (data) => data.projects,
  );
}

export async function updateProfile(input: {
  name: string;
  image: string | null;
  displayTimezone: string;
}): Promise<CurrentMember> {
  const data = await clientRequest<{ member: CurrentMember }>("/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return data.member;
}

export async function updateProjectMetadata(
  projectId: string,
  input: { name: string; description: string },
): Promise<Project> {
  return clientRequest<{ project: Project }>(`/projects/${projectId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }).then((data) => data.project);
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await clientRequest("/profile/password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function getGitCredentials(): Promise<PublicGitCredential[]> {
  return clientRequest<{ credentials: PublicGitCredential[] }>("/git-credentials", {
    method: "GET",
  }).then((data) => data.credentials);
}

export async function createGitCredential(input: {
  host: string;
  gitlabPat: string;
}): Promise<PublicGitCredential> {
  return clientRequest<{ credential: PublicGitCredential }>("/git-credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }).then((data) => data.credential);
}

export async function deleteGitCredential(credentialId: string): Promise<void> {
  await clientRequest(`/git-credentials/${credentialId}`, { method: "DELETE" });
}

export async function saveSharedAgentEnvironment(
  entries: Array<{ key: string; kind: "variable" | "secret"; value?: string }>,
): Promise<{ environment: SharedAgentEnvironment; jobs: Job[] }> {
  return clientRequest("/platform/shared-agent-environment", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entries }),
  });
}

export async function saveObservabilitySettings(input: {
  expectedRevision: number;
  agentCapture: AgentCapturePolicy;
}): Promise<PublicObservabilityPolicy> {
  return clientRequest("/system/observability", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function createObservabilityDestination(input: {
  expectedRevision: number;
  config: ExternalDestinationConfigPatch;
}): Promise<PublicObservabilityPolicy> {
  return clientRequest("/system/observability/destinations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateObservabilityDestination(input: {
  destinationId: string;
  expectedRevision: number;
  config: ExternalDestinationConfigPatch;
}): Promise<PublicObservabilityPolicy> {
  return clientRequest(`/system/observability/destinations/${input.destinationId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: input.expectedRevision,
      config: input.config,
    }),
  });
}

export async function toggleObservabilityDestination(input: {
  destinationId: string;
  expectedRevision: number;
  enabled: boolean;
}): Promise<PublicObservabilityPolicy> {
  return clientRequest(`/system/observability/destinations/${input.destinationId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: input.expectedRevision,
      enabled: input.enabled,
    }),
  });
}

export async function deleteObservabilityDestination(input: {
  destinationId: string;
  expectedRevision: number;
}): Promise<PublicObservabilityPolicy> {
  return clientRequest(`/system/observability/destinations/${input.destinationId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: input.expectedRevision,
    }),
  });
}

export async function createProjectEnvironmentEntry(
  projectId: string,
  input: { key: string; kind: "variable" | "secret"; value: string },
): Promise<{ secret: PublicSecret; jobs: Job[] }> {
  return clientRequest(`/projects/${projectId}/secrets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function createProjectEnvironmentEntries(
  projectId: string,
  entries: Array<{ key: string; kind: "variable" | "secret"; value: string }>,
): Promise<{ secrets: PublicSecret[]; jobs: Job[] }> {
  return clientRequest(`/projects/${projectId}/secrets/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entries }),
  });
}

export async function updateProjectEnvironmentEntry(
  projectId: string,
  secretId: string,
  input: { key: string; kind: "variable" | "secret"; value?: string },
): Promise<{ secret: PublicSecret; jobs: Job[] }> {
  return clientRequest(`/projects/${projectId}/secrets/${secretId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteProjectEnvironmentEntry(
  projectId: string,
  secretId: string,
): Promise<{ deleted: boolean; jobs: Job[] }> {
  return clientRequest(`/projects/${projectId}/secrets/${secretId}`, { method: "DELETE" });
}

export async function inviteMember(
  email: string,
): Promise<{ invitation: Invitation; inviteUrl: string }> {
  return clientRequest("/invitations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

export type InvitationPreview = {
  email: string;
  /** True when the invited email belongs to an account that already exists
   * (a removed member being re-invited); the accept page then renders a
   * sign-in flow instead of profile creation. */
  existingAccount: boolean;
};

// POST keeps the single-use token out of URLs and access logs.
export async function previewInvitation(token: string): Promise<InvitationPreview> {
  return clientRequest("/invitations/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

export async function acceptInvitation(input: {
  token: string;
  name?: string;
  password: string;
}): Promise<CurrentMember> {
  const data = await clientRequest<{ member: CurrentMember }>("/invitations/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    // Same class as sign-in: the invitation flow answers 401 for a rejected
    // credential while the user is still creating their account.
    unauthorized: "surface",
  });
  return data.member;
}

export async function resendInvitation(
  invitationId: string,
): Promise<{ invitation: Invitation; inviteUrl: string }> {
  return clientRequest(`/invitations/${invitationId}/resend`, { method: "POST" });
}

export async function revokeInvitation(invitationId: string): Promise<void> {
  await clientRequest(`/invitations/${invitationId}`, { method: "DELETE" });
}

export async function updateMemberRole(userId: string, role: Member["role"]): Promise<Member> {
  const data = await clientRequest<{ member: Member }>(`/members/${userId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
  return data.member;
}

export async function removeMember(userId: string): Promise<void> {
  await clientRequest(`/members/${userId}`, { method: "DELETE" });
}

export async function createInternalIdentityProvider(input: {
  displayName: string;
  internalRealmKey: string;
  enabled: boolean;
}): Promise<PublicIdentityProvider> {
  return clientRequest<{ provider: PublicIdentityProvider }>("/system/identity/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "internal", ...input }),
  }).then((data) => data.provider);
}

export async function createOpenIdentityProvider(input: {
  displayName: string;
  enabled: boolean;
}): Promise<PublicIdentityProvider> {
  return clientRequest<{ provider: PublicIdentityProvider }>("/system/identity/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "open", ...input }),
  }).then((data) => data.provider);
}

export type OidcIdentityProviderConfigInput = {
  displayName: string;
  issuer: string;
  clientId: string;
  /** Omitted keeps the stored secret; empty string is never sent. */
  clientSecret?: string;
  scopes: string[];
  tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post" | "none";
  externalRealmResolution: "connection" | "id_token_claim" | "userinfo_claim";
  externalRealmClaim?: string;
};

export async function createOidcIdentityProvider(
  input: OidcIdentityProviderConfigInput & { enabled: boolean },
): Promise<PublicIdentityProvider> {
  return clientRequest<{ provider: PublicIdentityProvider }>("/system/identity/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "oidc", ...input }),
  }).then((data) => data.provider);
}

export async function updateOidcIdentityProvider(
  input: OidcIdentityProviderConfigInput & {
    id: string;
    expectedSecurityRevision: number;
    enabled: boolean;
  },
): Promise<PublicIdentityProvider> {
  const { id, ...body } = input;
  return clientRequest<{ provider: PublicIdentityProvider }>(
    `/system/identity/providers/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  ).then((data) => data.provider);
}

/**
 * Enables or disables a Provider of any type. It deliberately sends no
 * type-specific field: the Provider is only being switched on or off, and
 * echoing back an Internal Realm key would risk tripping the immutability
 * guard on a value the caller never meant to change.
 */
export async function setIdentityProviderEnabled(input: {
  id: string;
  expectedSecurityRevision: number;
  displayName: string;
  enabled: boolean;
}): Promise<PublicIdentityProvider> {
  return clientRequest<{ provider: PublicIdentityProvider }>(
    `/system/identity/providers/${encodeURIComponent(input.id)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  ).then((data) => data.provider);
}

export async function preflightIdentityProvider(providerId: string): Promise<{
  ok: boolean;
  checks?: Record<string, boolean>;
  advisories?: Record<string, boolean>;
  error?: string;
}> {
  return clientRequest(`/system/identity/providers/${encodeURIComponent(providerId)}/preflight`, {
    method: "POST",
  });
}

export async function createOidcIdentityRealm(input: {
  providerConnectionId: string;
  externalRealmId: string;
  externalRealmKind: Exclude<IdentityRealm["externalRealmKind"], "internal">;
  displayName: string;
  enabled: boolean;
}): Promise<IdentityRealm> {
  return clientRequest<{ realm: IdentityRealm }>("/system/identity/realms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }).then((data) => data.realm);
}

export async function createInternalIdentityRealm(input: {
  providerConnectionId: string;
  externalRealmId: string;
  displayName: string;
  enabled: boolean;
}): Promise<IdentityRealm> {
  return clientRequest<{ realm: IdentityRealm }>("/system/identity/realms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, externalRealmKind: "internal" }),
  }).then((data) => data.realm);
}

export async function updateIdentityRealm(input: {
  id: string;
  displayName: string;
  enabled: boolean;
}): Promise<IdentityRealm> {
  return clientRequest<{ realm: IdentityRealm }>(
    `/system/identity/realms/${encodeURIComponent(input.id)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  ).then((data) => data.realm);
}

export async function upsertIdentityReturnTarget(input: {
  key: string;
  origin: string;
  enabled: boolean;
}): Promise<IdentityReturnTarget> {
  return clientRequest<{ target: IdentityReturnTarget }>(
    `/system/identity/return-targets/${encodeURIComponent(input.key)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: input.origin, enabled: input.enabled }),
    },
  ).then((data) => data.target);
}

export function resetPlaygroundOnPageLeave(input: {
  projectId: string;
  sessionState:
    | {
        sessionId?: string;
      }
    | null
    | undefined;
  fetcher?: typeof fetch;
}): boolean {
  const sessionId = input.sessionState?.sessionId;
  if (!sessionId) return false;
  const fetcher = input.fetcher ?? fetch;
  // ID-addressed reset; every supported Eve line speaks it.
  void fetcher(
    `/api/eveland/projects/${encodeURIComponent(input.projectId)}/playground/eve/v1/session/${encodeURIComponent(sessionId)}/reset`,
    {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
    },
  ).catch(() => undefined);
  return true;
}

export async function enqueueBuildDeploy(
  projectId: string,
  options: { promote?: boolean } = {},
): Promise<Job> {
  const data = await clientRequest<{ job: Job }>(`/projects/${projectId}/build-deploy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ promote: options.promote ?? false }),
  });
  return data.job;
}

export async function deleteProject(projectId: string): Promise<Job> {
  const data = await clientRequest<{ job: Job }>(`/projects/${projectId}`, { method: "DELETE" });
  return data.job;
}

export async function promoteDeployment(projectId: string, deploymentId: string): Promise<void> {
  await clientRequest(`/projects/${projectId}/deployments/${deploymentId}/promote`, {
    method: "POST",
  });
}

export async function drainDeployment(projectId: string, deploymentId: string): Promise<void> {
  await clientRequest(`/projects/${projectId}/deployments/${deploymentId}/drain`, {
    method: "POST",
  });
}

export async function archiveDeployment(projectId: string, deploymentId: string): Promise<void> {
  await clientRequest(`/projects/${projectId}/deployments/${deploymentId}/archive`, {
    method: "POST",
  });
}

export async function updateRouteTargets(
  projectId: string,
  routeId: string,
  targets: Array<{ deploymentId: string; weight: number; variantName: string | null }>,
): Promise<void> {
  await clientRequest(`/projects/${projectId}/routes/${routeId}/targets`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targets }),
  });
}

export async function syncSource(
  projectId: string,
  options: { deploy?: boolean; promote?: boolean } = {},
): Promise<Job> {
  const data = await clientRequest<{ job: Job }>(`/projects/${projectId}/sync-source`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deploy: options.deploy ?? false,
      promote: options.promote ?? false,
    }),
  });
  return data.job;
}

/** Marks failed runs as reviewed; without ids, every unreviewed one. */
export async function acknowledgeScheduleRuns(
  projectId: string,
  runIds?: string[],
): Promise<number> {
  const data = await clientRequest<{ acknowledged: number }>(
    `/projects/${projectId}/schedule-runs/acknowledge`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(runIds ? { runIds } : {}),
    },
  );
  return data.acknowledged;
}

export async function getScheduleAttention(projectId: string): Promise<number> {
  const data = await clientRequest<{ unacknowledgedFailedRuns: number }>(
    `/projects/${projectId}/schedule-attention`,
    { method: "GET" },
  );
  return data.unacknowledgedFailedRuns;
}

export async function runSchedule(projectId: string, scheduleId: string): Promise<ScheduleRun> {
  const data = await clientRequest<{ run: ScheduleRun }>(
    `/projects/${projectId}/schedules/${scheduleId}/runs`,
    {
      method: "POST",
    },
  );
  return data.run;
}

// One browser transport for the whole control panel: shared error decoding
// (including field-level validation issues) and the 401 -> login policy live
// in lib/api-transport.
async function clientRequest<T = unknown>(path: string, init: ApiRequestOptions): Promise<T> {
  return apiRequest<T>(path, init);
}
