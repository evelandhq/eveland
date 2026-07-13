export type Project = {
  id: string;
  routingKey: string;
  name: string;
  importKind: "git" | "zip";
  gitUrl: string | null;
  status: string;
  deploymentStatus: string;
  sourceRevisionId: string | null;
  releaseId: string | null;
  deploymentId: string | null;
  latestSessionStatus: string | null;
  nextScheduleAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicSecret = {
  id: string;
  projectId: string;
  key: string;
  createdAt: string;
  updatedAt: string;
};

export type Schedule = {
  id: string;
  projectId: string;
  name: string;
  kind: "markdown" | "typescript";
  cron: string | null;
  timezone: string | null;
  enabled: boolean;
  executable: boolean;
  sourcePath: string;
  nextRunAt: string | null;
};

export type Session = {
  id: string;
  projectId: string;
  deploymentId: string | null;
  eveSessionId: string | null;
  continuationToken: string | null;
  rootNodeId: string | null;
  routeId: string | null;
  experimentId: string | null;
  variantName: string | null;
  trigger: string;
  scheduleId: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  usage: SessionTokenUsage;
};

export type AgentEndpoints = {
  stable: string | null;
  previews: string[];
};

export type Deployment = {
  id: string;
  deploymentKey: string;
  projectId: string;
  releaseId: string;
  hostPort: number;
  status: "running" | "draining" | "stopped" | "archived" | "failed";
  runtimeKind: "docker" | "systemd";
  createdAt: string;
};

export type AgentRoute = {
  id: string;
  hostname: string;
  kind: "project" | "deployment" | "alias";
  policyRevision: number;
  targets: Array<{ deploymentId: string; weight: number; variantName: string | null }>;
};

export type DeploymentOverview = {
  deployments: Deployment[];
  routes: AgentRoute[];
  retention: Array<{ deployment: Deployment; protected: boolean; reasons: string[] }>;
};

export type VariantMetric = {
  deploymentId: string | null;
  experimentId: string | null;
  variantName: string;
  sessions: number;
  success: number;
  failure: number;
  averageLatencyMs: number;
  tokens: number;
  costUsd: number;
};

export type SessionTokenUsage = {
  status: "none" | "reported" | "partial" | "missing";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  reportedSteps: number;
  missingSteps: number;
};

export type SessionEvent = {
  id: string;
  sessionId: string;
  index: number;
  type: string;
  payload: unknown;
  sessionNodeId: string | null;
  observerEventId: string | null;
  eventFingerprint: string | null;
  observedDeploymentId: string | null;
  sourceSequence: number | null;
  eventAt: string;
  createdAt: string;
};

export type SessionNode = {
  id: string;
  rootSessionId: string;
  projectId: string;
  eveSessionId: string;
  parentNodeId: string | null;
  parentEveSessionId: string | null;
  startedDeploymentId: string;
  lastObservedDeploymentId: string;
  agentId: string | null;
  agentName: string | null;
  nodeId: string | null;
  channelKind: string | null;
  modelId: string | null;
  eveVersion: string | null;
  remoteUrl: string | null;
  resolutionStatus: "observed" | "unresolved";
  status: string;
};

export type CollectorHealth = {
  status: "healthy" | "delayed" | "degraded";
  lastProcessedAt: string | null;
  backlogEvents: number;
  backlogBytes: number;
  oldestEventAge: number;
  quarantinedEvents: number;
  lastError: string | null;
};

export type ModelUsageEvent = {
  id: string;
  sessionId: string;
  eveSessionId: string;
  agentId: string | null;
  agentName: string | null;
  turnId: string;
  stepIndex: number;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  usageReported: boolean;
  createdAt: string;
};

export type PlaygroundResult = {
  session: Session | null;
  events: SessionEvent[];
};

export type Job = {
  id: string;
  projectId: string;
  type: "import_source" | "build_deploy" | "restart_deployment" | "trigger_schedule" | "archive_deployment" | "delete_project";
  status: "queued" | "running" | "completed" | "failed";
  payload: Record<string, unknown>;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LogLine = {
  id: string;
  projectId: string;
  deploymentId: string | null;
  type: "build" | "deploy" | "runtime";
  line: string;
  createdAt: string;
};

export type SourceRevision = {
  id: string;
  projectId: string;
  kind: "git" | "zip";
  commitSha: string | null;
  sourcePath: string;
  summary: Record<string, unknown>;
  envVars: string[];
  createdAt: string;
};

export type SourceFile = {
  id: string;
  revisionId: string;
  path: string;
  content: string;
  size: number;
};

const apiBaseUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function getProjects(): Promise<Project[]> {
  const data = await apiGet<{ projects: Project[] }>("/projects", { projects: [] });
  return data.projects;
}

export async function getProject(projectId: string): Promise<Project | null> {
  const data = await apiGet<{ project: Project | null }>(`/projects/${projectId}`, { project: null });
  return data.project;
}

export async function getAgentEndpoints(projectId: string): Promise<AgentEndpoints> {
  return apiGet<AgentEndpoints>(`/projects/${projectId}/endpoints`, { stable: null, previews: [] });
}

export async function getDeploymentOverview(projectId: string): Promise<DeploymentOverview> {
  return apiGet<DeploymentOverview>(`/projects/${projectId}/deployments`, { deployments: [], routes: [], retention: [] });
}

export async function getVariantMetrics(projectId: string): Promise<VariantMetric[]> {
  const data = await apiGet<{ variants: VariantMetric[] }>(`/projects/${projectId}/variant-metrics`, { variants: [] });
  return data.variants;
}

export async function getSecrets(projectId: string): Promise<PublicSecret[]> {
  const data = await apiGet<{ secrets: PublicSecret[] }>(`/projects/${projectId}/secrets`, { secrets: [] });
  return data.secrets;
}

export async function getSchedules(projectId: string): Promise<Schedule[]> {
  const data = await apiGet<{ schedules: Schedule[] }>(`/projects/${projectId}/schedules`, { schedules: [] });
  return data.schedules;
}

export async function getSessions(projectId: string): Promise<Session[]> {
  const data = await apiGet<{ sessions: Session[] }>(`/projects/${projectId}/sessions`, { sessions: [] });
  return data.sessions;
}

export async function getSessionEvents(sessionId: string): Promise<SessionEvent[]> {
  const data = await apiGet<{ events: SessionEvent[] }>(`/sessions/${sessionId}/events`, { events: [] });
  return data.events;
}

export async function getSessionUsage(sessionId: string): Promise<ModelUsageEvent[]> {
  const data = await apiGet<{ usage: ModelUsageEvent[] }>(`/sessions/${sessionId}/usage`, { usage: [] });
  return data.usage;
}

export async function getSessionNodes(sessionId: string): Promise<SessionNode[]> {
  const data = await apiGet<{ nodes: SessionNode[] }>(`/sessions/${sessionId}/nodes`, { nodes: [] });
  return data.nodes;
}

export async function getCollectorHealth(): Promise<CollectorHealth> {
  return apiGet<CollectorHealth>("/internal/collector/health", {
    status: "degraded",
    lastProcessedAt: null,
    backlogEvents: 0,
    backlogBytes: 0,
    oldestEventAge: 0,
    quarantinedEvents: 0,
    lastError: "Collector health is unavailable.",
  });
}

export async function runPlaygroundMessage(projectId: string, message: string): Promise<PlaygroundResult> {
  const response = await fetch(`${apiBaseUrl}/projects/${projectId}/playground`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  const data = (await response.json()) as PlaygroundResult & { error?: string; detail?: string };

  if (!response.ok) {
    throw new Error(data.detail ?? data.error ?? "Playground request failed");
  }

  return data;
}

export async function enqueueBuildDeploy(projectId: string): Promise<Job> {
  const response = await fetch(`${apiBaseUrl}/projects/${projectId}/build-deploy`, {
    method: "POST",
  });
  const data = (await response.json()) as { job?: Job; error?: string; detail?: string };

  if (!response.ok || !data.job) {
    throw new Error(data.detail ?? data.error ?? "Build deploy request failed");
  }

  return data.job;
}

export async function promoteDeployment(projectId: string, deploymentId: string): Promise<void> {
  await apiMutation(`/projects/${projectId}/deployments/${deploymentId}/promote`, { method: "POST" });
}

export async function drainDeployment(projectId: string, deploymentId: string): Promise<void> {
  await apiMutation(`/projects/${projectId}/deployments/${deploymentId}/drain`, { method: "POST" });
}

export async function archiveDeployment(projectId: string, deploymentId: string): Promise<void> {
  await apiMutation(`/projects/${projectId}/deployments/${deploymentId}/archive`, { method: "POST" });
}

export async function updateRouteTargets(
  projectId: string,
  routeId: string,
  targets: Array<{ deploymentId: string; weight: number; variantName: string | null }>,
): Promise<void> {
  await apiMutation(`/projects/${projectId}/routes/${routeId}/targets`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ targets }),
  });
}

