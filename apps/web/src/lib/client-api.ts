import type { FileUIPart, UserContent } from "ai";
import type { Job, PublicSecret, ScheduleRun } from "./api";
import type {
  PublicGitCredential,
  SharedAgentEnvironment,
} from "@eveland/core/contracts";
import type { AgentAuthMethodDescriptor, AgentAuthSecretReference } from "@eveland/core/agent-auth";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type Member = {
  userId: string;
  email: string;
  name: string | null;
  role: "admin" | "member";
  joinedAt: string;
};

export type CurrentMember = Member & {
  image: string | null;
};

export type Invitation = {
  id: string;
  email: string;
  role: "admin" | "member";
  status: "pending" | "accepted" | "rejected" | "canceled";
  expiresAt: string;
  invitedByUserId: string;
  createdAt: string;
};

export type AgentConnectionView = {
  id: string;
  target: { kind: "managed-project"; projectId: string };
  method: string;
  securityRevision: number;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
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
  return clientRequest<{ methods: AgentAuthMethodDescriptor[] }>("/agent-auth/methods", { method: "GET" })
    .then((data) => data.methods);
}

export async function getProjectAgentConnection(projectId: string): Promise<{
  connection: AgentConnectionView;
  status: AgentAuthStatus;
}> {
  return clientRequest(`/projects/${projectId}/playground/connection`, { method: "GET" });
}

export async function getAgentAuthSecretReferences(projectId: string): Promise<AgentAuthSecretReferenceOption[]> {
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
  });
  return clientRequest<{ member: CurrentMember }>("/auth/session", { method: "GET" }).then((data) => data.member);
}

export async function signOut(): Promise<void> {
  await clientRequest("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export async function getCurrentMember(): Promise<CurrentMember> {
  return clientRequest<{ member: CurrentMember }>("/auth/session", { method: "GET" }).then((data) => data.member);
}

export async function verifyDeviceCode(
  userCode: string,
): Promise<{ user_code: string; status: "pending" | "approved" | "denied" }> {
  return clientRequest(
    `/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
    { method: "GET" },
  );
}

export async function approveDeviceCode(userCode: string): Promise<void> {
  await clientRequest("/api/auth/device/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userCode }),
  });
}

export async function denyDeviceCode(userCode: string): Promise<void> {
  await clientRequest("/api/auth/device/deny", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userCode }),
  });
}

export async function updateProfile(input: { name: string; image: string | null }): Promise<CurrentMember> {
  const data = await clientRequest<{ member: CurrentMember }>("/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return data.member;
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await clientRequest("/profile/password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function getGitCredentials(): Promise<PublicGitCredential[]> {
  return clientRequest<{ credentials: PublicGitCredential[] }>("/git-credentials", { method: "GET" })
    .then((data) => data.credentials);
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

export async function inviteMember(email: string): Promise<{ invitation: Invitation; inviteUrl: string }> {
  return clientRequest("/invitations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

export async function acceptInvitation(input: { token: string; name: string; password: string }): Promise<CurrentMember> {
  const data = await clientRequest<{ member: CurrentMember }>("/invitations/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return data.member;
}

export async function resendInvitation(invitationId: string): Promise<{ invitation: Invitation; inviteUrl: string }> {
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

export function createPlaygroundMessage(text: string, files: readonly FileUIPart[]): string | UserContent {
  const trimmed = text.trim();
  if (files.length === 0) {
    return trimmed;
  }

  return [
    ...(trimmed.length > 0 ? [{ type: "text" as const, text: trimmed }] : []),
    ...files.map((file) => ({
      type: "file" as const,
      data: file.url,
      filename: file.filename,
      mediaType: file.mediaType,
    })),
  ];
}

export async function cancelPlaygroundTurn(session: { cancel(): Promise<unknown> }): Promise<void> {
  await session.cancel();
}

export async function enqueueBuildDeploy(projectId: string): Promise<Job> {
  const data = await clientRequest<{ job: Job }>(`/projects/${projectId}/build-deploy`, { method: "POST" });
  return data.job;
}

export async function deleteProject(projectId: string): Promise<Job> {
  const data = await clientRequest<{ job: Job }>(`/projects/${projectId}`, { method: "DELETE" });
  return data.job;
}

export async function promoteDeployment(projectId: string, deploymentId: string): Promise<void> {
  await clientRequest(`/projects/${projectId}/deployments/${deploymentId}/promote`, { method: "POST" });
}

export async function drainDeployment(projectId: string, deploymentId: string): Promise<void> {
  await clientRequest(`/projects/${projectId}/deployments/${deploymentId}/drain`, { method: "POST" });
}

export async function archiveDeployment(projectId: string, deploymentId: string): Promise<void> {
  await clientRequest(`/projects/${projectId}/deployments/${deploymentId}/archive`, { method: "POST" });
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

export async function runSchedule(projectId: string, scheduleId: string): Promise<ScheduleRun> {
  const data = await clientRequest<{ run: ScheduleRun }>(`/projects/${projectId}/schedules/${scheduleId}/runs`, {
    method: "POST",
  });
  return data.run;
}

async function clientRequest<T = unknown>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, credentials: "include" });
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; detail?: string; message?: string };
  if (!response.ok) throw new Error(data.detail ?? data.error ?? data.message ?? `Request failed with ${response.status}`);
  return data;
}
