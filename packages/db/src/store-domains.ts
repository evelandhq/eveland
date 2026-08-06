import type {
  ActivationLease,
  ActivationLeaseClaim,
  ActivationLeaseKind,
  AgentAuthCredential,
  AgentAuthTransaction,
  AgentConnection,
  AgentRoute,
  CursorPage,
  DeploymentRecord,
  DeploymentStatus,
  GitCredentialRecord,
  Job,
  JobPayloadMap,
  JobType,
  LogRecord,
  ModelUsageEvent,
  Project,
  ProjectImportKind,
  ProjectSchedule,
  ProjectSchedulerTarget,
  ProjectScheduleSummary,
  ProjectScheduleVersion,
  ProjectStatus,
  PublicGitCredential,
  PublicSecret,
  ReleaseRecord,
  ResolvedAgentRoute,
  RouteTarget,
  RuntimeInstance,
  RuntimeInstanceStatus,
  SharedAgentEnvironment,
  SharedAgentEnvironmentEntryKind,
  SharedAgentEnvironmentRecord,
  RuntimeKind,
  ScheduleRecord,
  ScheduleRun,
  ScheduleRunDetail,
  ScheduleRunListItem,
  ScheduleVersion,
  SecretRecord,
  Session,
  SessionBinding,
  SessionEvent,
  SessionNode,
  SessionStatus,
  SessionTrigger,
  SourceFileRecord,
  SourcePreflight,
  SourcePreflightRecord,
  SourceRevision,
  UsageAnalytics,
  UsageRange,
} from "@evelandhq/core/contracts";
import type { ModelStepUsage } from "@evelandhq/core/eve";
import type { AgentCatalogRecord } from "@evelandhq/core/catalog";
import type { AgentEventObservation } from "@evelandhq/core/observability";
import type { EveVersionInfo } from "@evelandhq/core/source";
import type { SessionBindingIdlePolicy } from "@evelandhq/core/routing";
import type {
  HostMetricSample,
  InstanceWorkload,
  WorkerHeartbeat,
} from "@evelandhq/core/instance-health";
import type {
  ExternalRealmKind,
  IdentityLoginTransaction,
  IdentityOidcCredential,
  IdentityPrincipal,
  ExternalRealmResolution,
  IdentityProviderConnection,
  IdentityProviderType,
  IdentityRealm,
  IdentityReturnTarget,
  IdentitySession,
  IdentitySigningKey,
  IdentitySigningKeyStatus,
} from "@evelandhq/core/identity";
import type {
  AgentCapturePolicy,
  ExternalObservabilityDestination,
  ExternalDestinationHealth,
  ObservabilitySignal,
  ObservabilityPolicy,
} from "@evelandhq/core/observability";

export type DeploymentRetention = {
  deployment: DeploymentRecord;
  protected: boolean;
  reasons: Array<"route_target" | "active_session" | "active_request" | "recent_artifact">;
};

export type DeploymentRetentionOptions = SessionBindingIdlePolicy & {
  now?: Date;
};

export type CreateProjectInput = {
  name: string;
  importKind: ProjectImportKind;
  gitUrl?: string | null;
  sourcePath?: string | null;
  requireExactSlug?: boolean;
  deployAfterImport?: boolean;
  gitCredential?: {
    userId: string;
    host: string;
    encryptedToken: string;
    persistAfterImport: boolean;
  };
};

export type CreateSourcePreflightInput = {
  userId: string;
  kind: ProjectImportKind;
  gitUrl?: string | null;
  sourcePath?: string | null;
  expiresAt: Date;
  gitCredential?: SourcePreflightRecord["gitCredential"];
};

export type CreateProjectFromSourcePreflightResult =
  | { outcome: "created"; project: Project }
  | { outcome: "not_found" }
  | { outcome: "not_ready" }
  | { outcome: "consumed" };

export type InitialProjectSecret = Pick<SecretRecord, "key" | "encryptedValue"> & {
  kind?: SecretRecord["kind"];
};

export type SaveSharedAgentEnvironmentInput = {
  entries: Array<{
    key: string;
    kind: SharedAgentEnvironmentEntryKind;
    encryptedValue: string;
  }>;
};

