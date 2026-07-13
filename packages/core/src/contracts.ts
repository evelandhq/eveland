export type ProjectImportKind = "git" | "zip";
export type ProjectStatus = "import_pending" | "imported" | "invalid" | "build_pending" | "deployed" | "failed";
export type DeploymentStatus = "not_deployed" | "building" | "starting" | "running" | "draining" | "stopped" | "archived" | "failed";
export type SessionStatus = "running" | "waiting" | "completed" | "failed" | "waiting_approval";
export type SessionTrigger = "playground" | "cron" | "webhook" | "channel" | "api" | "direct_http";
export type RuntimeKind = "docker" | "systemd";
export type TeamRole = "admin" | "member";

export type UserRecord = {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TeamMember = {
  userId: string;
  email: string;
  name: string | null;
  role: TeamRole;
  joinedAt: string;
};

export type TeamInvitation = {
  id: string;
  email: string;
  role: TeamRole;
  status: "pending" | "accepted" | "revoked";
  tokenHash: string;
  expiresAt: string;
  invitedByUserId: string;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AuthPrincipal = TeamMember;

export type AuthSessionRecord = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export type Project = {
  id: string;
  routingKey: string;
  name: string;
  importKind: ProjectImportKind;
  gitUrl: string | null;
  status: ProjectStatus;
  deploymentStatus: DeploymentStatus;
  sourceRevisionId: string | null;
  releaseId: string | null;
  deploymentId: string | null;
  latestSessionStatus: SessionStatus | null;
  nextScheduleAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SecretRecord = {
  id: string;
  projectId: string;
  key: string;
  encryptedValue: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicSecret = Omit<SecretRecord, "encryptedValue">;

export type JobType = "import_source" | "build_deploy" | "restart_deployment" | "trigger_schedule" | "archive_deployment" | "delete_project";
export type JobStatus = "queued" | "running" | "completed" | "failed";

export type Job = {
  id: string;
  projectId: string;
  type: JobType;
  status: JobStatus;
  payload: Record<string, unknown>;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SourceFileNode = {
  path: string;
  type: "file" | "directory";
  size?: number;
};

export type SourceRevision = {
  id: string;
  projectId: string;
  kind: ProjectImportKind;
  commitSha: string | null;
  sourcePath: string;
  summary: Record<string, unknown>;
  envVars: string[];
  createdAt: string;
};

export type ReleaseRecord = {
  id: string;
  projectId: string;
  sourceRevisionId: string;
  imageTag: string;
  createdAt: string;
};

export type DeploymentRecord = {
  id: string;
  deploymentKey: string;
  projectId: string;
  releaseId: string;
  containerName: string;
  internalPort: number;
  hostPort: number;
  status: DeploymentStatus;
  runtimeKind: RuntimeKind;
  createdAt: string;
  updatedAt: string;
};

export type SourceFileRecord = {
  id: string;
  revisionId: string;
  path: string;
  content: string;
  size: number;
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
  trigger: SessionTrigger;
  scheduleId: string | null;
  status: SessionStatus;
  startedAt: string;
  completedAt: string | null;
  usage: SessionTokenUsage;
};

export type AgentRouteKind = "project" | "deployment" | "alias";

export type AgentRoute = {
  id: string;
  projectId: string;
  hostname: string;
  kind: AgentRouteKind;
  enabled: boolean;
  policyRevision: number;
  createdAt: string;
  updatedAt: string;
};

export type RouteTarget = {
  routeId: string;
  deploymentId: string;
  weight: number;
  variantName: string | null;
};

export type ResolvedAgentRoute = AgentRoute & {
  targets: Array<
    RouteTarget & {
      hostPort: number;
      status: DeploymentStatus;
    }
  >;
};

export type SessionBinding = {
  id: string;
  projectId: string;
  eveSessionId: string;
  routeId: string;
  deploymentId: string;
  trigger: "api" | "playground";
  variantName: string | null;
  experimentId: string | null;
  requestId: string;
  remoteIp: string | null;
  affinityFingerprint: string | null;
  affinitySource: "cookie" | "version_key" | "generated" | null;
  createdAt: string;
  updatedAt: string;
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
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
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

export type ScheduleRecord = {
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

export type LogRecord = {
  id: string;
  projectId: string;
  deploymentId: string | null;
  type: "build" | "deploy" | "runtime";
  line: string;
  createdAt: string;
};
