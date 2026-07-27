import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { EvelandBuildInfo } from "@eveland/core/build-info";
import type { InstanceHealthReport } from "@eveland/core/instance-health";
import type { SystemConfigurationDiagnostics } from "@eveland/core/config-diagnostics";
import type {
  PublicGitCredential,
  SharedAgentEnvironment,
  UsageAnalytics,
  UsageRange,
} from "@eveland/core/contracts";
import type {
  IdentityProviderConnection,
  IdentityRealm,
  IdentityReturnTarget,
} from "@eveland/core/identity";
import type {
  AgentEndpoints,
  CollectorHealth,
  DeploymentOverview,
  EveVersionInfo,
  Job,
  LogLine,
  ModelUsageEvent,
  Project,
  PublicSecret,
  ProjectScheduleSummary,
  ScheduleRun,
  ScheduleRunDetail,
  Session,
  SessionEvent,
  SessionNode,
  SourceFile,
  SourceRevision,
  VariantMetric,
} from "./api";
import type { CurrentMember, Invitation, Member } from "./client-api";

const apiBaseUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type ProjectListItem = Project & { eveVersion: EveVersionInfo };

export const getProjects = () => apiGet<{ projects: ProjectListItem[] }>("/projects").then((data) => data.projects);
export const getProject = (projectId: string) => apiGet<{ project: Project | null }>(`/projects/${projectId}`).then((data) => data.project);
export const getProjectJobs = (projectId: string) => apiGet<{ jobs: Job[] }>(`/projects/${projectId}/jobs`).then((data) => data.jobs);
export const getAgentEndpoints = (projectId: string) =>
  apiGetOptional<AgentEndpoints>(`/projects/${projectId}/endpoints`).then((data) => data ?? { stable: null, previews: [] });
export const getEveVersion = (projectId: string) =>
  apiGet<{ eveVersion: EveVersionInfo }>(`/projects/${projectId}/eve-version`).then((data) => data.eveVersion);
export const getDeploymentOverview = (projectId: string) => apiGet<DeploymentOverview>(`/projects/${projectId}/deployments`);
export const getVariantMetrics = (projectId: string) => apiGet<{ variants: VariantMetric[] }>(`/projects/${projectId}/variant-metrics`).then((data) => data.variants);
export const getSecrets = (projectId: string) => apiGet<{ secrets: PublicSecret[] }>(`/projects/${projectId}/secrets`).then((data) => data.secrets);
export const getSchedules = (projectId: string) =>
  apiGet<{ schedules: ProjectScheduleSummary[] }>(`/projects/${projectId}/schedules`).then((data) => data.schedules);
export const getScheduleRuns = (projectId: string, filters: Record<string, string | undefined> = {}) =>
  apiGet<{ runs: ScheduleRun[]; nextCursor: string | null }>(`/projects/${projectId}/schedule-runs${queryString(filters)}`);
export const getScheduleRun = (scheduleRunId: string) =>
  apiGet<{ run: ScheduleRunDetail }>(`/schedule-runs/${scheduleRunId}`).then((data) => data.run);
export const getSessions = (projectId: string, filters: Record<string, string | undefined> = {}) =>
  apiGet<{ sessions: Session[]; nextCursor: string | null }>(`/projects/${projectId}/sessions${queryString(filters)}`).then((data) => data.sessions);
export const getSessionsPage = (projectId: string, filters: Record<string, string | undefined> = {}) =>
  apiGet<{ sessions: Session[]; nextCursor: string | null }>(`/projects/${projectId}/sessions${queryString(filters)}`);
export const getUsageAnalytics = (filters: { range: UsageRange; modelId?: string }) =>
  apiGet<{ usage: UsageAnalytics }>(`/usage${queryString(filters)}`).then((data) => data.usage);
export const getProjectUsageAnalytics = (
  projectId: string,
  filters: { range: UsageRange; modelId?: string },
) =>
  apiGet<{ usage: UsageAnalytics }>(`/projects/${projectId}/usage${queryString(filters)}`).then((data) => data.usage);