export type ProjectDeletionRequest =
  | { outcome: "queued"; job: Job }
  | { outcome: "not_found" }
  | { outcome: "already_deleting" };

export type AgentAuthCredentialKey = Pick<
  AgentAuthCredential,
  | "agentConnectionId"
  | "securityRevision"
  | "authMethod"
  | "credentialScope"
  | "scopeSubject"
  | "credentialKey"
>;

export interface ProjectStore {
  listProjects(): Promise<Project[]>;
  isProjectSlugAvailable(slug: string): Promise<boolean>;
  createProject(input: CreateProjectInput): Promise<Project>;
  getProject(projectId: string): Promise<Project | null>;
  updateProjectMetadata(
    projectId: string,
    input: { name: string; description: string | null },
  ): Promise<Project | null>;
  requestProjectDeletion(projectId: string): Promise<ProjectDeletionRequest>;
  setProjectDeletionFailed(projectId: string, error: string): Promise<Project | null>;
  deleteProject(projectId: string): Promise<boolean>;
  updateProjectState(
    projectId: string,
    state: { status?: ProjectStatus; deploymentStatus?: DeploymentStatus },
  ): Promise<Project | null>;
}

export interface CatalogStore {
  listAgentCatalog(): Promise<AgentCatalogRecord[]>;
}

export interface SourceStore {
  createSourcePreflight(input: CreateSourcePreflightInput): Promise<SourcePreflight>;
  getSourcePreflight(preflightId: string, userId: string): Promise<SourcePreflight | null>;
  claimNextSourcePreflight(workerId: string, now?: Date): Promise<SourcePreflightRecord | null>;
  heartbeatSourcePreflight(preflightId: string, attempt: number, now?: Date): Promise<boolean>;
  recoverStaleSourcePreflights(now?: Date, staleAfterMs?: number, limit?: number): Promise<number>;
  completeSourcePreflight(
    preflightId: string,
    attempt: number,
    result: { sourcePath: string; commitSha: string | null; summary: Record<string, unknown> },
  ): Promise<boolean>;
  failSourcePreflight(preflightId: string, attempt: number, error: string): Promise<boolean>;
  createProjectFromSourcePreflight(input: {
    preflightId: string;
    userId: string;
    name: string;
    deployAfterImport?: boolean;
    secrets?: InitialProjectSecret[];
  }): Promise<CreateProjectFromSourcePreflightResult>;
  expireSourcePreflights(now?: Date, limit?: number): Promise<string[]>;
  recordSourceRevision(input: {
    projectId: string;
    kind: ProjectImportKind;
    commitSha?: string | null;
    sourcePath: string;
    summary: Record<string, unknown>;
    envVars: string[];
    files: Array<{ path: string; content: string }>;
    schedules: Array<Omit<ScheduleRecord, "id" | "projectId">>;
  }): Promise<SourceRevision>;
  listSourceRevisions(projectId: string): Promise<SourceRevision[]>;
  getCurrentSourceRevision(projectId: string): Promise<SourceRevision | null>;
  getSourceRevision(revisionId: string): Promise<SourceRevision | null>;
  listSourceRevisionFiles(revisionId: string): Promise<SourceFileRecord[]>;
  listSourceFiles(projectId: string): Promise<SourceFileRecord[]>;
  getSourceFile(projectId: string, filePath: string): Promise<SourceFileRecord | null>;
}

export interface GitCredentialStore {
  listGitCredentials(userId: string): Promise<PublicGitCredential[]>;
  getGitCredential(userId: string, host: string): Promise<GitCredentialRecord | null>;
  upsertGitCredential(
    userId: string,
    host: string,
    encryptedToken: string,
  ): Promise<GitCredentialRecord>;
  deleteGitCredential(userId: string, credentialId: string): Promise<boolean>;
}

