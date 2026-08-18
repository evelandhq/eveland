export type ProjectImportKind = "git" | "zip";
export type ProjectStatus =
  | "import_pending"
  | "imported"
  | "invalid"
  | "build_pending"
  | "deployed"
  | "failed";
export type ProjectDeletionStatus = "deleting" | "failed";
export type DeploymentStatus =
  | "not_deployed"
  | "building"
  | "starting"
  | "running"
  | "draining"
  | "stopped"
  | "archiving"
  | "archived"
  | "failed";
export type SessionStatus = "running" | "waiting" | "completed" | "failed" | "waiting_approval";
export type SessionTrigger =
  | "playground"
  | "cron"
  | "manual"
  | "webhook"
  | "channel"
  | "api"
  | "direct_http";
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
  displayTimezone: string | null;
};

export type Project = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
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

export type EnvironmentEntryKind = "variable" | "secret";

export type SecretRecord = {
  id: string;
  projectId: string;
  key: string;
  kind: EnvironmentEntryKind;
  encryptedValue: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicSecret = Omit<SecretRecord, "encryptedValue">;

export type SharedAgentEnvironmentEntryKind = EnvironmentEntryKind;

export type SharedAgentEnvironmentEntry = {
  key: string;
  kind: SharedAgentEnvironmentEntryKind;
  configured: true;
};

export type SharedAgentEnvironment = {
  revision: number;
  entries: SharedAgentEnvironmentEntry[];
  createdAt: string;
  updatedAt: string;
};

export type SharedAgentEnvironmentRecord = Omit<SharedAgentEnvironment, "entries"> & {
  entries: Array<{
    key: string;
    kind: SharedAgentEnvironmentEntryKind;
    encryptedValue: string;
  }>;
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

export type ImportSourceJobPayload = {
  importKind?: ProjectImportKind;
  gitUrl?: string | null;
  sourcePath?: string | null;
  gitCredential?: {
    userId: string;
    host: string;
    encryptedToken: string;
    persistAfterImport: boolean;
  };
  deployAfterImport?: boolean;
  promoteAfterDeploy?: boolean;
};

export type JobPayloadMap = {
  import_source: ImportSourceJobPayload;
  build_deploy: { promoteAfterDeploy?: boolean };
  restart_deployment: {
    deploymentId?: string;
    reason?: string;
  };
  trigger_schedule: { scheduleRunId: string };
  ensure_deployment_running: {
    deploymentId: string;
    runtimeInstanceId: string;
  };
  archive_deployment: { deploymentId: string; automatic?: boolean };
  delete_project: { sourcePaths?: string[] };
};

export type JobType = keyof JobPayloadMap;
export type JobStatus = "queued" | "running" | "completed" | "failed";

type JobRecord<Type extends JobType> = {
  id: string;
  projectId: string;
  type: Type;
  status: JobStatus;
  payload: JobPayloadMap[Type];
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Job<Type extends JobType = JobType> = {
  [Candidate in Type]: JobRecord<Candidate>;
}[Type];

/** Browser-safe job status. Persisted payloads may contain sealed credentials. */
export type PublicJob = {
  id: string;
  projectId: string;
  type: JobType;
  status: JobStatus;
  payload: Record<string, never>;
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

// The browser-facing shape: the host filesystem path stays on the server.
export type PublicSourceRevision = Omit<SourceRevision, "sourcePath">;

export type ReleaseRecord = {
  id: string;
  projectId: string;
  sourceRevisionId: string;
  imageTag: string;
  // Observer delivery contract embedded at build time; null for releases
  // built before the contract was recorded (their baked observer goes stale
  // as the platform moves and needs a rebuild to refresh).
  observerContract: number | null;
  // Build-derived summary from eve's discovery manifest; null when the
  // manifest could not be read or the release predates the column.
  summary: Record<string, unknown> | null;
  createdAt: string;
};

// The browser-facing shape: registry refs and the observer delivery contract
// are runtime-internal.
export type PublicReleaseRecord = Omit<ReleaseRecord, "imageTag" | "observerContract">;

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

// The browser-facing shape: container naming and the container-internal port
// are runtime-internal. hostPort stays -- the deployments page shows it as
// the loopback upstream.
export type PublicDeploymentRecord = Omit<DeploymentRecord, "containerName" | "internalPort">;

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

/**
 * Wire shapes of the Project deployment surface, declared next to the records
 * they project so the control panel pins its client types against them
 * instead of re-describing the responses by hand.
 */
export type PublicDeploymentRetention = {
  deployment: PublicDeploymentRecord;
  protected: boolean;
  reasons: Array<
    "route_target" | "active_session" | "active_operation" | "active_request" | "recent_artifact"
  >;
};

export type DeploymentOverview = {
  deployments: PublicDeploymentRecord[];
  routes: ResolvedAgentRoute[];
  retention: PublicDeploymentRetention[];
  /**
   * Release id -> build-derived summary projected from eve's discovery
   * manifest; null for releases built before the projection existed or whose
   * manifest was unreadable.
   */
  releaseSummaries: Record<string, Record<string, unknown> | null>;
};

/** Per-variant rollup behind the experiment view. */
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

/** Gateway-resolved public addresses for a Project's Agent. */
export type AgentEndpoints = {
  stable: string | null;
  previews: string[];
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

/** Durable Gateway target for one opaque, HMAC-keyed Eve create operation. */
export type OperationBinding = {
  id: string;
  projectId: string;
  operationKey: string;
  routeId: string;
  deploymentId: string;
  trigger: "api" | "playground";
  variantName: string | null;
  experimentId: string | null;
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
  startedRuntimeInstanceId: string | null;
  lastObservedRuntimeInstanceId: string | null;
  agentId: string | null;
  agentName: string | null;
  nodeId: string | null;
  channelKind: string | null;
  /** The manifest model id Eve reported on `session.started`. */
  modelId: string | null;
  /** The model the Agent process was last observed actually calling. */
  observedModelId: string | null;
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
  /** The model observed actually serving this step; null before the capture existed. */
  modelId: string | null;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  usageReported: boolean;
  createdAt: string;
};

export type UsageRange = "24h" | "7d" | "30d";

export type UsageTotals = {
  sessions: number;
  runningSessions: number;
  waitingSessions: number;
  completedSessions: number;
  failedSessions: number;
  modelSteps: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  reportedSteps: number;
  missingSteps: number;
  costReportedSteps: number;
};

export type UsageSeriesPoint = UsageTotals & {
  bucketStart: string;
};

export type ProjectUsageBreakdown = UsageTotals & {
  projectId: string;
  projectName: string;
};

export type ModelUsageBreakdown = UsageTotals & {
  modelId: string | null;
};

export type AgentModelUsageBreakdown = UsageTotals & {
  projectId: string;
  projectName: string;
  agentId: string | null;
  agentName: string | null;
  modelId: string | null;
};

export type UsageRecentSession = Session & {
  projectName: string;
};

export type UsageAnalytics = {
  range: UsageRange;
  from: string;
  to: string;
  bucket: "hour" | "day";
  modelId: string | null;
  summary: UsageTotals;
  previousSummary: UsageTotals;
  series: UsageSeriesPoint[];
  projects: ProjectUsageBreakdown[];
  models: ModelUsageBreakdown[];
  agentModels: AgentModelUsageBreakdown[];
  recentSessions: UsageRecentSession[];
};

export type SessionEvent = {
  id: string;
  sessionId: string;
  index: number;
  type: string;
  payload: unknown;
  sessionNodeId: string | null;
  telemetryEventId: string | null;
  eventFingerprint: string | null;
  observedDeploymentId: string | null;
  observedRuntimeInstanceId: string | null;
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

export type ActivationLeaseKind =
  | "public_request"
  | "stream"
  | "turn"
  | "schedule_run"
  // Held by the workflow dispatcher for the duration of one step. Unlike
  // the request kinds it can outlive a single HTTP exchange, so it is
  // renewed rather than acquired once.
  | "workflow_step";

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
