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