export interface AgentAuthStore {
  createAgentConnection(input: {
    id?: string;
    target: AgentConnection["target"];
    method: string;
    configEncrypted: string;
  }): Promise<AgentConnection>;
  getAgentConnection(agentConnectionId: string): Promise<AgentConnection | null>;
  getProjectAgentConnection(projectId: string): Promise<AgentConnection | null>;
  updateAgentConnection(input: {
    id: string;
    expectedSecurityRevision: number;
    method: string;
    configEncrypted: string;
    securityChanged: boolean;
  }): Promise<AgentConnection | null>;
  putAgentAuthCredential(
    input: AgentAuthCredentialKey & {
      payloadEncrypted: string;
      expiresAt: Date | null;
    },
  ): Promise<AgentAuthCredential>;
  getAgentAuthCredential(key: AgentAuthCredentialKey): Promise<AgentAuthCredential | null>;
  deleteAgentAuthCredential(
    key: AgentAuthCredentialKey,
    expectedRotationSeq: number,
  ): Promise<boolean>;
  replaceAgentAuthCredential(
    input: AgentAuthCredentialKey & {
      expectedRotationSeq: number;
      payloadEncrypted: string;
      expiresAt: Date | null;
    },
  ): Promise<AgentAuthCredential | null>;
  claimAgentAuthCredentialRefresh(
    input: AgentAuthCredentialKey & {
      expectedRotationSeq: number;
      owner: string;
      leaseId: string;
      leaseUntil: Date;
      now: Date;
    },
  ): Promise<AgentAuthCredential | null>;
  completeAgentAuthCredentialRefresh(
    input: AgentAuthCredentialKey & {
      expectedRotationSeq: number;
      owner: string;
      leaseId: string;
      now: Date;
      payloadEncrypted: string;
      expiresAt: Date | null;
    },
  ): Promise<AgentAuthCredential | null>;
  releaseAgentAuthCredentialRefresh(
    input: AgentAuthCredentialKey & {
      expectedRotationSeq: number;
      owner: string;
      leaseId: string;
      now: Date;
    },
  ): Promise<AgentAuthCredential | null>;
  createAgentAuthTransaction(input: {
    agentConnectionId: string;
    stateHash: string;
    payloadEncrypted: string;
    expiresAt: Date;
  }): Promise<AgentAuthTransaction>;
  consumeAgentAuthTransaction(stateHash: string, now?: Date): Promise<AgentAuthTransaction | null>;
  deleteExpiredAgentAuthTransactions(now?: Date, limit?: number): Promise<number>;
  deleteStaleAgentAuthCredentials(
    agentConnectionId: string,
    currentSecurityRevision: number,
  ): Promise<number>;
}

