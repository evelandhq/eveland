import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { EvelandBuildInfo } from "@eveland/core/build-info";
import type { SystemConfigurationDiagnostics } from "@eveland/core/config-diagnostics";
import type {
  AgentEndpoints,
  CollectorHealth,
  DeploymentOverview,
  LogLine,
  ModelUsageEvent,
  Project,
  PublicSecret,
  Schedule,
  Session,
  SessionEvent,
  SessionNode,
  SourceFile,
  SourceRevision,
  VariantMetric,
} from "./api";
import type { CurrentMember, Invitation, Member } from "./client-api";

const apiBaseUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export const getProjects = () => apiGet<{ projects: Project[] }>("/projects").then((data) => data.projects);
export const getProject = (projectId: string) => apiGet<{ project: Project | null }>(`/projects/${projectId}`).then((data) => data.project);
export const getAgentEndpoints = (projectId: string) =>
  apiGetOptional<AgentEndpoints>(`/projects/${projectId}/endpoints`).then((data) => data ?? { stable: null, previews: [] });
export const getDeploymentOverview = (projectId: string) => apiGet<DeploymentOverview>(`/projects/${projectId}/deployments`);
export const getVariantMetrics = (projectId: string) => apiGet<{ variants: VariantMetric[] }>(`/projects/${projectId}/variant-metrics`).then((data) => data.variants);
export const getSecrets = (projectId: string) => apiGet<{ secrets: PublicSecret[] }>(`/projects/${projectId}/secrets`).then((data) => data.secrets);
export const getSchedules = (projectId: string) => apiGet<{ schedules: Schedule[] }>(`/projects/${projectId}/schedules`).then((data) => data.schedules);
export const getSessions = (projectId: string) => apiGet<{ sessions: Session[] }>(`/projects/${projectId}/sessions`).then((data) => data.sessions);
export const getSessionEvents = (sessionId: string) => apiGet<{ events: SessionEvent[] }>(`/sessions/${sessionId}/events`).then((data) => data.events);
export const getSessionUsage = (sessionId: string) => apiGet<{ usage: ModelUsageEvent[] }>(`/sessions/${sessionId}/usage`).then((data) => data.usage);
export const getSessionNodes = (sessionId: string) => apiGet<{ nodes: SessionNode[] }>(`/sessions/${sessionId}/nodes`).then((data) => data.nodes);
export const getCollectorHealth = () => apiGet<CollectorHealth>("/internal/collector/health");
export const getLogs = (projectId: string) => apiGet<{ logs: LogLine[] }>(`/projects/${projectId}/logs`).then((data) => data.logs);
export const getSourceRevision = (projectId: string) => apiGet<{ revision: SourceRevision | null }>(`/projects/${projectId}/source/revision`).then((data) => data.revision);
export const getSourceFiles = (projectId: string) => apiGet<{ files: SourceFile[] }>(`/projects/${projectId}/source/files`).then((data) => data.files);
export const getSourceFile = (projectId: string, filePath: string) => apiGet<{ file: SourceFile | null }>(`/projects/${projectId}/source/file?path=${encodeURIComponent(filePath)}`).then((data) => data.file);
export const getCurrentMember = () => apiGet<{ member: CurrentMember }>("/auth/session").then((data) => data.member);
export const getMembers = () => apiGet<{ members: Member[] }>("/members").then((data) => data.members);
export const getInvitations = () => apiGet<{ invitations: Invitation[] }>("/invitations").then((data) => data.invitations);
export const getApiBuildInfo = () => apiGet<{ ok: true } & EvelandBuildInfo>("/health");
export const getSystemConfigurationDiagnostics = () =>
  apiGet<SystemConfigurationDiagnostics>("/system/configuration");

// A deployed agent has no endpoints until its first release, so /endpoints 404s for an
// imported-but-undeployed project. Treat that as "no endpoints" instead of an error.
async function apiGetOptional<T>(path: string): Promise<T | null> {
  const cookieStore = await cookies();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    cache: "no-store",
    headers: { cookie: cookieStore.toString() },
  });
  if (response.status === 401) redirect("/login");
  if (response.status === 404) return null;
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `API request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function apiGet<T>(path: string): Promise<T> {
  const cookieStore = await cookies();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    cache: "no-store",
    headers: { cookie: cookieStore.toString() },
  });
  if (response.status === 401) redirect("/login");
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `API request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}