export async function syncSource(projectId: string, options: { deploy?: boolean } = {}): Promise<Job> {
  const response = await fetch(`${apiBaseUrl}/projects/${projectId}/sync-source`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deploy: options.deploy ?? false }),
  });
  const data = (await response.json()) as { job?: Job; error?: string; detail?: string };

  if (!response.ok || !data.job) {
    throw new Error(data.detail ?? data.error ?? "Source sync request failed");
  }

  return data.job;
}

export async function getLogs(projectId: string): Promise<LogLine[]> {
  const data = await apiGet<{ logs: LogLine[] }>(`/projects/${projectId}/logs`, { logs: [] });
  return data.logs;
}

export async function getSourceRevision(projectId: string): Promise<SourceRevision | null> {
  const data = await apiGet<{ revision: SourceRevision | null }>(`/projects/${projectId}/source/revision`, { revision: null });
  return data.revision;
}

export async function getSourceFiles(projectId: string): Promise<SourceFile[]> {
  const data = await apiGet<{ files: SourceFile[] }>(`/projects/${projectId}/source/files`, { files: [] });
  return data.files;
}

export async function getSourceFile(projectId: string, filePath: string): Promise<SourceFile | null> {
  const data = await apiGet<{ file: SourceFile | null }>(`/projects/${projectId}/source/file?path=${encodeURIComponent(filePath)}`, { file: null });
  return data.file;
}

async function apiGet<T>(path: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return fallback;
    }

    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

async function apiMutation(path: string, init: RequestInit): Promise<void> {
  const response = await fetch(`${apiBaseUrl}${path}`, init);
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new Error(data.detail ?? data.error ?? `Request failed with ${response.status}`);
  }
}