export interface IdentityStore {
  createIdentityProviderConnection(input: {
    type: IdentityProviderType;
    displayName: string;
    internalRealmKey?: string;
    issuer?: string;
    clientId?: string;
    clientSecretEncrypted?: string | null;
    scopes?: string[];
    authorizationParameters?: Record<string, string>;
    tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post" | "none";
    externalRealmResolution?: ExternalRealmResolution;
    externalRealmClaim?: string | null;
    enabled: boolean;
  }): Promise<IdentityProviderConnection>;
  listIdentityProviderConnections(): Promise<IdentityProviderConnection[]>;
  getIdentityProviderConnection(id: string): Promise<IdentityProviderConnection | null>;
  updateIdentityProviderConnection(input: {
    id: string;
    expectedSecurityRevision: number;
    displayName: string;
    internalRealmKey?: string;
    issuer?: string;
    clientId?: string;
    clientSecretEncrypted?: string | null;
    scopes?: string[];
    authorizationParameters?: Record<string, string>;
    tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post" | "none";
    externalRealmResolution?: ExternalRealmResolution;
    externalRealmClaim?: string | null;
    enabled: boolean;
    securityChanged: boolean;
  }): Promise<IdentityProviderConnection | null>;
  createIdentityRealm(input: {
    providerConnectionId: string;
    externalRealmId: string;
    externalRealmKind: ExternalRealmKind;
    displayName: string;
    enabled: boolean;
  }): Promise<IdentityRealm>;
  listIdentityRealms(providerConnectionId?: string): Promise<IdentityRealm[]>;
  getIdentityRealm(id: string): Promise<IdentityRealm | null>;
  getIdentityRealmByExternalId(
    providerConnectionId: string,
    externalRealmId: string,
  ): Promise<IdentityRealm | null>;
  updateIdentityRealm(
    id: string,
    input: { displayName: string; enabled: boolean },
  ): Promise<IdentityRealm | null>;
  upsertIdentityPrincipal(input: {
    identityRealmId: string;
    externalSubject: string;
    displayName: string | null;
    email: string | null;
    claims: Record<string, string | readonly string[]>;
  }): Promise<IdentityPrincipal>;
  getIdentityPrincipal(id: string): Promise<IdentityPrincipal | null>;
  createIdentitySession(input: {
    tokenHash: string;
    identityPrincipalId: string;
    activeIdentityRealmId: string;
    expiresAt: Date;
  }): Promise<IdentitySession>;
  getActiveIdentitySession(tokenHash: string, now?: Date): Promise<IdentitySession | null>;
  revokeIdentitySession(id: string, now?: Date): Promise<IdentitySession | null>;
  revokeIdentitySessionByTokenHash(tokenHash: string, now?: Date): Promise<boolean>;
  createIdentityLoginTransaction(input: {
    stateHash: string;
    providerConnectionId: string;
    providerSecurityRevision: number;
    returnTargetId: string;
    returnPath: string;
    nonceHash: string | null;
    pkceVerifierEncrypted: string | null;
    expiresAt: Date;
  }): Promise<IdentityLoginTransaction>;
  consumeIdentityLoginTransaction(
    stateHash: string,
    now?: Date,
  ): Promise<IdentityLoginTransaction | null>;
  deleteExpiredIdentityLoginTransactions(now?: Date, limit?: number): Promise<number>;
  upsertIdentityReturnTarget(input: {
    key: string;
    origin: string;
    enabled: boolean;
  }): Promise<IdentityReturnTarget>;
  listIdentityReturnTargets(): Promise<IdentityReturnTarget[]>;
  getIdentityReturnTargetByKey(key: string): Promise<IdentityReturnTarget | null>;
  putIdentityOidcCredential(input: {
    identityPrincipalId: string;
    providerConnectionId: string;
    accessTokenEncrypted: string;
    refreshTokenEncrypted: string | null;
    scope: string;
    accessTokenExpiresAt: Date | null;
  }): Promise<IdentityOidcCredential>;
  getIdentityOidcCredential(
    identityPrincipalId: string,
    providerConnectionId: string,
  ): Promise<IdentityOidcCredential | null>;
  rotateIdentityOidcCredential(input: {
    identityPrincipalId: string;
    providerConnectionId: string;
    expectedRotationSeq: number;
    accessTokenEncrypted: string;
    refreshTokenEncrypted: string | null;
    scope: string;
    accessTokenExpiresAt: Date | null;
  }): Promise<IdentityOidcCredential | null>;
  createIdentitySigningKey(input: {
    id?: string;
    algorithm: "ES256";
    publicJwk: Record<string, unknown>;
    privateKeyEncrypted: string;
    status: IdentitySigningKeyStatus;
    notBefore: Date;
    expiresAt: Date;
  }): Promise<IdentitySigningKey>;
  listIdentitySigningKeys(): Promise<IdentitySigningKey[]>;
  getActiveIdentitySigningKey(now?: Date): Promise<IdentitySigningKey | null>;
}

export interface SecretStore {
  listSecrets(projectId: string): Promise<PublicSecret[]>;
  upsertSecret(
    projectId: string,
    key: string,
    value: string,
    kind?: SecretRecord["kind"],
  ): Promise<PublicSecret>;
  upsertSecrets(
    projectId: string,
    entries: Array<{
      key: string;
      value: string;
      kind?: SecretRecord["kind"];
    }>,
  ): Promise<PublicSecret[]>;
  updateSecret(
    projectId: string,
    secretId: string,
    input: { key: string; kind: SecretRecord["kind"]; encryptedValue?: string },
  ): Promise<PublicSecret | null>;
  deleteSecret(projectId: string, secretId: string): Promise<boolean>;
  listSecretRecords(projectId: string): Promise<SecretRecord[]>;
  saveSharedAgentEnvironment(
    input: SaveSharedAgentEnvironmentInput,
  ): Promise<SharedAgentEnvironment>;
  getSharedAgentEnvironmentRecord(): Promise<SharedAgentEnvironmentRecord | null>;
}

