import type { Job, PlaygroundResult } from "./api";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type Member = {
  userId: string;
  email: string;
  name: string | null;
  role: "admin" | "member";
  joinedAt: string;
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

export async function signIn(email: string, password: string): Promise<Member> {
  await clientRequest("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return clientRequest<{ member: Member }>("/auth/session", { method: "GET" }).then((data) => data.member);
}

export async function signOut(): Promise<void> {
  await clientRequest("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export async function inviteMember(email: string): Promise<{ invitation: Invitation; inviteUrl: string }> {
  return clientRequest("/invitations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

export async function acceptInvitation(input: { token: string; name: string; password: string }): Promise<Member> {
  const data = await clientRequest<{ member: Member }>("/invitations/accept", {
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

export async function runPlaygroundMessage(projectId: string, message: string): Promise<PlaygroundResult> {
  return clientRequest(`/projects/${projectId}/playground`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

export async function enqueueBuildDeploy(projectId: string): Promise<Job> {
  const data = await clientRequest<{ job: Job }>(`/projects/${projectId}/build-deploy`, { method: "POST" });
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

export async function syncSource(projectId: string, options: { deploy?: boolean } = {}): Promise<Job> {
  const data = await clientRequest<{ job: Job }>(`/projects/${projectId}/sync-source`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deploy: options.deploy ?? false }),
  });
  return data.job;
}

async function clientRequest<T = unknown>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, credentials: "include" });
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; detail?: string; message?: string };
  if (!response.ok) throw new Error(data.detail ?? data.error ?? data.message ?? `Request failed with ${response.status}`);
  return data;
}
