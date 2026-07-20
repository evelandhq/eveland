import type {
  DeploymentStatus,
  DeploymentRecord,
  Job,
  JobStatus,
  JobType,
  LogRecord,
  Project,
  ProjectImportKind,
  ProjectDeletionStatus,
  ProjectStatus,
  PublicSecret,
  ReleaseRecord,
  RuntimeKind,
  ScheduleRecord,
  Session,
  SessionEvent,
  SessionNode,
  SessionStatus,
  SessionTrigger,
  SecretRecord,
  SourceFileRecord,
  SourceRevision,
  AgentRoute,
  SessionBinding,
  ProjectSchedule,
  ScheduleVersion,
  ProjectSchedulerTarget,
  ScheduleRun,
  RuntimeInstance,
  ActivationLease,
  GitCredentialRecord,
  PublicGitCredential,
  SourcePreflight,
  SourcePreflightRecord,
  AgentConnection,
  AgentAuthCredential,
  AgentAuthTransaction,
} from "@eveland/core/contracts";

export function sourcePreflightRowToRecord(row: {
  id: string;
  userId: string;
  kind: string;
  gitUrl: string | null;
  sourcePath: string | null;
  commitSha: string | null;
  status: string;
  summary: unknown;
  error: string | null;
  attempts: number;
  lockedAt: Date | null;
  credentialHost: string | null;
  encryptedToken: string | null;
  persistCredential: boolean;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}): SourcePreflightRecord {
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind as SourcePreflightRecord["kind"],
    gitUrl: row.gitUrl,
    sourcePath: row.sourcePath,
    commitSha: row.commitSha,
    status: row.status as SourcePreflightRecord["status"],
    summary: isRecord(row.summary) ? row.summary : null,
    error: row.error,
    attempts: row.attempts,
    lockedAt: timestampToIso(row.lockedAt),
    gitCredential: row.credentialHost && row.encryptedToken
      ? {
          userId: row.userId,
          host: row.credentialHost,
          encryptedToken: row.encryptedToken,
          persistAfterImport: row.persistCredential,
        }
      : null,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function sourcePreflightRowToPublic(row: Parameters<typeof sourcePreflightRowToRecord>[0]): SourcePreflight {
  const record = sourcePreflightRowToRecord(row);
  const {
    userId: _userId,
    sourcePath: _sourcePath,
    commitSha: _commitSha,
    attempts: _attempts,
    lockedAt: _lockedAt,
    gitCredential: _gitCredential,
    ...publicPreflight
  } = record;
  return publicPreflight;
}

export type ProjectRow = {
  id: string;
  slug: string;
  ownerId: string;
  name: string;
  importKind: string;
  gitUrl: string | null;
  status: string;
  deploymentStatus: string;
  deletionStatus: string | null;
  deletionError: string | null;
  sourceRevisionId: string | null;
  releaseId: string | null;
  deploymentId: string | null;
  latestSessionStatus: string | null;
  nextScheduleAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function projectRowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    importKind: row.importKind as ProjectImportKind,
    gitUrl: row.gitUrl,
    status: row.status as ProjectStatus,
    deploymentStatus: row.deploymentStatus as DeploymentStatus,
    deletionStatus: row.deletionStatus as ProjectDeletionStatus | null,
    deletionError: row.deletionError,
    sourceRevisionId: row.sourceRevisionId,
    releaseId: row.releaseId,
    deploymentId: row.deploymentId,
    latestSessionStatus: row.latestSessionStatus as SessionStatus | null,
    nextScheduleAt: timestampToIso(row.nextScheduleAt),
    createdAt: timestampToIso(row.createdAt),
    updatedAt: timestampToIso(row.updatedAt),
  };
}