export type EnqueueJobArguments<Type extends JobType> = Type extends JobType
  ? {} extends JobPayloadMap[Type]
    ? [type: Type, payload?: JobPayloadMap[Type]]
    : [type: Type, payload: JobPayloadMap[Type]]
  : never;

export interface JobStore {
  enqueueJob<Type extends JobType>(
    projectId: string,
    ...job: EnqueueJobArguments<Type>
  ): Promise<Job<Type>>;
  listProjectJobs(projectId: string, options?: { limit?: number }): Promise<Job[]>;
  listProjectJobs<Type extends JobType>(
    projectId: string,
    options: { type: Type; limit?: number },
  ): Promise<Job<Type>[]>;
  enqueueDeploymentArchive(
    projectId: string,
    deploymentId: string,
    options?: { automatic?: boolean },
  ): Promise<{ job: Job; created: boolean }>;
  enqueueDeploymentActivation(
    projectId: string,
    deploymentId: string,
    runtimeInstanceId: string,
    now?: Date,
    staleAfterMs?: number,
  ): Promise<Job>;
  /**
   * Claims the oldest claimable queued job. At most one job runs per project;
   * when `maxConcurrentHeavyJobs` is set, a HEAVY_JOB_TYPES candidate is
   * additionally claimable only while fewer heavy jobs than the cap are
   * running — light jobs skip past capped-out builds. Omitting the option
   * leaves heavy jobs uncapped.
   */
  claimNextJob(
    workerId: string,
    now?: Date,
    options?: { maxConcurrentHeavyJobs?: number },
  ): Promise<Job | null>;
  heartbeatJob(jobId: string, attempt: number, now?: Date): Promise<boolean>;
  replaceJobPayload<Type extends JobType>(
    jobId: string,
    type: Type,
    payload: JobPayloadMap[Type],
    attempt: number,
  ): Promise<boolean>;
  recoverStaleJobs(now?: Date, staleAfterMs?: number, limit?: number): Promise<number>;
  completeJob(jobId: string, attempt?: number): Promise<boolean>;
  failJob(jobId: string, error: string, attempt?: number): Promise<boolean>;
}

export interface DeploymentStore {
  recordDeployment(input: {
    releaseId?: string;
    deploymentId?: string;
    projectId: string;
    sourceRevisionId: string;
    imageTag: string;
    // Omitted records the release as legacy (null): its baked observer
    // predates the delivery contract. Real builds always pass the current
    // contract via ReleaseBuildResult.
    observerContract?: number;
    /**
     * Build-derived summary from eve's discovery manifest. Release-scoped
     * because the same immutable source revision can be rebuilt into releases
     * with different resolved dependencies; persisted here, with the release
     * row, so a failed start never leaves summary from a nonexistent release.
     */
    summary?: Record<string, unknown> | null;
    containerName: string;
    internalPort: number;
    hostPort: number;
    runtimeKind: RuntimeKind;
  }): Promise<DeploymentRecord>;
  getCurrentDeployment(projectId: string): Promise<DeploymentRecord | null>;
  listDeployments(projectId: string): Promise<DeploymentRecord[]>;
  listReservedDeploymentHostPorts(): Promise<number[]>;
  getDeployment(deploymentId: string): Promise<DeploymentRecord | null>;
  getDeploymentEveVersion(deploymentId: string): Promise<EveVersionInfo | null>;
  getDeploymentByContainerName(containerName: string): Promise<DeploymentRecord | null>;
  updateDeploymentStatus(
    deploymentId: string,
    status: DeploymentStatus,
  ): Promise<DeploymentRecord | null>;
  /**
   * Compare-and-set on a Deployment's status: writes `to` only while the row
   * still reads one of `from`, and returns null when it does not. Callers that
   * race the runtime sweepers use this instead of updateDeploymentStatus so
   * they can never overwrite a status that is no longer theirs to write.
   */
  transitionDeploymentStatus(input: {
    deploymentId: string;
    to: DeploymentStatus;
    from: DeploymentStatus[];
  }): Promise<DeploymentRecord | null>;
  getRelease(releaseId: string): Promise<ReleaseRecord | null>;
  /** Release id -> build summary (null when absent) for a whole project, in one query. */
  listReleaseSummaries(projectId: string): Promise<Record<string, Record<string, unknown> | null>>;
  getDeploymentRetention(
    projectId: string,
    keepRecent?: number,
    options?: DeploymentRetentionOptions,
  ): Promise<DeploymentRetention[]>;
}

