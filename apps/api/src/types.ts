export type ProjectImportKind = "git" | "zip";
export type ProjectStatus = "import_pending" | "imported" | "invalid" | "build_pending" | "deployed" | "failed";
export type DeploymentStatus = "not_deployed" | "building" | "starting" | "running" | "stopped" | "failed";
export type SessionStatus = "running" | "completed" | "failed" | "waiting_approval";
export type SessionTrigger = "playground" | "cron" | "webhook" | "channel" | "api";

export type Project = {
  id: string;
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

export type JobType = "import_source" | "build_deploy" | "restart_deployment" | "trigger_schedule";
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
  projectId: string;
  releaseId: string;
  containerName: string;
  internalPort: number;
  hostPort: number;
  status: DeploymentStatus;
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
  trigger: SessionTrigger;
  scheduleId: string | null;
  status: SessionStatus;
  startedAt: string;
  completedAt: string | null;
  usage: SessionTokenUsage;
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