export function agentConnectionRowToAgentConnection(row: {
  id: string;
  projectId: string;
  targetKind: string;
  method: string;
  configEncrypted: string;
  securityRevision: number;
  createdAt: Date;
  updatedAt: Date;
}): AgentConnection {
  if (row.targetKind !== "managed-project") throw new Error(`Unsupported Agent Connection target: ${row.targetKind}.`);
  return {
    id: row.id,
    target: { kind: "managed-project", projectId: row.projectId },
    method: row.method,
    configEncrypted: row.configEncrypted,
    securityRevision: row.securityRevision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function agentAuthCredentialRowToAgentAuthCredential(row: {
  agentConnectionId: string;
  securityRevision: number;
  authMethod: string;
  credentialScope: string;
  scopeSubject: string;
  credentialKey: string;
  payloadEncrypted: string;
  expiresAt: Date | null;
  rotationSeq: number;
  refreshOwner: string | null;
  refreshLeaseId: string | null;
  refreshLeaseUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): AgentAuthCredential {
  if (row.credentialScope !== "connection" && row.credentialScope !== "principal") {
    throw new Error(`Unsupported Agent credential scope: ${row.credentialScope}.`);
  }
  return {
    ...row,
    credentialScope: row.credentialScope,
    expiresAt: timestampToIso(row.expiresAt),
    refreshLeaseUntil: timestampToIso(row.refreshLeaseUntil),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function agentAuthTransactionRowToAgentAuthTransaction(row: {
  agentConnectionId: string;
  stateHash: string;
  payloadEncrypted: string;
  expiresAt: Date;
  createdAt: Date;
}): AgentAuthTransaction {
  return {
    agentConnectionId: row.agentConnectionId,
    stateHash: row.stateHash,
    payloadEncrypted: row.payloadEncrypted,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export function secretRowToPublicSecret(row: {
  id: string;
  projectId: string;
  key: string;
  kind: string;
  createdAt: Date;
  updatedAt: Date;
}): PublicSecret {
  return {
    id: row.id,
    projectId: row.projectId,
    key: row.key,
    kind: row.kind as PublicSecret["kind"],
    createdAt: timestampToIso(row.createdAt),
    updatedAt: timestampToIso(row.updatedAt),
  };
}

export function secretRowToSecretRecord(row: {
  id: string;
  projectId: string;
  key: string;
  kind: string;
  encryptedValue: string;
  createdAt: Date;
  updatedAt: Date;
}): SecretRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    key: row.key,
    kind: row.kind as SecretRecord["kind"],
    encryptedValue: row.encryptedValue,
    createdAt: timestampToIso(row.createdAt),
    updatedAt: timestampToIso(row.updatedAt),
  };
}

export function gitCredentialRowToRecord(row: {
  id: string;
  userId: string;
  host: string;
  encryptedToken: string;
  createdAt: Date;
  updatedAt: Date;
}): GitCredentialRecord {
  return {
    id: row.id,
    userId: row.userId,
    host: row.host,
    encryptedToken: row.encryptedToken,
    createdAt: timestampToIso(row.createdAt),
    updatedAt: timestampToIso(row.updatedAt),
  };
}

export function gitCredentialRowToPublic(row: {
  id: string;
  host: string;
  createdAt: Date;
  updatedAt: Date;
}): PublicGitCredential {
  return {
    id: row.id,
    host: row.host,
    createdAt: timestampToIso(row.createdAt),
    updatedAt: timestampToIso(row.updatedAt),
  };
}

export function jobRowToJob(row: {
  id: string;
  projectId: string;
  type: string;
  status: string;
  payload: unknown;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Job {
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type as JobType,
    status: row.status as JobStatus,
    payload: isRecord(row.payload) ? row.payload : {},
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: timestampToIso(row.createdAt),
    updatedAt: timestampToIso(row.updatedAt),
  };
}

export function scheduleRowToSchedule(row: {
  id: string;
  projectId: string;
  name: string;
  kind: string;
  cron: string | null;
  timezone: string | null;
  enabled: boolean;
  executable: boolean;
  sourcePath: string;
  nextRunAt: Date | null;
}): ScheduleRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    kind: row.kind as ScheduleRecord["kind"],
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled,
    executable: row.executable,
    sourcePath: row.sourcePath,
    nextRunAt: timestampToIso(row.nextRunAt),
  };
}

export function projectScheduleRowToProjectSchedule(row: {
  id: string;
  projectId: string;
  key: string;
  enabled: boolean;
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): ProjectSchedule {
  return {
    ...row,
    nextRunAt: timestampToIso(row.nextRunAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function scheduleVersionRowToScheduleVersion(row: {
  id: string;
  scheduleId: string;
  sourceRevisionId: string;
  kind: string;
  cron: string;
  sourcePath: string;
  definitionHash: string;
  createdAt: Date;
}): ScheduleVersion {
  return { ...row, kind: row.kind as ScheduleVersion["kind"], createdAt: row.createdAt.toISOString() };
}

export function projectSchedulerTargetRowToProjectSchedulerTarget(row: {
  projectId: string;
  deploymentId: string;
  updatedAt: Date;
}): ProjectSchedulerTarget {
  return { ...row, updatedAt: row.updatedAt.toISOString() };
}

export function scheduleRunRowToScheduleRun(row: {
  id: string;
  scheduleId: string;
  scheduleVersionId: string;
  releaseId: string;
  deploymentId: string;
  dueAt: Date;
  trigger: string;
  status: string;
  attempt: number;
  missedTicks: number;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): ScheduleRun {
  return {
    ...row,
    dueAt: row.dueAt.toISOString(),
    trigger: row.trigger as ScheduleRun["trigger"],
    status: row.status as ScheduleRun["status"],
    startedAt: timestampToIso(row.startedAt),
    completedAt: timestampToIso(row.completedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function runtimeInstanceRowToRuntimeInstance(row: {
  id: string;
  deploymentId: string;
  generation: number;
  status: string;
  endpointHost: string | null;
  endpointPort: number | null;
  startedAt: Date | null;
  readyAt: Date | null;
  stoppedAt: Date | null;
  lastError: string | null;
}): RuntimeInstance {
  return {
    ...row,
    status: row.status as RuntimeInstance["status"],
    startedAt: timestampToIso(row.startedAt),
    readyAt: timestampToIso(row.readyAt),
    stoppedAt: timestampToIso(row.stoppedAt),
  };
}

export function activationLeaseRowToActivationLease(row: {
  id: string;
  deploymentId: string;
  runtimeInstanceId: string | null;
  kind: string;
  ownerId: string;
  expiresAt: Date;
  releasedAt: Date | null;
}): ActivationLease {
  return {
    ...row,
    kind: row.kind as ActivationLease["kind"],
    expiresAt: row.expiresAt.toISOString(),
    releasedAt: timestampToIso(row.releasedAt),
  };
}

export function sessionRowToSession(row: {
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
  scheduleRunId: string | null;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  usageReportedSteps: number;
  usageMissingSteps: number;
}): Session {
  return {
    id: row.id,
    projectId: row.projectId,
    deploymentId: row.deploymentId,
    eveSessionId: row.eveSessionId,
    continuationToken: row.continuationToken,
    rootNodeId: row.rootNodeId,
    routeId: row.routeId,
    experimentId: row.experimentId,
    variantName: row.variantName,
    trigger: row.trigger as SessionTrigger,
    scheduleId: row.scheduleId,
    scheduleRunId: row.scheduleRunId,
    status: row.status as SessionStatus,
    startedAt: timestampToIso(row.startedAt),
    completedAt: timestampToIso(row.completedAt),
    usage: {
      status:
        row.usageReportedSteps > 0
          ? row.usageMissingSteps > 0
            ? "partial"
            : "reported"
          : row.usageMissingSteps > 0
            ? "missing"
            : "none",
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      costUsd: row.costUsd,
      reportedSteps: row.usageReportedSteps,
      missingSteps: row.usageMissingSteps,
    },
  };
}

export function sessionEventRowToSessionEvent(row: {
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
  eventAt: Date;
  createdAt: Date;
}): SessionEvent {
  return {
    id: row.id,
    sessionId: row.sessionId,
    index: row.index,
    type: row.type,
    payload: row.payload,
    sessionNodeId: row.sessionNodeId,
    observerEventId: row.observerEventId,
    eventFingerprint: row.eventFingerprint,
    observedDeploymentId: row.observedDeploymentId,
    sourceSequence: row.sourceSequence,
    eventAt: timestampToIso(row.eventAt),
    createdAt: timestampToIso(row.createdAt),
  };
}

export function sessionNodeRowToSessionNode(row: {
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
  resolutionStatus: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): SessionNode {
  return {
    ...row,
    status: row.status as SessionNode["status"],
    resolutionStatus: row.resolutionStatus as SessionNode["resolutionStatus"],
    createdAt: timestampToIso(row.createdAt),
    updatedAt: timestampToIso(row.updatedAt),
  };
}

export function logRowToLog(row: {
  id: string;
  projectId: string;
  deploymentId: string | null;
  type: string;
  line: string;
  createdAt: Date;
}): LogRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    deploymentId: row.deploymentId,
    type: row.type as LogRecord["type"],
    line: row.line,
    createdAt: timestampToIso(row.createdAt),
  };
}

export function sourceRevisionRowToSourceRevision(row: {
  id: string;
  projectId: string;
  kind: string;
  commitSha: string | null;
  sourcePath: string;
  summary: unknown;
  envVars: unknown;
  createdAt: Date;
}): SourceRevision {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as SourceRevision["kind"],
    commitSha: row.commitSha,
    sourcePath: row.sourcePath,
    summary: isRecord(row.summary) ? row.summary : {},
    envVars: Array.isArray(row.envVars) ? row.envVars.filter((value): value is string => typeof value === "string") : [],
    createdAt: timestampToIso(row.createdAt),
  };
}

export function sourceFileRowToSourceFile(row: {
  id: string;
  revisionId: string;
  path: string;
  content: string;
  size: number;
}): SourceFileRecord {
  return {
    id: row.id,
    revisionId: row.revisionId,
    path: row.path,
    content: row.content,
    size: row.size,
  };
}

export function deploymentRowToDeployment(row: {
  id: string;
  deploymentKey: string;
  projectId: string;
  releaseId: string;
  containerName: string;
  internalPort: number;
  hostPort: number;
  status: string;
  runtimeKind: string;
  createdAt: Date;
  updatedAt: Date;
}): DeploymentRecord {
  return {
    id: row.id,
    deploymentKey: row.deploymentKey,
    projectId: row.projectId,
    releaseId: row.releaseId,
    containerName: row.containerName,
    internalPort: row.internalPort,
    hostPort: row.hostPort,
    status: row.status as DeploymentStatus,
    runtimeKind: row.runtimeKind as RuntimeKind,
    createdAt: timestampToIso(row.createdAt),
    updatedAt: timestampToIso(row.updatedAt),
  };
}

export function agentRouteRowToAgentRoute(row: {
  id: string;
  projectId: string;
  hostname: string;
  kind: string;
  enabled: boolean;
  policyRevision: number;
  createdAt: Date;
  updatedAt: Date;
}): AgentRoute {
  return {
    id: row.id,
    projectId: row.projectId,
    hostname: row.hostname,
    kind: row.kind as AgentRoute["kind"],
    enabled: row.enabled,
    policyRevision: row.policyRevision,
    createdAt: timestampToIso(row.createdAt),
    updatedAt: timestampToIso(row.updatedAt),
  };
}

export function sessionBindingRowToSessionBinding(row: {
  id: string;
  projectId: string;
  eveSessionId: string;
  routeId: string;
  deploymentId: string;
  trigger: string;
  variantName: string | null;
  experimentId: string | null;
  requestId: string;
  remoteIp: string | null;
  affinityFingerprint: string | null;
  affinitySource: string | null;
  createdAt: Date;
  updatedAt: Date;
}): SessionBinding {
  return {
    ...row,
    trigger: row.trigger as SessionBinding["trigger"],
    affinitySource: row.affinitySource as SessionBinding["affinitySource"],
    createdAt: timestampToIso(row.createdAt),
    updatedAt: timestampToIso(row.updatedAt),
  };
}

export function releaseRowToRelease(row: {
  id: string;
  projectId: string;
  sourceRevisionId: string;
  imageTag: string;
  createdAt: Date;
}): ReleaseRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    sourceRevisionId: row.sourceRevisionId,
    imageTag: row.imageTag,
    createdAt: timestampToIso(row.createdAt),
  };
}

export function timestampToIso(value: Date): string;
export function timestampToIso(value: Date | null): string | null;
export function timestampToIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