export interface RoutingStore {
  ensureDeploymentRoutes(
    projectId: string,
    deploymentId: string,
    baseDomain: string,
  ): Promise<AgentRoute[]>;
  reconcileAgentRoutes(baseDomain: string): Promise<void>;
  findRouteByHostname(hostname: string): Promise<ResolvedAgentRoute | null>;
  findProjectRoute(projectId: string): Promise<ResolvedAgentRoute | null>;
  listProjectRoutes(projectId: string): Promise<ResolvedAgentRoute[]>;
  updateRouteTargets(
    routeId: string,
    targets: Array<Omit<RouteTarget, "routeId">>,
  ): Promise<ResolvedAgentRoute>;
  promoteDeployment(projectId: string, deploymentId: string): Promise<ResolvedAgentRoute>;
  ensureAliasRoute(
    projectId: string,
    alias: string,
    baseDomain: string,
    targets: Array<Omit<RouteTarget, "routeId">>,
  ): Promise<ResolvedAgentRoute>;
  findSessionBinding(projectId: string, eveSessionId: string): Promise<SessionBinding | null>;
  findSessionBindingByContinuationToken(
    projectId: string,
    continuationToken: string,
  ): Promise<SessionBinding | null>;
  bindSession(
    input: Omit<SessionBinding, "id" | "createdAt" | "updatedAt" | "continuationToken"> & {
      continuationToken?: string | null;
    },
  ): Promise<SessionBinding>;
  setSessionBindingContinuationToken(
    projectId: string,
    eveSessionId: string,
    continuationToken: string | null,
    now?: Date,
  ): Promise<SessionBinding | null>;
  touchSessionBinding(
    projectId: string,
    eveSessionId: string,
    now?: Date,
  ): Promise<SessionBinding | null>;
}

export interface SessionStore {
  createSession(input: {
    projectId: string;
    deploymentId?: string | null;
    trigger: SessionTrigger;
    scheduleId?: string | null;
    eveSessionId?: string | null;
    continuationToken?: string | null;
  }): Promise<Session>;
  getSessionByEveSessionId(projectId: string, eveSessionId: string): Promise<Session | null>;
  appendSessionEvent(sessionId: string, type: string, payload: unknown): Promise<SessionEvent>;
  recordModelUsage(
    sessionId: string,
    usage: ModelStepUsage & {
      eveSessionId?: string;
      agentId?: string | null;
      agentName?: string | null;
    },
  ): Promise<ModelUsageEvent>;
  completeSession(
    sessionId: string,
    input: {
      status: SessionStatus;
      eveSessionId?: string | null;
      continuationToken?: string | null;
    },
  ): Promise<Session | null>;
  listSessions(projectId: string): Promise<Session[]>;
  getSession(sessionId: string): Promise<Session | null>;
  listSessionsPage(
    projectId: string,
    input: {
      trigger?: SessionTrigger;
      scheduleId?: string;
      scheduleRunId?: string;
      unlinkedOnly?: boolean;
      cursor?: string;
      limit: number;
    },
  ): Promise<CursorPage<Session>>;
  listSessionEvents(sessionId: string): Promise<SessionEvent[]>;
  listSessionNodes(sessionId: string): Promise<SessionNode[]>;
  ingestAgentEvent(
    observation: AgentEventObservation,
  ): Promise<{ session: Session; node: SessionNode; event: SessionEvent; duplicate: boolean }>;
  listModelUsageEvents(sessionId: string): Promise<ModelUsageEvent[]>;
  failRunningSessionsForRuntimeInstance(
    runtimeInstanceId: string,
    reason: string,
    now?: Date,
  ): Promise<number>;
}

