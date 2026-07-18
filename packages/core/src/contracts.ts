export type ProjectImportKind = "git" | "zip";
export type ProjectStatus = "import_pending" | "imported" | "invalid" | "build_pending" | "deployed" | "failed";
export type ProjectDeletionStatus = "deleting" | "failed";
export type DeploymentStatus = "not_deployed" | "building" | "starting" | "running" | "draining" | "stopped" | "archived" | "failed";
export type SessionStatus = "running" | "waiting" | "completed" | "failed" | "waiting_approval";
export type SessionTrigger = "playground" | "cron" | "manual" | "webhook" | "channel" | "api" | "direct_http";
export type RuntimeKind = "docker" | "systemd";
export type TeamRole = "admin" | "member";

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
  status: "pending" | "accepted" | "rejected" | "canceled";
  expiresAt: string;
  invitedByUserId: string;
  createdAt: string;
};

export type AuthPrincipal = TeamMember & {
  image: string | null;
};

export type Project = {
  id: string;
  slug: string;
  name: string;
  importKind: ProjectImportKind;
  gitUrl: string | null;
  status: ProjectStatus;
  deploymentStatus: DeploymentStatus;
  deletionStatus: ProjectDeletionStatus | null;
  deletionError: string | null;
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

export type PlatformSecretProfileEntryKind = "variable" | "secret";

export type PlatformSecretProfileEntry = {
  key: string;
  kind: PlatformSecretProfileEntryKind;
  configured: true;
};

export type PlatformSecretProfile = {
  id: string;
  name: string;
  revision: number;
  entries: PlatformSecretProfileEntry[];
  createdAt: string;
  updatedAt: string;
};

export type PlatformSecretProfileRecord = Omit<PlatformSecretProfile, "entries"> & {
  entries: Array<{
    key: string;
    kind: PlatformSecretProfileEntryKind;
    encryptedValue: string;
  }>;
};

export const SHARED_AGENT_ENVIRONMENT_PROFILE_ID = "sp_sharedagentenvironment";
export const SHARED_AGENT_ENVIRONMENT_PROFILE_NAME = "__eveland_internal_shared_agent_environment__";

export type SharedAgentEnvironment = Omit<PlatformSecretProfile, "id" | "name">;

export type SharedAgentEnvironmentRecord = Omit<
  PlatformSecretProfileRecord,
  "id" | "name"
>;

export type SharedAgentEnvironmentBinding = {
  id: string;
  projectId: string;
  deploymentId: string | null;
  environmentRevision: number;
  createdAt: string;
  updatedAt: string;
};

export type PlatformSecretConsumer = "agent-runtime" | "agent-connection";

export type PlatformSecretProfileBinding = {
  id: string;
  profileId: string;
  profileName: string;
  profileRevision: number;
  projectId: string;
  deploymentId: string | null;
  consumer: PlatformSecretConsumer;
  createdAt: string;
  updatedAt: string;
};

export type GitCredentialRecord = {
  id: string;
  userId: string;
  host: string;
  encryptedToken: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicGitCredential = Omit<GitCredentialRecord, "encryptedToken" | "userId">;

export type SourcePreflightStatus = "queued" | "running" | "completed" | "failed" | "consumed";

export type SourcePreflight = {
  id: string;
  kind: ProjectImportKind;
  gitUrl: string | null;
  status: SourcePreflightStatus;
  summary: Record<string, unknown> | null;
  error: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export type SourcePreflightRecord = SourcePreflight & {
  userId: string;
  sourcePath: string | null;
  commitSha: string | null;
  attempts: number;
  lockedAt: string | null;
  gitCredential: {
    userId: string;
    host: string;
    encryptedToken: string;
    persistAfterImport: boolean;
  } | null;
};

export type AgentConnection = {
  id: string;
  target: { kind: "managed-project"; projectId: string };
  method: string;
  configEncrypted: string;
  securityRevision: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentAuthCredential = {
  agentConnectionId: string;
  securityRevision: number;
  authMethod: string;
  credentialScope: "connection" | "principal";
  scopeSubject: string;
  credentialKey: string;
  payloadEncrypted: string;
  expiresAt: string | null;
  rotationSeq: number;
  refreshOwner: string | null;
  refreshLeaseId: string | null;
  refreshLeaseUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentAuthTransaction = {
  agentConnectionId: string;
  stateHash: string;
  payloadEncrypted: string;
  expiresAt: string;
  createdAt: string;
};

export type JobType = "import_source" | "build_deploy" | "restart_deployment" | "trigger_schedule" | "ensure_deployment_running" | "archive_deployment" | "delete_project";
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
  scheduleRunId: string | null;
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

export type ProjectSchedule = {
  id: string;
  projectId: string;
  key: string;
  enabled: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleVersion = {
  id: string;
  scheduleId: string;
  sourceRevisionId: string;
  kind: "markdown" | "handler";
  cron: string;
  sourcePath: string;
  definitionHash: string;
  createdAt: string;
};

export type ProjectScheduleVersion = {
  schedule: ProjectSchedule;
  version: ScheduleVersion;
};

export type ProjectSchedulerTarget = {
  projectId: string;
  deploymentId: string;
  updatedAt: string;
};

export type ScheduleRunStatus =
  | "queued"
  | "activating"
  | "dispatching"
  | "running"
  | "succeeded"
  | "failed"
  | "dispatch_unknown"
  | "skipped";

export type ScheduleRun = {
  id: string;
  scheduleId: string;
  scheduleVersionId: string;
  releaseId: string;
  deploymentId: string;
  dueAt: string;
  trigger: "cron" | "manual";
  status: ScheduleRunStatus;
  attempt: number;
  missedTicks: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectScheduleSummary = {
  schedule: ProjectSchedule;
  version: ScheduleVersion | null;
  targetDeploymentId: string | null;
};

export type ScheduleRunListItem = ScheduleRun & {
  scheduleKey: string;
  sessionCount: number;
  usage: SessionTokenUsage;
  sessions: Session[];
};

export type ScheduleRunDetail = ScheduleRunListItem & {
  version: ScheduleVersion;
  release: ReleaseRecord;
  deployment: DeploymentRecord;
};

export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type RuntimeInstanceStatus = "starting" | "ready" | "draining" | "stopped" | "failed";

export type RuntimeInstance = {
  id: string;
  deploymentId: string;
  generation: number;
  status: RuntimeInstanceStatus;
  endpointHost: string | null;
  endpointPort: number | null;
  startedAt: string | null;
  readyAt: string | null;
  stoppedAt: string | null;
  lastError: string | null;
};

export type ActivationLeaseKind = "public_request" | "stream" | "turn" | "schedule_run";

export type ActivationLease = {
  id: string;
  deploymentId: string;
  runtimeInstanceId: string | null;
  kind: ActivationLeaseKind;
  ownerId: string;
  expiresAt: string;
  releasedAt: string | null;
};

export type ActivationLeaseClaim = {
  lease: ActivationLease;
  runtimeInstance: RuntimeInstance;
  starter: boolean;
};

export type LogRecord = {
  id: string;
  projectId: string;
  deploymentId: string | null;
  type: "build" | "deploy" | "runtime";
  line: string;
  createdAt: string;
};