export const getSession = (sessionId: string) => apiGet<{ session: Session }>(`/sessions/${sessionId}`).then((data) => data.session);
export const getSessionEvents = (sessionId: string) => apiGet<{ events: SessionEvent[] }>(`/sessions/${sessionId}/events`).then((data) => data.events);
export const getSessionUsage = (sessionId: string) => apiGet<{ usage: ModelUsageEvent[] }>(`/sessions/${sessionId}/usage`).then((data) => data.usage);
export const getSessionNodes = (sessionId: string) => apiGet<{ nodes: SessionNode[] }>(`/sessions/${sessionId}/nodes`).then((data) => data.nodes);
export const getCollectorHealth = () => apiGet<CollectorHealth>("/internal/collector/health");
export const getLogs = (projectId: string) => apiGet<{ logs: LogLine[] }>(`/projects/${projectId}/logs`).then((data) => data.logs);
export const getSourceRevision = (projectId: string) => apiGet<{ revision: SourceRevision | null }>(`/projects/${projectId}/source/revision`).then((data) => data.revision);
export const getSourceFiles = (projectId: string) => apiGet<{ files: SourceFile[] }>(`/projects/${projectId}/source/files`).then((data) => data.files);
export const getSourceFile = (projectId: string, filePath: string) => apiGet<{ file: SourceFile | null }>(`/projects/${projectId}/source/file?path=${encodeURIComponent(filePath)}`).then((data) => data.file);
export const getCurrentMember = () => apiGet<{ member: CurrentMember }>("/auth/session").then((data) => data.member);
export const getCurrentMemberOrNull = () =>
  apiGet<{ member: CurrentMember }>("/auth/session", { unauthorized: "return-null" })
    .then((data) => data?.member ?? null);
export const getMembers = () => apiGet<{ members: Member[] }>("/members").then((data) => data.members);
export const getInvitations = () => apiGet<{ invitations: Invitation[] }>("/invitations").then((data) => data.invitations);
export const getApiBuildInfo = () => apiGet<{ ok: true } & EvelandBuildInfo>("/health");
export const getSystemConfigurationDiagnostics = () =>
  apiGet<SystemConfigurationDiagnostics>("/system/configuration");
export const getInstanceHealth = (hours = 24) =>
  apiGet<InstanceHealthReport>(`/system/health?hours=${encodeURIComponent(hours)}`);
export const getGitCredentials = () =>
  apiGet<{ credentials: PublicGitCredential[] }>("/git-credentials").then((data) => data.credentials);
export const getSharedAgentEnvironment = () =>
  apiGet<{ environment: SharedAgentEnvironment | null }>("/platform/shared-agent-environment")
    .then((data) => data.environment);
export type PublicIdentityProvider = Omit<
  IdentityProviderConnection,
  "clientSecretEncrypted"
> & { clientSecretConfigured: boolean };
export type IdentityRealmGrant = {
  identityRealmId: string;
  projectId: string;
  createdAt: string;
};
export const getIdentityProviders = () =>
  apiGet<{ providers: PublicIdentityProvider[] }>("/system/identity/providers")
    .then((data) => data.providers);
export const getIdentityRealms = () =>
  apiGet<{ realms: IdentityRealm[] }>("/system/identity/realms")
    .then((data) => data.realms);
export const getIdentityReturnTargets = () =>
  apiGet<{ targets: IdentityReturnTarget[] }>("/system/identity/return-targets")
    .then((data) => data.targets);
export const getIdentityRealmGrants = (realmId: string) =>
  apiGet<{ grants: IdentityRealmGrant[] }>(
    `/system/identity/realms/${encodeURIComponent(realmId)}/grants`,
  ).then((data) => data.grants);

function queryString(filters: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  const value = query.toString();
  return value ? `?${value}` : "";
}

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

type UnauthorizedBehavior = "redirect" | "return-null";

async function apiGet<T>(path: string, options?: { unauthorized?: "redirect" }): Promise<T>;
async function apiGet<T>(path: string, options: { unauthorized: "return-null" }): Promise<T | null>;
async function apiGet<T>(
  path: string,
  options: { unauthorized?: UnauthorizedBehavior } = {},
): Promise<T | null> {
  const cookieStore = await cookies();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    cache: "no-store",
    headers: { cookie: cookieStore.toString() },
  });
  if (response.status === 401) {
    if (options.unauthorized === "return-null") return null;
    redirect("/login");
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `API request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}