export interface UsageStore {
  /**
   * Per-variant rollup for a Project's experiment view. Aggregated in SQL:
   * the route used to fold every Session the Project had ever recorded.
   */
  getVariantMetrics(projectId: string): Promise<
    Array<{
      deploymentId: string | null;
      experimentId: string | null;
      variantName: string;
      sessions: number;
      success: number;
      failure: number;
      tokens: number;
      costUsd: number;
      averageLatencyMs: number;
    }>
  >;
  getUsageAnalytics(input: {
    range: UsageRange;
    projectId?: string;
    modelId?: string;
    now?: Date;
  }): Promise<UsageAnalytics>;
}

export interface ScheduleStore {
  listSchedules(projectId: string): Promise<ScheduleRecord[]>;
  recordScheduleVersions(input: {
    projectId: string;
    sourceRevisionId: string;
    definitions: Array<{
      key: string;
      kind: ScheduleVersion["kind"];
      cron: string;
      sourcePath: string;
      definitionHash: string;
    }>;
  }): Promise<ProjectScheduleVersion[]>;
  listProjectScheduleVersions(
    projectId: string,
    sourceRevisionId: string,
  ): Promise<ProjectScheduleVersion[]>;
  listProjectScheduleSummaries(projectId: string): Promise<ProjectScheduleSummary[]>;
  getProjectSchedule(scheduleId: string): Promise<ProjectSchedule | null>;
  setProjectSchedulerTarget(
    projectId: string,
    deploymentId: string,
    now?: Date,
  ): Promise<ProjectSchedulerTarget>;
  listUpcomingScheduleTargets(input: {
    after: Date;
    before: Date;
    limit: number;
  }): Promise<
    Array<{ scheduleId: string; projectId: string; deploymentId: string; nextRunAt: string }>
  >;
  createManualScheduleRun(projectId: string, scheduleId: string, now?: Date): Promise<ScheduleRun>;
  claimDueScheduleRuns(input: { now: Date; limit: number }): Promise<ScheduleRun[]>;
  getScheduleRun(scheduleRunId: string): Promise<ScheduleRun | null>;
  listScheduleRuns(
    projectId: string,
    input: {
      scheduleId?: string;
      trigger?: ScheduleRun["trigger"];
      status?: ScheduleRun["status"];
      cursor?: string;
      limit: number;
    },
  ): Promise<CursorPage<ScheduleRunListItem>>;
  getScheduleRunDetail(scheduleRunId: string): Promise<ScheduleRunDetail | null>;
  claimScheduleRunActivation(
    scheduleRunId: string,
    now?: Date,
    staleAfterMs?: number,
  ): Promise<ScheduleRun | null>;
  redeemScheduleRunDispatch(
    scheduleRunId: string,
    deploymentId: string,
  ): Promise<ScheduleRun | null>;
  completeScheduleRun(
    scheduleRunId: string,
    input: {
      status: "succeeded" | "failed" | "dispatch_unknown";
      error?: string | null;
      eveSessionIds?: string[];
    },
  ): Promise<ScheduleRun | null>;
  failScheduleExecutionsForRuntimeInstance(
    runtimeInstanceId: string,
    reason: string,
    now?: Date,
  ): Promise<number>;
  failExpiredScheduleExecutions(now: Date, limit: number): Promise<number>;
}

export interface RuntimeStore {
  acquireActivationLease(input: {
    deploymentId: string;
    kind: ActivationLeaseKind;
    ownerId: string;
    expiresAt: Date;
    now?: Date;
  }): Promise<ActivationLeaseClaim>;
  getRuntimeInstance(runtimeInstanceId: string): Promise<RuntimeInstance | null>;
  listRuntimeInstances(
    statuses: RuntimeInstanceStatus[],
    limit: number,
  ): Promise<RuntimeInstance[]>;
  listDeploymentRuntimeInstances(deploymentId: string): Promise<RuntimeInstance[]>;
  /**
   * Brings an already-running but unmanaged host process under RuntimeInstance
   * lifecycle management. Returns null when an active instance already owns it.
   */
  adoptRuntimeInstance(
    deploymentId: string,
    endpoint: { endpointHost: string; endpointPort: number },
    now?: Date,
  ): Promise<RuntimeInstance | null>;
  updateRuntimeInstance(
    runtimeInstanceId: string,
    input: {
      status: RuntimeInstanceStatus;
      endpointHost?: string | null;
      endpointPort?: number | null;
      error?: string | null;
    },
    now?: Date,
  ): Promise<RuntimeInstance | null>;
  /**
   * Claims a loopback port for a starting RuntimeInstance before the process
   * binds it. Returns false when another live instance already holds the port
   * (the live-port unique index rejected it); the caller tries the next
   * candidate. Leaving the live statuses releases the claim automatically.
   */
  reserveRuntimeInstancePort(runtimeInstanceId: string, port: number): Promise<boolean>;
  getActivationLease(leaseId: string): Promise<ActivationLease | null>;
  renewActivationLease(
    leaseId: string,
    expiresAt: Date,
    now?: Date,
  ): Promise<ActivationLease | null>;
  releaseActivationLease(leaseId: string, now?: Date): Promise<ActivationLease | null>;
  hasActiveActivationLeases(deploymentId: string, now?: Date): Promise<boolean>;
  claimIdleRuntimeInstances(input: {
    now: Date;
    idleTtlMs: number;
    schedulePrewarmMs?: number;
    limit: number;
  }): Promise<RuntimeInstance[]>;
}

export interface LogStore {
  appendLog(input: {
    projectId: string;
    deploymentId?: string | null;
    type: LogRecord["type"];
    line: string;
  }): Promise<LogRecord>;
  listLogs(projectId: string, type?: LogRecord["type"]): Promise<LogRecord[]>;
}

export interface InstanceHealthStore {
  upsertWorkerHeartbeat(heartbeat: WorkerHeartbeat): Promise<WorkerHeartbeat>;
  listWorkerHeartbeats(): Promise<WorkerHeartbeat[]>;
  recordHostMetric(sample: Omit<HostMetricSample, "id">): Promise<HostMetricSample>;
  listHostMetrics(input: {
    workerId?: string;
    since?: Date;
    limit: number;
  }): Promise<HostMetricSample[]>;
  pruneHostMetrics(before: Date): Promise<number>;
  /**
   * The worker's heavy-job cap is not persisted with jobs — the health report
   * overlays it from the freshest WorkerHeartbeat.
   */
  getInstanceWorkload(): Promise<Omit<InstanceWorkload, "maxConcurrentHeavyJobs">>;
}

export interface ObservabilityStore {
  getObservabilityPolicy(teamId: string): Promise<ObservabilityPolicy>;
  saveObservabilityPolicy(input: {
    teamId: string;
    expectedRevision: number;
    agentCapture: AgentCapturePolicy;
    externalDestinations: ExternalObservabilityDestination[];
  }): Promise<ObservabilityPolicy | null>;
  listExternalObservabilityDestinationHealth(): Promise<ExternalDestinationHealth[]>;
  upsertExternalObservabilityDestinationHealth(
    health: ExternalDestinationHealth,
  ): Promise<ExternalDestinationHealth>;
  /**
   * Records a batch receipt. `duplicate: true` means the Collector redelivered a
   * batch it had already sent, and the caller must skip accumulation.
   */
  ingestOtlpBatch(input: {
    signal: ObservabilitySignal;
    payload: Record<string, unknown>;
  }): Promise<{
    id: string;
    accepted: true;
    duplicate: boolean;
  }>;
  latestOtlpBatchReceivedAt(input?: { signal?: ObservabilitySignal }): Promise<string | null>;
  pruneOtlpTelemetry(input: { receiptsBefore: Date }): Promise<{ receipts: number }>;
  pruneDerivedAgentTelemetry(before: Date): Promise<{
    sessions: number;
    nodes: number;
    events: number;
    usageEvents: number;
  }>;
}

export type Store = ProjectStore &
  CatalogStore &
  SourceStore &
  GitCredentialStore &
  AgentAuthStore &
  IdentityStore &
  SecretStore &
  JobStore &
  DeploymentStore &
  RoutingStore &
  SessionStore &
  UsageStore &
  ScheduleStore &
  RuntimeStore &
  InstanceHealthStore &
  ObservabilityStore &
  LogStore;
