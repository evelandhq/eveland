import { claimDeploymentKey, claimProjectSlug, createId, slugifyProjectName } from "@eveland/core/ids";
import type {
  AgentRoute,
  Job,
  JobType,
  Project,
  ProjectImportKind,
  ProjectStatus,
  PublicSecret,
  DeploymentRecord,
  ReleaseRecord,
  RuntimeKind,
  ScheduleRecord,
  SecretRecord,
  Session,
  SessionEvent,
  SessionStatus,
  SessionTrigger,
  ModelUsageEvent,
  LogRecord,
  DeploymentStatus,
  SourceRevision,
  SourceFileRecord,
  SessionNode,
  ResolvedAgentRoute,
  RouteTarget,
  SessionBinding,
  ProjectSchedule,
  ScheduleVersion,
  ProjectScheduleVersion,
  ProjectScheduleSummary,
  ProjectSchedulerTarget,
  ScheduleRun,
  ScheduleRunDetail,
  ScheduleRunListItem,
  CursorPage,
  RuntimeInstance,
  RuntimeInstanceStatus,
  ActivationLease,
  ActivationLeaseClaim,
  ActivationLeaseKind,
  GitCredentialRecord,
  PublicGitCredential,
  SourcePreflight,
  SourcePreflightRecord,
} from "@eveland/core/contracts";
import { parseStepUsageEvent, type ModelStepUsage } from "@eveland/core/eve";
import { ObserverEnvelopeRejectedError, type ObserverEnvelopeV1 } from "@eveland/core/observer";
import { validateRouteTargets } from "@eveland/core/routing";
import { getNextRunAt } from "@eveland/core/schedules";
import { createEveVersionInfo, readDeclaredEveVersion, type EveVersionInfo } from "@eveland/core/source";
import { summarizeSessionUsage } from "./session-usage.js";

export type DeploymentRetention = {
  deployment: DeploymentRecord;
  protected: boolean;
  reasons: Array<"route_target" | "active_session" | "recent_artifact">;
};

export class RuntimeInstanceDrainingError extends Error {
  constructor() {
    super("RuntimeInstance is draining; retry activation after it stops.");
    this.name = "RuntimeInstanceDrainingError";
  }
}

export class ProjectSlugConflictError extends Error {
  constructor() {
    super("Project name is already in use.");
    this.name = "ProjectSlugConflictError";
  }
}

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

export type ProjectDeletionRequest =
  | { outcome: "queued"; job: Job }
  | { outcome: "not_found" }
  | { outcome: "already_deleting" };

export function projectDeletionSourcePaths(payloads: unknown[]): string[] {
  const paths = new Set<string>();
  for (const payload of payloads) {
    if (typeof payload !== "object" || payload === null) continue;
    const input = payload as { sourcePath?: unknown; sourcePaths?: unknown };
    if (typeof input.sourcePath === "string") paths.add(input.sourcePath);
    if (Array.isArray(input.sourcePaths)) {
      for (const sourcePath of input.sourcePaths) {
        if (typeof sourcePath === "string") paths.add(sourcePath);
      }
    }
  }
  return [...paths];
}

export const DEFAULT_TEAM_ID = "team_local";

export type Store = {
  listProjects(): Promise<Project[]>;
  isProjectSlugAvailable(slug: string): Promise<boolean>;
  createProject(input: CreateProjectInput): Promise<Project>;
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
  }): Promise<CreateProjectFromSourcePreflightResult>;
  expireSourcePreflights(now?: Date, limit?: number): Promise<string[]>;
  getProject(projectId: string): Promise<Project | null>;
  listGitCredentials(userId: string): Promise<PublicGitCredential[]>;
  getGitCredential(userId: string, host: string): Promise<GitCredentialRecord | null>;
  upsertGitCredential(userId: string, host: string, encryptedToken: string): Promise<GitCredentialRecord>;
  deleteGitCredential(userId: string, credentialId: string): Promise<boolean>;
  requestProjectDeletion(projectId: string): Promise<ProjectDeletionRequest>;
  setProjectDeletionFailed(projectId: string, error: string): Promise<Project | null>;
  deleteProject(projectId: string): Promise<boolean>;
  listSecrets(projectId: string): Promise<PublicSecret[]>;
  upsertSecret(projectId: string, key: string, value: string): Promise<PublicSecret>;
  deleteSecret(projectId: string, secretId: string): Promise<boolean>;
  listSecretRecords(projectId: string): Promise<SecretRecord[]>;
  enqueueJob(projectId: string, type: JobType, payload?: Record<string, unknown>): Promise<Job>;
  listProjectJobs(projectId: string, options?: { type?: JobType; limit?: number }): Promise<Job[]>;
  enqueueDeploymentActivation(
    projectId: string,
    deploymentId: string,
    runtimeInstanceId: string,
    now?: Date,
    staleAfterMs?: number,
  ): Promise<Job>;
  claimNextJob(workerId: string, now?: Date): Promise<Job | null>;
  heartbeatJob(jobId: string, attempt: number, now?: Date): Promise<boolean>;
  replaceJobPayload(jobId: string, payload: Record<string, unknown>, attempt: number): Promise<boolean>;
  recoverStaleJobs(now?: Date, staleAfterMs?: number, limit?: number): Promise<number>;
  completeJob(jobId: string, attempt?: number): Promise<boolean>;
  failJob(jobId: string, error: string, attempt?: number): Promise<boolean>;
  updateProjectState(projectId: string, state: { status?: ProjectStatus; deploymentStatus?: DeploymentStatus }): Promise<Project | null>;
  appendLog(input: { projectId: string; deploymentId?: string | null; type: LogRecord["type"]; line: string }): Promise<LogRecord>;
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
  listSourceFiles(projectId: string): Promise<SourceFileRecord[]>;
  getSourceFile(projectId: string, filePath: string): Promise<SourceFileRecord | null>;
  recordDeployment(input: {
    releaseId?: string;
    deploymentId?: string;
    projectId: string;
    sourceRevisionId: string;
    imageTag: string;
    containerName: string;
    internalPort: number;
    hostPort: number;
    runtimeKind: RuntimeKind;
  }): Promise<DeploymentRecord>;
  getCurrentDeployment(projectId: string): Promise<DeploymentRecord | null>;
  listDeployments(projectId: string): Promise<DeploymentRecord[]>;
  getDeployment(deploymentId: string): Promise<DeploymentRecord | null>;
  getDeploymentEveVersion(deploymentId: string): Promise<EveVersionInfo | null>;
  getDeploymentByContainerName(containerName: string): Promise<DeploymentRecord | null>;
  updateDeploymentStatus(deploymentId: string, status: DeploymentStatus): Promise<DeploymentRecord | null>;
  getRelease(releaseId: string): Promise<ReleaseRecord | null>;
  ensureDeploymentRoutes(projectId: string, deploymentId: string, baseDomain: string): Promise<AgentRoute[]>;
  reconcileAgentRoutes(baseDomain: string): Promise<void>;
  findRouteByHostname(hostname: string): Promise<ResolvedAgentRoute | null>;
  findProjectRoute(projectId: string): Promise<ResolvedAgentRoute | null>;
  listProjectRoutes(projectId: string): Promise<ResolvedAgentRoute[]>;
  updateRouteTargets(routeId: string, targets: Array<Omit<RouteTarget, "routeId">>): Promise<ResolvedAgentRoute>;
  promoteDeployment(projectId: string, deploymentId: string): Promise<ResolvedAgentRoute>;
  ensureAliasRoute(
    projectId: string,
    alias: string,
    baseDomain: string,
    targets: Array<Omit<RouteTarget, "routeId">>,
  ): Promise<ResolvedAgentRoute>;
  getDeploymentRetention(projectId: string, keepRecent?: number): Promise<DeploymentRetention[]>;
  findSessionBinding(projectId: string, eveSessionId: string): Promise<SessionBinding | null>;
  bindSession(input: Omit<SessionBinding, "id" | "createdAt" | "updatedAt">): Promise<SessionBinding>;
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
    usage: ModelStepUsage & { eveSessionId?: string; agentId?: string | null; agentName?: string | null },
  ): Promise<ModelUsageEvent>;
  completeSession(
    sessionId: string,
    input: { status: SessionStatus; eveSessionId?: string | null; continuationToken?: string | null },
  ): Promise<Session | null>;
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
  listProjectScheduleVersions(projectId: string, sourceRevisionId: string): Promise<ProjectScheduleVersion[]>;
  listProjectScheduleSummaries(projectId: string): Promise<ProjectScheduleSummary[]>;
  getProjectSchedule(scheduleId: string): Promise<ProjectSchedule | null>;
  setProjectSchedulerTarget(projectId: string, deploymentId: string, now?: Date): Promise<ProjectSchedulerTarget>;
  listUpcomingScheduleTargets(input: {
    after: Date;
    before: Date;
    limit: number;
  }): Promise<Array<{ scheduleId: string; projectId: string; deploymentId: string; nextRunAt: string }>>;
  createManualScheduleRun(projectId: string, scheduleId: string, now?: Date): Promise<ScheduleRun>;
  claimDueScheduleRuns(input: { now: Date; limit: number }): Promise<ScheduleRun[]>;
  getScheduleRun(scheduleRunId: string): Promise<ScheduleRun | null>;
  listScheduleRuns(
    projectId: string,
    input: { scheduleId?: string; trigger?: ScheduleRun["trigger"]; status?: ScheduleRun["status"]; cursor?: string; limit: number },
  ): Promise<CursorPage<ScheduleRunListItem>>;
  getScheduleRunDetail(scheduleRunId: string): Promise<ScheduleRunDetail | null>;
  claimScheduleRunActivation(scheduleRunId: string, now?: Date, staleAfterMs?: number): Promise<ScheduleRun | null>;
  redeemScheduleRunDispatch(scheduleRunId: string, deploymentId: string): Promise<ScheduleRun | null>;
  completeScheduleRun(
    scheduleRunId: string,
    input: { status: "succeeded" | "failed" | "dispatch_unknown"; error?: string | null; eveSessionIds?: string[] },
  ): Promise<ScheduleRun | null>;
  acquireActivationLease(input: {
    deploymentId: string;
    kind: ActivationLeaseKind;
    ownerId: string;
    expiresAt: Date;
    now?: Date;
  }): Promise<ActivationLeaseClaim>;
  getRuntimeInstance(runtimeInstanceId: string): Promise<RuntimeInstance | null>;
  listRuntimeInstances(statuses: RuntimeInstanceStatus[], limit: number): Promise<RuntimeInstance[]>;
  listDeploymentRuntimeInstances(deploymentId: string): Promise<RuntimeInstance[]>;
  /**
   * Brings an already-running but unmanaged host process under RuntimeInstance
   * lifecycle management (orphan sweep). Creates a ready instance only when the
   * deployment has no starting/ready/draining instance; returns null otherwise
   * so callers never disturb an instance the activation or idle-reap flow owns.
   */
  adoptRuntimeInstance(
    deploymentId: string,
    endpoint: { endpointHost: string; endpointPort: number },
    now?: Date,
  ): Promise<RuntimeInstance | null>;
  updateRuntimeInstance(
    runtimeInstanceId: string,
    input: { status: RuntimeInstanceStatus; endpointHost?: string | null; endpointPort?: number | null; error?: string | null },
    now?: Date,
  ): Promise<RuntimeInstance | null>;
  getActivationLease(leaseId: string): Promise<ActivationLease | null>;
  renewActivationLease(leaseId: string, expiresAt: Date, now?: Date): Promise<ActivationLease | null>;
  releaseActivationLease(leaseId: string, now?: Date): Promise<ActivationLease | null>;
  hasActiveActivationLeases(deploymentId: string, now?: Date): Promise<boolean>;
  claimIdleRuntimeInstances(input: {
    now: Date;
    idleTtlMs: number;
    schedulePrewarmMs?: number;
    limit: number;
  }): Promise<RuntimeInstance[]>;
  listSessions(projectId: string): Promise<Session[]>;
  getSession(sessionId: string): Promise<Session | null>;
  listSessionsPage(
    projectId: string,
    input: { trigger?: SessionTrigger; scheduleId?: string; scheduleRunId?: string; unlinkedOnly?: boolean; cursor?: string; limit: number },
  ): Promise<CursorPage<Session>>;
  listSessionEvents(sessionId: string): Promise<SessionEvent[]>;
  listSessionNodes(sessionId: string): Promise<SessionNode[]>;
  ingestObserverEnvelope(envelope: ObserverEnvelopeV1): Promise<{ session: Session; node: SessionNode; event: SessionEvent; duplicate: boolean }>;
  listModelUsageEvents(sessionId: string): Promise<ModelUsageEvent[]>;
  listLogs(projectId: string, type?: LogRecord["type"]): Promise<LogRecord[]>;
};

export type StoreState = MemoryState;

type MemoryState = {
  projects: Project[];
  gitCredentials: GitCredentialRecord[];
  sourcePreflights: SourcePreflightRecord[];
  secrets: SecretRecord[];
  jobs: Job[];
  schedules: ScheduleRecord[];
  sessions: Session[];
  sessionNodes: SessionNode[];
  sessionEvents: SessionEvent[];
  modelUsageEvents: ModelUsageEvent[];
  logs: LogRecord[];
  sourceRevisions: SourceRevision[];
  sourceFiles: SourceFileRecord[];
  releases: ReleaseRecord[];
  deployments: DeploymentRecord[];
  agentRoutes: AgentRoute[];
  routeTargets: RouteTarget[];
  sessionBindings: SessionBinding[];
  projectSchedules: ProjectSchedule[];
  scheduleVersions: ScheduleVersion[];
  projectSchedulerTargets: ProjectSchedulerTarget[];
  scheduleRuns: ScheduleRun[];
  runtimeInstances: RuntimeInstance[];
  activationLeases: ActivationLease[];
};

export function createMemoryStore(initialState?: Partial<MemoryState>): Store {
  const state: MemoryState = {
    projects: initialState?.projects ?? [],
    gitCredentials: initialState?.gitCredentials ?? [],
    sourcePreflights: initialState?.sourcePreflights ?? [],
    secrets: initialState?.secrets ?? [],
    jobs: initialState?.jobs ?? [],
    schedules: initialState?.schedules ?? [],
    sessions: initialState?.sessions ?? [],
    sessionNodes: initialState?.sessionNodes ?? [],
    sessionEvents: initialState?.sessionEvents ?? [],
    modelUsageEvents: initialState?.modelUsageEvents ?? [],
    logs: initialState?.logs ?? [],
    sourceRevisions: initialState?.sourceRevisions ?? [],
    sourceFiles: initialState?.sourceFiles ?? [],
    releases: initialState?.releases ?? [],
    deployments: initialState?.deployments ?? [],
    agentRoutes: initialState?.agentRoutes ?? [],
    routeTargets: initialState?.routeTargets ?? [],
    sessionBindings: initialState?.sessionBindings ?? [],
    projectSchedules: initialState?.projectSchedules ?? [],
    scheduleVersions: initialState?.scheduleVersions ?? [],
    projectSchedulerTargets: initialState?.projectSchedulerTargets ?? [],
    scheduleRuns: initialState?.scheduleRuns ?? [],
    runtimeInstances: initialState?.runtimeInstances ?? [],
    activationLeases: initialState?.activationLeases ?? [],
  };

  return {
    async listProjects() {
      return [...state.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async isProjectSlugAvailable(slug) {
      return !state.projects.some((project) => project.slug === slug);
    },

    async createProject(input) {
      const now = new Date().toISOString();
      if (input.requireExactSlug && state.projects.some((candidate) => candidate.slug === slugifyProjectName(input.name))) {
        throw new ProjectSlugConflictError();
      }
      const project = await claimProjectSlug(input.name, async (slug) => {
        if (state.projects.some((candidate) => candidate.slug === slug)) return null;
        const claimed: Project = {
          id: createId("proj"),
          slug,
          name: slug,
          importKind: input.importKind,
          gitUrl: input.gitUrl ?? null,
          status: "import_pending",
          deploymentStatus: "not_deployed",
          deletionStatus: null,
          deletionError: null,
          sourceRevisionId: null,
          releaseId: null,
          deploymentId: null,
          latestSessionStatus: null,
          nextScheduleAt: null,
          createdAt: now,
          updatedAt: now,
        };
        state.projects.push(claimed);
        return claimed;
      }, input.requireExactSlug ? { maxAttempts: 1 } : undefined).catch((error: unknown) => {
        if (input.requireExactSlug && error instanceof Error && error.message.startsWith("Failed to claim a unique project slug")) {
          throw new ProjectSlugConflictError();
        }
        throw error;
      });
      state.jobs.push(createJob(project.id, "import_source", {
        importKind: input.importKind,
        gitUrl: input.gitUrl ?? null,
        sourcePath: input.sourcePath ?? null,
        ...(input.deployAfterImport ? { deployAfterImport: true } : {}),
        ...(input.gitCredential ? { gitCredential: input.gitCredential } : {}),
      }));
      return project;
    },

    async createSourcePreflight(input) {
      const now = new Date().toISOString();
      const preflight: SourcePreflightRecord = {
        id: createId("pre"),
        userId: input.userId,
        kind: input.kind,
        gitUrl: input.gitUrl ?? null,
        sourcePath: input.sourcePath ?? null,
        commitSha: null,
        status: "queued",
        summary: null,
        error: null,
        attempts: 0,
        lockedAt: null,
        gitCredential: input.gitCredential ?? null,
        expiresAt: input.expiresAt.toISOString(),
        createdAt: now,
        updatedAt: now,
      };
      state.sourcePreflights.push(preflight);
      return toPublicSourcePreflight(preflight);
    },

    async getSourcePreflight(preflightId, userId) {
      const preflight = state.sourcePreflights.find(
        (candidate) => candidate.id === preflightId && candidate.userId === userId,
      );
      return preflight ? toPublicSourcePreflight(preflight) : null;
    },

    async claimNextSourcePreflight(_workerId, now = new Date()) {
      const preflight = state.sourcePreflights
        .filter((candidate) => candidate.status === "queued" && Date.parse(candidate.expiresAt) > now.getTime())
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!preflight) return null;
      preflight.status = "running";
      preflight.attempts += 1;
      preflight.lockedAt = now.toISOString();
      preflight.updatedAt = now.toISOString();
      return structuredClone(preflight);
    },

    async heartbeatSourcePreflight(preflightId, attempt, now = new Date()) {
      const preflight = state.sourcePreflights.find(
        (candidate) => candidate.id === preflightId && candidate.status === "running" && candidate.attempts === attempt,
      );
      if (!preflight) return false;
      preflight.lockedAt = now.toISOString();
      preflight.updatedAt = now.toISOString();
      return true;
    },

    async recoverStaleSourcePreflights(now = new Date(), staleAfterMs = 300_000, limit = 25) {
      const cutoff = now.getTime() - staleAfterMs;
      const stale = state.sourcePreflights
        .filter((candidate) => candidate.status === "running" && candidate.lockedAt && Date.parse(candidate.lockedAt) <= cutoff)
        .sort((a, b) => (a.lockedAt ?? "").localeCompare(b.lockedAt ?? ""))
        .slice(0, limit);
      for (const preflight of stale) {
        preflight.status = "queued";
        preflight.lockedAt = null;
        preflight.updatedAt = now.toISOString();
      }
      return stale.length;
    },

    async completeSourcePreflight(preflightId, attempt, result) {
      const preflight = state.sourcePreflights.find(
        (candidate) => candidate.id === preflightId && candidate.status === "running" && candidate.attempts === attempt,
      );
      if (!preflight) return false;
      preflight.status = "completed";
      preflight.sourcePath = result.sourcePath;
      preflight.commitSha = result.commitSha;
      preflight.summary = result.summary;
      preflight.error = null;
      preflight.lockedAt = null;
      preflight.updatedAt = new Date().toISOString();
      return true;
    },

    async failSourcePreflight(preflightId, attempt, error) {
      const preflight = state.sourcePreflights.find(
        (candidate) => candidate.id === preflightId && candidate.status === "running" && candidate.attempts === attempt,
      );
      if (!preflight) return false;
      preflight.status = "failed";
      preflight.error = error;
      preflight.lockedAt = null;
      preflight.gitCredential = null;
      preflight.updatedAt = new Date().toISOString();
      return true;
    },

    async createProjectFromSourcePreflight(input) {
      const preflight = state.sourcePreflights.find(
        (candidate) => candidate.id === input.preflightId && candidate.userId === input.userId,
      );
      if (!preflight) return { outcome: "not_found" };
      if (preflight.status === "consumed") return { outcome: "consumed" };
      if (
        preflight.status !== "completed"
        || !preflight.sourcePath
        || Date.parse(preflight.expiresAt) <= Date.now()
      ) return { outcome: "not_ready" };

      const slug = slugifyProjectName(input.name);
      if (state.projects.some((candidate) => candidate.slug === slug)) throw new ProjectSlugConflictError();
      const now = new Date().toISOString();
      const project: Project = {
        id: createId("proj"),
        slug,
        name: slug,
        importKind: preflight.kind,
        gitUrl: preflight.gitUrl,
        status: "import_pending",
        deploymentStatus: "not_deployed",
        deletionStatus: null,
        deletionError: null,
        sourceRevisionId: null,
        releaseId: null,
        deploymentId: null,
        latestSessionStatus: null,
        nextScheduleAt: null,
        createdAt: now,
        updatedAt: now,
      };
      state.projects.push(project);
      state.jobs.push(createJob(project.id, "import_source", {
        importKind: preflight.kind,
        gitUrl: preflight.gitUrl,
        sourcePath: preflight.sourcePath,
        ...(input.deployAfterImport ? { deployAfterImport: true } : {}),
        ...(preflight.gitCredential ? { gitCredential: preflight.gitCredential } : {}),
      }));
      preflight.status = "consumed";
      preflight.gitCredential = null;
      preflight.updatedAt = now;
      return { outcome: "created", project };
    },

    async expireSourcePreflights(now = new Date(), limit = 25) {
      const expired = state.sourcePreflights
        .filter((candidate) => candidate.status !== "running" && Date.parse(candidate.expiresAt) <= now.getTime())
        .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
        .slice(0, limit);
      const ids = new Set(expired.map((candidate) => candidate.id));
      state.sourcePreflights = state.sourcePreflights.filter((candidate) => !ids.has(candidate.id));
      return [...new Set(expired.flatMap((candidate) =>
        candidate.status !== "consumed" && candidate.sourcePath ? [candidate.sourcePath] : [],
      ))];
    },

    async getProject(projectId) {
      return state.projects.find((project) => project.id === projectId) ?? null;
    },

    async listGitCredentials(userId) {
      return state.gitCredentials
        .filter((credential) => credential.userId === userId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(toPublicGitCredential);
    },

    async getGitCredential(userId, host) {
      return state.gitCredentials.find((credential) => credential.userId === userId && credential.host === host) ?? null;
    },

    async upsertGitCredential(userId, host, encryptedToken) {
      const existing = state.gitCredentials.find(
        (credential) => credential.userId === userId && credential.host === host,
      );
      const now = new Date().toISOString();
      if (existing) {
        existing.encryptedToken = encryptedToken;
        existing.updatedAt = now;
        return existing;
      }
      const credential: GitCredentialRecord = {
        id: createId("gitcred"),
        userId,
        host,
        encryptedToken,
        createdAt: now,
        updatedAt: now,
      };
      state.gitCredentials.push(credential);
      return credential;
    },

    async deleteGitCredential(userId, credentialId) {
      const before = state.gitCredentials.length;
      state.gitCredentials = state.gitCredentials.filter(
        (credential) => credential.userId !== userId || credential.id !== credentialId,
      );
      return state.gitCredentials.length !== before;
    },

    async requestProjectDeletion(projectId) {
      const project = state.projects.find((candidate) => candidate.id === projectId);
      if (!project) return { outcome: "not_found" };
      if (project.deletionStatus === "deleting") return { outcome: "already_deleting" };

      const sourcePaths = projectDeletionSourcePaths(
        state.jobs
          .filter((job) => job.projectId === projectId && (job.status === "queued" || job.type === "delete_project"))
          .map((job) => job.payload),
      );
      state.jobs = state.jobs.filter((job) => job.projectId !== projectId || job.status !== "queued");
      project.deletionStatus = "deleting";
      project.deletionError = null;
      project.updatedAt = new Date().toISOString();
      const job = createJob(projectId, "delete_project", { sourcePaths });
      state.jobs.push(job);
      return { outcome: "queued", job };
    },

    async setProjectDeletionFailed(projectId, error) {
      const project = state.projects.find((candidate) => candidate.id === projectId);
      if (!project) return null;
      project.deletionStatus = "failed";
      project.deletionError = error;
      project.updatedAt = new Date().toISOString();
      return project;
    },

    async deleteProject(projectId) {
      const before = state.projects.length;
      const sessionIds = state.sessions.filter((session) => session.projectId === projectId).map((session) => session.id);
      const revisionIds = state.sourceRevisions.filter((revision) => revision.projectId === projectId).map((revision) => revision.id);

      // Mirrors the Postgres store's cascade order (db/postgres-store.ts
      // deleteProject): logs, deployments, releases, source files scoped to
      // this project's revisions, the revisions themselves, usage events and
      // session events scoped to this project's sessions, the sessions, then
      // schedules/jobs/secrets, and the projects row last.
      state.logs = state.logs.filter((log) => log.projectId !== projectId);
      const routeIds = state.agentRoutes.filter((route) => route.projectId === projectId).map((route) => route.id);
      state.routeTargets = state.routeTargets.filter((target) => !routeIds.includes(target.routeId));
      state.agentRoutes = state.agentRoutes.filter((route) => route.projectId !== projectId);
      state.sessionBindings = state.sessionBindings.filter((binding) => binding.projectId !== projectId);
      const projectScheduleIds = state.projectSchedules
        .filter((schedule) => schedule.projectId === projectId)
        .map((schedule) => schedule.id);
      state.scheduleRuns = state.scheduleRuns.filter((run) => !projectScheduleIds.includes(run.scheduleId));
      state.scheduleVersions = state.scheduleVersions.filter((version) => !projectScheduleIds.includes(version.scheduleId));
      state.projectSchedulerTargets = state.projectSchedulerTargets.filter((target) => target.projectId !== projectId);
      state.projectSchedules = state.projectSchedules.filter((schedule) => schedule.projectId !== projectId);
      const deploymentIds = state.deployments
        .filter((deployment) => deployment.projectId === projectId)
        .map((deployment) => deployment.id);
      state.activationLeases = state.activationLeases.filter((lease) => !deploymentIds.includes(lease.deploymentId));
      state.runtimeInstances = state.runtimeInstances.filter((instance) => !deploymentIds.includes(instance.deploymentId));
      state.deployments = state.deployments.filter((deployment) => deployment.projectId !== projectId);
      state.releases = state.releases.filter((release) => release.projectId !== projectId);
      state.sourceFiles = state.sourceFiles.filter((file) => !revisionIds.includes(file.revisionId));
      state.sourceRevisions = state.sourceRevisions.filter((revision) => revision.projectId !== projectId);
      state.modelUsageEvents = state.modelUsageEvents.filter((event) => !sessionIds.includes(event.sessionId));
      state.sessionEvents = state.sessionEvents.filter((event) => !sessionIds.includes(event.sessionId));
      state.sessionNodes = state.sessionNodes.filter((node) => node.projectId !== projectId);
      state.sessions = state.sessions.filter((session) => session.projectId !== projectId);
      state.schedules = state.schedules.filter((schedule) => schedule.projectId !== projectId);
      state.jobs = state.jobs.filter((job) => job.projectId !== projectId);
      state.secrets = state.secrets.filter((secret) => secret.projectId !== projectId);
      state.projects = state.projects.filter((project) => project.id !== projectId);
      return state.projects.length !== before;
    },

    async listSecrets(projectId) {
      return state.secrets.filter((secret) => secret.projectId === projectId).map(toPublicSecret);
    },

    async upsertSecret(projectId, key, value) {
      const now = new Date().toISOString();
      const existing = state.secrets.find((secret) => secret.projectId === projectId && secret.key === key);

      if (existing) {
        existing.encryptedValue = value;
        existing.updatedAt = now;
        return toPublicSecret(existing);
      }

      const secret: SecretRecord = {
        id: createId("secret"),
        projectId,
        key,
        encryptedValue: value,
        createdAt: now,
        updatedAt: now,
      };
      state.secrets.push(secret);
      return toPublicSecret(secret);
    },

    async deleteSecret(projectId, secretId) {
      const before = state.secrets.length;
      state.secrets = state.secrets.filter((secret) => secret.projectId !== projectId || secret.id !== secretId);
      return state.secrets.length !== before;
    },

    async listSecretRecords(projectId) {
      return state.secrets.filter((secret) => secret.projectId === projectId);
    },

    async enqueueJob(projectId, type, payload = {}) {
      const job = createJob(projectId, type, payload);
      state.jobs.push(job);
      return job;
    },

    async listProjectJobs(projectId, options = {}) {
      const limit = options.limit ?? 20;
      return state.jobs
        .filter((job) => job.projectId === projectId && (!options.type || job.type === options.type))
        .slice(-limit)
        .reverse();
    },

    async enqueueDeploymentActivation(projectId, deploymentId, runtimeInstanceId, now = new Date(), staleAfterMs = 300_000) {
      const existing = state.jobs.find(
        (candidate) =>
          candidate.projectId === projectId &&
          candidate.type === "ensure_deployment_running" &&
          candidate.payload.runtimeInstanceId === runtimeInstanceId &&
          (candidate.status === "queued" || candidate.status === "running"),
      );
      if (existing) {
        if (existing.status === "running" && Date.parse(existing.updatedAt) <= now.getTime() - staleAfterMs) {
          existing.status = "queued";
          existing.updatedAt = now.toISOString();
        }
        return existing;
      }
      const job = createJob(projectId, "ensure_deployment_running", { deploymentId, runtimeInstanceId });
      job.createdAt = now.toISOString();
      job.updatedAt = now.toISOString();
      state.jobs.push(job);
      return job;
    },

    async claimNextJob(_workerId, now = new Date()) {
      const job = state.jobs.find((candidate) => {
        if (candidate.status !== "queued") return false;
        const project = state.projects.find((entry) => entry.id === candidate.projectId);
        if (project?.deletionStatus !== "deleting") return true;
        if (candidate.type !== "delete_project") return false;
        return !state.jobs.some(
          (other) => other.projectId === candidate.projectId && other.id !== candidate.id && other.status === "running",
        );
      });
      if (!job) {
        return null;
      }

      job.status = "running";
      job.attempts += 1;
      job.updatedAt = now.toISOString();
      return job;
    },

    async recoverStaleJobs(now = new Date(), staleAfterMs = 300_000, limit = 25) {
      const cutoff = now.getTime() - staleAfterMs;
      const stale = state.jobs
        .filter((job) => job.status === "running" && Date.parse(job.updatedAt) <= cutoff)
        .slice(0, limit);
      for (const job of stale) {
        job.status = "queued";
        job.updatedAt = now.toISOString();
      }
      return stale.length;
    },

    async heartbeatJob(jobId, attempt, now = new Date()) {
      const job = state.jobs.find((candidate) => candidate.id === jobId && candidate.status === "running" && candidate.attempts === attempt);
      if (!job) return false;
      job.updatedAt = now.toISOString();
      return true;
    },

    async replaceJobPayload(jobId, payload, attempt) {
      const job = state.jobs.find(
        (candidate) => candidate.id === jobId && candidate.status === "running" && candidate.attempts === attempt,
      );
      if (!job) return false;
      job.payload = payload;
      job.updatedAt = new Date().toISOString();
      return true;
    },

    async completeJob(jobId, attempt) {
      const job = state.jobs.find((candidate) => candidate.id === jobId && (attempt === undefined || (candidate.status === "running" && candidate.attempts === attempt)));
      if (!job) return false;
      job.status = "completed";
      job.updatedAt = new Date().toISOString();
      return true;
    },

    async failJob(jobId, error, attempt) {
      const job = state.jobs.find((candidate) => candidate.id === jobId && (attempt === undefined || (candidate.status === "running" && candidate.attempts === attempt)));
      if (!job) return false;
      job.status = "failed";
      job.lastError = error;
      job.updatedAt = new Date().toISOString();
      return true;
    },

    async updateProjectState(projectId, nextState) {
      const project = state.projects.find((candidate) => candidate.id === projectId);
      if (!project) {
        return null;
      }

      project.status = nextState.status ?? project.status;
      project.deploymentStatus = nextState.deploymentStatus ?? project.deploymentStatus;
      project.updatedAt = new Date().toISOString();
      return project;
    },

    async appendLog(input) {
      const log: LogRecord = {
        id: createId("log"),
        projectId: input.projectId,
        deploymentId: input.deploymentId ?? null,
        type: input.type,
        line: input.line,
        createdAt: new Date().toISOString(),
      };
      state.logs.push(log);
      return log;
    },

    async recordSourceRevision(input) {
      const now = new Date().toISOString();
      const revision: SourceRevision = {
        id: createId("src"),
        projectId: input.projectId,
        kind: input.kind,
        commitSha: input.commitSha ?? null,
        sourcePath: input.sourcePath,
        summary: input.summary,
        envVars: input.envVars,
        createdAt: now,
      };

      state.sourceRevisions.push(revision);
      state.sourceFiles = state.sourceFiles.filter((file) => file.revisionId !== revision.id);
      state.sourceFiles.push(
        ...input.files.map((file) => ({
          id: createId("file"),
          revisionId: revision.id,
          path: file.path,
          content: file.content,
          size: Buffer.byteLength(file.content),
        })),
      );
      state.schedules = state.schedules.filter((schedule) => schedule.projectId !== input.projectId);
      state.schedules.push(
        ...input.schedules.map((schedule) => ({
          id: createId("sch"),
          projectId: input.projectId,
          ...schedule,
        })),
      );
      const project = state.projects.find((candidate) => candidate.id === input.projectId);
      if (project) {
        project.sourceRevisionId = revision.id;
        if (!project.deploymentId) {
          project.status = "imported";
        }
        project.updatedAt = now;
      }
      return revision;
    },

    async getCurrentSourceRevision(projectId) {
      const project = state.projects.find((candidate) => candidate.id === projectId);
      return state.sourceRevisions.find((revision) => revision.id === project?.sourceRevisionId) ?? null;
    },

    async listSourceRevisions(projectId) {
      return state.sourceRevisions.filter((revision) => revision.projectId === projectId);
    },

    async getSourceRevision(revisionId) {
      return state.sourceRevisions.find((revision) => revision.id === revisionId) ?? null;
    },

    async listSourceFiles(projectId) {
      const revision = await this.getCurrentSourceRevision(projectId);
      return revision ? state.sourceFiles.filter((file) => file.revisionId === revision.id).sort((a, b) => a.path.localeCompare(b.path)) : [];
    },

    async getSourceFile(projectId, filePath) {
      const files = await this.listSourceFiles(projectId);
      return files.find((file) => file.path === filePath) ?? null;
    },

    async recordDeployment(input) {
      const now = new Date().toISOString();
      const release: ReleaseRecord = {
        id: input.releaseId ?? createId("rel"),
        projectId: input.projectId,
        sourceRevisionId: input.sourceRevisionId,
        imageTag: input.imageTag,
        createdAt: now,
      };
      const deployment = await claimDeploymentKey(async (deploymentKey) => {
        if (
          state.deployments.some(
            (candidate) => candidate.projectId === input.projectId && candidate.deploymentKey === deploymentKey,
          )
        ) {
          return null;
        }
        const claimed: DeploymentRecord = {
          id: input.deploymentId ?? createId("dep"),
          deploymentKey,
          projectId: input.projectId,
          releaseId: release.id,
          containerName: input.containerName,
          internalPort: input.internalPort,
          hostPort: input.hostPort,
          status: "running",
          runtimeKind: input.runtimeKind,
          createdAt: now,
          updatedAt: now,
        };
        state.deployments.push(claimed);
        return claimed;
      });
      state.releases.push(release);

      const project = state.projects.find((candidate) => candidate.id === input.projectId);
      if (project && !project.deploymentId) {
        project.status = "deployed";
        project.deploymentStatus = "running";
        project.releaseId = release.id;
        project.deploymentId = deployment.id;
        project.updatedAt = now;
      }

      return deployment;
    },

    async getCurrentDeployment(projectId) {
      const project = state.projects.find((candidate) => candidate.id === projectId);
      return state.deployments.find((deployment) => deployment.id === project?.deploymentId) ?? null;
    },

    async listDeployments(projectId) {
      return state.deployments
        .filter((deployment) => deployment.projectId === projectId)
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || state.deployments.indexOf(right) - state.deployments.indexOf(left),
        );
    },

    async getDeployment(deploymentId) {
      return state.deployments.find((deployment) => deployment.id === deploymentId) ?? null;
    },

    async getDeploymentEveVersion(deploymentId) {
      const deployment = state.deployments.find((candidate) => candidate.id === deploymentId);
      const release = state.releases.find((candidate) => candidate.id === deployment?.releaseId);
      const revision = state.sourceRevisions.find((candidate) => candidate.id === release?.sourceRevisionId);
      if (!revision) return null;
      let version = typeof revision.summary.eveVersion === "string" ? revision.summary.eveVersion : null;
      if (!version) {
        const packageJson = state.sourceFiles.find(
          (file) => file.revisionId === revision.id && file.path === "package.json",
        );
        if (packageJson) version = readDeclaredEveVersion([{ path: packageJson.path, content: packageJson.content }]);
      }
      return createEveVersionInfo(version, revision.id);
    },

    async getDeploymentByContainerName(containerName) {
      // Container names embed the deployment id, so at most one row matches;
      // newest-first keeps the answer deterministic even if that ever changes.
      return [...state.deployments]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .find((deployment) => deployment.containerName === containerName) ?? null;
    },

    async updateDeploymentStatus(deploymentId, status) {
      const deployment = state.deployments.find((candidate) => candidate.id === deploymentId);
      if (!deployment) return null;
      deployment.status = status;
      deployment.updatedAt = new Date().toISOString();
      return deployment;
    },

    async getRelease(releaseId) {
      return state.releases.find((release) => release.id === releaseId) ?? null;
    },

    async ensureDeploymentRoutes(projectId, deploymentId, baseDomain) {
      const project = state.projects.find((candidate) => candidate.id === projectId);
      const deployment = state.deployments.find((candidate) => candidate.id === deploymentId && candidate.projectId === projectId);
      if (!project || !deployment) throw new Error("Cannot create Agent routes for an unknown project or deployment.");
      const domain = normalizeBaseDomain(baseDomain);
      const stable = upsertMemoryRoute(state, {
        projectId,
        hostname: `${project.slug}.${domain}`,
        kind: "project",
      });
      const preview = upsertMemoryRoute(state, {
        projectId,
        hostname: `${deployment.deploymentKey}--${project.slug}.${domain}`,
        kind: "deployment",
        deploymentId,
      });
      const stableHasTargets = state.routeTargets.some((target) => target.routeId === stable.id);
      state.routeTargets = state.routeTargets.filter((target) => target.routeId !== preview.id);
      if (!stableHasTargets) state.routeTargets.push({ routeId: stable.id, deploymentId, weight: 10_000, variantName: null });
      state.routeTargets.push({ routeId: preview.id, deploymentId, weight: 10_000, variantName: null });
      return [stable, preview];
    },

    async reconcileAgentRoutes(baseDomain) {
      for (const project of state.projects) {
        if (project.deploymentId) await this.ensureDeploymentRoutes(project.id, project.deploymentId, baseDomain);
      }
    },

    async findRouteByHostname(hostname) {
      const route = state.agentRoutes.find((candidate) => candidate.hostname === hostname.toLowerCase()) ?? null;
      if (!route) return null;
      return {
        ...route,
        targets: state.routeTargets
          .filter((target) => target.routeId === route.id)
          .flatMap((target) => {
            const deployment = state.deployments.find((candidate) => candidate.id === target.deploymentId);
            return deployment ? [{ ...target, hostPort: deployment.hostPort, status: deployment.status }] : [];
          }),
      };
    },

    async findProjectRoute(projectId) {
      const route = state.agentRoutes.find((candidate) => candidate.projectId === projectId && candidate.kind === "project") ?? null;
      return route ? this.findRouteByHostname(route.hostname) : null;
    },

    async listProjectRoutes(projectId) {
      const routes = state.agentRoutes.filter((candidate) => candidate.projectId === projectId);
      return Promise.all(routes.map((route) => this.findRouteByHostname(route.hostname))).then((resolved) => resolved.filter(Boolean) as ResolvedAgentRoute[]);
    },

    async updateRouteTargets(routeId, targets) {
      validateRouteTargets(targets);
      const route = state.agentRoutes.find((candidate) => candidate.id === routeId);
      if (!route) throw new Error("Agent route not found.");
      if (route.kind === "deployment") throw new Error("Deployment preview routes are immutable.");
      for (const target of targets) {
        const deployment = state.deployments.find((candidate) => candidate.id === target.deploymentId);
        if (!deployment || deployment.projectId !== route.projectId) throw new Error("Route target deployment does not belong to the project.");
        if (target.weight > 0 && deployment.status !== "running") throw new Error("A weighted route target must be running.");
      }
      state.routeTargets = state.routeTargets.filter((target) => target.routeId !== routeId);
      state.routeTargets.push(...targets.map((target) => ({ routeId, ...target })));
      route.policyRevision += 1;
      route.updatedAt = new Date().toISOString();
      return (await this.findRouteByHostname(route.hostname))!;
    },

    async promoteDeployment(projectId, deploymentId) {
      const route = await this.findProjectRoute(projectId);
      if (!route) throw new Error("Project route not found.");
      const updated = await this.updateRouteTargets(route.id, [{ deploymentId, weight: 10_000, variantName: null }]);
      const project = state.projects.find((candidate) => candidate.id === projectId);
      const deployment = state.deployments.find((candidate) => candidate.id === deploymentId);
      if (project && deployment) {
        project.deploymentId = deployment.id;
        project.releaseId = deployment.releaseId;
        project.deploymentStatus = deployment.status;
        project.updatedAt = new Date().toISOString();
      }
      await this.setProjectSchedulerTarget(projectId, deploymentId);
      return updated;
    },

    async ensureAliasRoute(projectId, alias, baseDomain, targets) {
      validateRouteTargets(targets);
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(alias)) throw new Error("Alias must be a DNS-safe label.");
      const project = state.projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new Error("Project not found.");
      const hostname = `${alias}--${project.slug}.${normalizeBaseDomain(baseDomain)}`;
      const existed = state.agentRoutes.some((candidate) => candidate.hostname === hostname);
      const route = upsertMemoryRoute(state, { projectId, hostname, kind: "alias" });
      for (const target of targets) {
        const deployment = state.deployments.find((candidate) => candidate.id === target.deploymentId);
        if (!deployment || deployment.projectId !== projectId || (target.weight > 0 && deployment.status !== "running")) {
          throw new Error("Alias target must be a running deployment in this project.");
        }
      }
      state.routeTargets = state.routeTargets.filter((target) => target.routeId !== route.id);
      state.routeTargets.push(...targets.map((target) => ({ routeId: route.id, ...target })));
      if (existed) route.policyRevision += 1;
      route.updatedAt = new Date().toISOString();
      return (await this.findRouteByHostname(hostname))!;
    },

    async getDeploymentRetention(projectId, keepRecent = 3) {
      const deployments = await this.listDeployments(projectId);
      const recent = new Set(deployments.slice(0, keepRecent).map((deployment) => deployment.id));
      const mutableRouteIds = new Set(state.agentRoutes.filter((route) => route.kind !== "deployment").map((route) => route.id));
      const targeted = new Set(state.routeTargets.filter((target) => mutableRouteIds.has(target.routeId)).map((target) => target.deploymentId));
      const active = new Set(
        state.sessionBindings
          .filter((binding) => {
            const session = state.sessions.find((candidate) => candidate.projectId === binding.projectId && candidate.eveSessionId === binding.eveSessionId);
            return binding.projectId === projectId && (!session || !["completed", "failed"].includes(session.status));
          })
          .map((binding) => binding.deploymentId),
      );
      return deployments.map((deployment) => {
        const reasons: DeploymentRetention["reasons"] = [];
        if (targeted.has(deployment.id)) reasons.push("route_target");
        if (active.has(deployment.id)) reasons.push("active_session");
        if (recent.has(deployment.id)) reasons.push("recent_artifact");
        return { deployment, protected: reasons.length > 0, reasons };
      });
    },

    async findSessionBinding(projectId, eveSessionId) {
      return state.sessionBindings.find((binding) => binding.projectId === projectId && binding.eveSessionId === eveSessionId) ?? null;
    },

    async bindSession(input) {
      const now = new Date().toISOString();
      let binding = state.sessionBindings.find(
        (candidate) => candidate.projectId === input.projectId && candidate.eveSessionId === input.eveSessionId,
      );
      if (binding) Object.assign(binding, input, { updatedAt: now });
      else {
        binding = { id: createId("bind"), ...input, createdAt: now, updatedAt: now };
        state.sessionBindings.push(binding);
      }
      const session = state.sessions.find(
        (candidate) => candidate.projectId === input.projectId && candidate.eveSessionId === input.eveSessionId,
      );
      if (session) {
        session.trigger = input.trigger;
        session.routeId = input.routeId;
        session.experimentId = input.experimentId;
        session.variantName = input.variantName;
        session.deploymentId = input.deploymentId;
      }
      return binding;
    },

    async createSession(input) {
      const now = new Date().toISOString();
      const session: Session = {
        id: createId("sess"),
        projectId: input.projectId,
        deploymentId: input.deploymentId ?? null,
        eveSessionId: input.eveSessionId ?? null,
        continuationToken: input.continuationToken ?? null,
        rootNodeId: null,
        routeId: null,
        experimentId: null,
        variantName: null,
        trigger: input.trigger,
        scheduleId: input.scheduleId ?? null,
        scheduleRunId: null,
        status: "running",
        startedAt: now,
        completedAt: null,
        usage: emptySessionTokenUsage(),
      };
      state.sessions.push(session);
      const project = state.projects.find((candidate) => candidate.id === input.projectId);
      if (project) {
        project.latestSessionStatus = session.status;
        project.updatedAt = now;
      }
      return session;
    },

    async getSessionByEveSessionId(projectId, eveSessionId) {
      return state.sessions.find((session) => session.projectId === projectId && session.eveSessionId === eveSessionId) ?? null;
    },

    async appendSessionEvent(sessionId, type, payload) {
      const event: SessionEvent = {
        id: createId("evt"),
        sessionId,
        index: state.sessionEvents.filter((candidate) => candidate.sessionId === sessionId).length,
        type,
        payload,
        sessionNodeId: null,
        observerEventId: null,
        eventFingerprint: null,
        observedDeploymentId: null,
        sourceSequence: null,
        eventAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      state.sessionEvents.push(event);
      return event;
    },

    async recordModelUsage(sessionId, usage) {
      const session = state.sessions.find((candidate) => candidate.id === sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found.`);
      }

      const eveSessionId = usage.eveSessionId ?? sessionId;
      const existing = state.modelUsageEvents.find(
        (event) =>
          event.sessionId === sessionId &&
          event.eveSessionId === eveSessionId &&
          event.turnId === usage.turnId &&
          event.stepIndex === usage.stepIndex,
      );
      if (existing) {
        return existing;
      }

      const event: ModelUsageEvent = {
        id: createId("usage"),
        sessionId,
        ...usage,
        eveSessionId,
        agentId: usage.agentId ?? null,
        agentName: usage.agentName ?? null,
        createdAt: new Date().toISOString(),
      };
      state.modelUsageEvents.push(event);
      addUsageToSession(session, event);
      return event;
    },

    async completeSession(sessionId, input) {
      let session = state.sessions.find((candidate) => candidate.id === sessionId);
      if (!session) {
        return null;
      }

      if (input.eveSessionId) {
        const observedSession = state.sessions.find(
          (candidate) =>
            candidate.id !== sessionId &&
            candidate.projectId === session!.projectId &&
            candidate.eveSessionId === input.eveSessionId,
        );
        if (observedSession) {
          mergeMemorySessions(state, session, observedSession);
          session = state.sessions.find((candidate) => candidate.id === sessionId)!;
        }
        const binding = state.sessionBindings.find(
          (candidate) => candidate.projectId === session!.projectId && candidate.eveSessionId === input.eveSessionId,
        );
        if (binding) {
          session.trigger = binding.trigger;
          session.routeId = binding.routeId;
          session.experimentId = binding.experimentId;
          session.variantName = binding.variantName;
          session.deploymentId = binding.deploymentId;
        }
      }

      const now = new Date().toISOString();
      session.status = input.status;
      session.eveSessionId = input.eveSessionId ?? session.eveSessionId;
      session.continuationToken = input.continuationToken ?? session.continuationToken;
      session.completedAt = input.status === "completed" || input.status === "failed" ? now : null;

      const project = state.projects.find((candidate) => candidate.id === session.projectId);
      if (project) {
        project.latestSessionStatus = session.status;
        project.updatedAt = now;
      }

      return session;
    },

    async listSchedules(projectId) {
      return state.schedules.filter((schedule) => schedule.projectId === projectId);
    },

    async recordScheduleVersions(input) {
      const revision = state.sourceRevisions.find(
        (candidate) => candidate.id === input.sourceRevisionId && candidate.projectId === input.projectId,
      );
      if (!revision) throw new Error("Cannot record schedule versions for an unknown SourceRevision.");

      const seenKeys = new Set<string>();
      const result: ProjectScheduleVersion[] = [];
      for (const definition of input.definitions) {
        if (seenKeys.has(definition.key)) throw new Error(`Duplicate schedule key: ${definition.key}`);
        seenKeys.add(definition.key);

        const now = new Date().toISOString();
        let schedule = state.projectSchedules.find(
          (candidate) => candidate.projectId === input.projectId && candidate.key === definition.key,
        );
        if (!schedule) {
          schedule = {
            id: createId("sch"),
            projectId: input.projectId,
            key: definition.key,
            enabled: true,
            nextRunAt: null,
            createdAt: now,
            updatedAt: now,
          };
          state.projectSchedules.push(schedule);
        }

        const existingVersion = state.scheduleVersions.find(
          (candidate) => candidate.scheduleId === schedule.id && candidate.sourceRevisionId === input.sourceRevisionId,
        );
        if (existingVersion) {
          if (
            existingVersion.definitionHash !== definition.definitionHash ||
            existingVersion.cron !== definition.cron ||
            existingVersion.kind !== definition.kind ||
            existingVersion.sourcePath !== definition.sourcePath
          ) {
            throw new Error(`ScheduleVersion ${existingVersion.id} is immutable.`);
          }
          result.push({ schedule, version: existingVersion });
          continue;
        }

        const version: ScheduleVersion = {
          id: createId("schv"),
          scheduleId: schedule.id,
          sourceRevisionId: input.sourceRevisionId,
          kind: definition.kind,
          cron: definition.cron,
          sourcePath: definition.sourcePath,
          definitionHash: definition.definitionHash,
          createdAt: now,
        };
        state.scheduleVersions.push(version);
        result.push({ schedule, version });
      }
      return result;
    },

    async listProjectScheduleVersions(projectId, sourceRevisionId) {
      return state.scheduleVersions
        .filter((version) => version.sourceRevisionId === sourceRevisionId)
        .flatMap((version) => {
          const schedule = state.projectSchedules.find(
            (candidate) => candidate.id === version.scheduleId && candidate.projectId === projectId,
          );
          return schedule ? [{ schedule, version }] : [];
        })
        .sort((a, b) => a.schedule.key.localeCompare(b.schedule.key));
    },

    async listProjectScheduleSummaries(projectId) {
      const target = state.projectSchedulerTargets.find((candidate) => candidate.projectId === projectId);
      const deployment = state.deployments.find((candidate) => candidate.id === target?.deploymentId);
      const release = state.releases.find((candidate) => candidate.id === deployment?.releaseId);
      return state.projectSchedules
        .filter((schedule) => schedule.projectId === projectId)
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((schedule) => ({
          schedule,
          version: state.scheduleVersions.find(
            (version) => version.scheduleId === schedule.id && version.sourceRevisionId === release?.sourceRevisionId,
          ) ?? null,
          targetDeploymentId: target?.deploymentId ?? null,
        }));
    },

    async getProjectSchedule(scheduleId) {
      return state.projectSchedules.find((candidate) => candidate.id === scheduleId) ?? null;
    },

    async setProjectSchedulerTarget(projectId, deploymentId, now = new Date()) {
      const deployment = state.deployments.find(
        (candidate) => candidate.id === deploymentId && candidate.projectId === projectId,
      );
      if (!deployment) throw new Error("Cannot target an unknown Deployment for schedules.");
      const release = state.releases.find((candidate) => candidate.id === deployment.releaseId);
      if (!release) throw new Error("Cannot target a Deployment without its Release.");

      const updatedAt = now.toISOString();
      const existing = state.projectSchedulerTargets.find((candidate) => candidate.projectId === projectId);
      const target = existing ?? { projectId, deploymentId, updatedAt };
      target.deploymentId = deploymentId;
      target.updatedAt = updatedAt;
      if (!existing) state.projectSchedulerTargets.push(target);

      for (const schedule of state.projectSchedules.filter((candidate) => candidate.projectId === projectId)) {
        const version = state.scheduleVersions.find(
          (candidate) => candidate.scheduleId === schedule.id && candidate.sourceRevisionId === release.sourceRevisionId,
        );
        schedule.nextRunAt = version && schedule.enabled ? getNextRunAt(version.cron, now).toISOString() : null;
        schedule.updatedAt = updatedAt;
      }
      return target;
    },

    async listUpcomingScheduleTargets(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error("Schedule prewarm limit must be positive.");
      const after = input.after.toISOString();
      const before = input.before.toISOString();
      return state.projectSchedules
        .filter((schedule) => schedule.enabled && schedule.nextRunAt !== null)
        .filter((schedule) => schedule.nextRunAt! > after && schedule.nextRunAt! <= before)
        .flatMap((schedule) => {
          const target = state.projectSchedulerTargets.find((candidate) => candidate.projectId === schedule.projectId);
          const deployment = state.deployments.find((candidate) => candidate.id === target?.deploymentId);
          if (!target || !deployment || deployment.status === "archived" || deployment.status === "failed") return [];
          return [{
            scheduleId: schedule.id,
            projectId: schedule.projectId,
            deploymentId: target.deploymentId,
            nextRunAt: schedule.nextRunAt!,
          }];
        })
        .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt) || a.scheduleId.localeCompare(b.scheduleId))
        .slice(0, input.limit);
    },

    async createManualScheduleRun(projectId, scheduleId, now = new Date()) {
      const schedule = state.projectSchedules.find(
        (candidate) => candidate.id === scheduleId && candidate.projectId === projectId,
      );
      if (!schedule) throw new Error("Project schedule not found.");
      if (!schedule.enabled) throw new Error("Project schedule is disabled.");
      const target = state.projectSchedulerTargets.find((candidate) => candidate.projectId === projectId);
      const deployment = state.deployments.find((candidate) => candidate.id === target?.deploymentId);
      const release = state.releases.find((candidate) => candidate.id === deployment?.releaseId);
      const version = state.scheduleVersions.find(
        (candidate) => candidate.scheduleId === scheduleId && candidate.sourceRevisionId === release?.sourceRevisionId,
      );
      if (!target || !deployment || !release || !version) {
        throw new Error("Project schedule has no deployable scheduler target.");
      }
      const nowIso = now.toISOString();
      const run: ScheduleRun = {
        id: createId("srun"),
        scheduleId,
        scheduleVersionId: version.id,
        releaseId: release.id,
        deploymentId: deployment.id,
        dueAt: nowIso,
        trigger: "manual",
        status: "queued",
        attempt: 0,
        missedTicks: 0,
        error: null,
        startedAt: null,
        completedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.scheduleRuns.push(run);
      state.jobs.push(createJob(projectId, "trigger_schedule", { scheduleRunId: run.id }));
      return run;
    },

    async claimDueScheduleRuns(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error("Schedule claim limit must be positive.");
      const nowIso = input.now.toISOString();
      const due = state.projectSchedules
        .filter((schedule) => schedule.enabled && schedule.nextRunAt !== null && schedule.nextRunAt <= nowIso)
        .sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? "") || a.id.localeCompare(b.id))
        .slice(0, input.limit);
      const claimed: ScheduleRun[] = [];

      for (const schedule of due) {
        const target = state.projectSchedulerTargets.find((candidate) => candidate.projectId === schedule.projectId);
        const deployment = state.deployments.find((candidate) => candidate.id === target?.deploymentId);
        const release = state.releases.find((candidate) => candidate.id === deployment?.releaseId);
        const version = state.scheduleVersions.find(
          (candidate) => candidate.scheduleId === schedule.id && candidate.sourceRevisionId === release?.sourceRevisionId,
        );
        if (!deployment || !release || !version || !schedule.nextRunAt) continue;

        const dueAt = schedule.nextRunAt;
        const duplicate = state.scheduleRuns.find(
          (candidate) => candidate.scheduleVersionId === version.id && candidate.dueAt === dueAt && candidate.trigger === "cron",
        );
        if (duplicate) continue;

        let next = getNextRunAt(version.cron, new Date(dueAt));
        let missedTicks = 0;
        while (next <= input.now) {
          missedTicks += 1;
          next = getNextRunAt(version.cron, next);
        }
        schedule.nextRunAt = next.toISOString();
        schedule.updatedAt = nowIso;

        const run: ScheduleRun = {
          id: createId("srun"),
          scheduleId: schedule.id,
          scheduleVersionId: version.id,
          releaseId: release.id,
          deploymentId: deployment.id,
          dueAt,
          trigger: "cron",
          status: "queued",
          attempt: 0,
          missedTicks,
          error: null,
          startedAt: null,
          completedAt: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        state.scheduleRuns.push(run);
        state.jobs.push(createJob(schedule.projectId, "trigger_schedule", { scheduleRunId: run.id }));
        claimed.push(run);
      }
      return claimed;
    },

    async getScheduleRun(scheduleRunId) {
      return state.scheduleRuns.find((candidate) => candidate.id === scheduleRunId) ?? null;
    },

    async listScheduleRuns(projectId, input) {
      const scheduleIds = new Set(
        state.projectSchedules.filter((schedule) => schedule.projectId === projectId).map((schedule) => schedule.id),
      );
      const cursor = input.cursor ? state.scheduleRuns.find((run) => run.id === input.cursor && scheduleIds.has(run.scheduleId)) : null;
      if (input.cursor && !cursor) return { items: [], nextCursor: null };
      const runs = state.scheduleRuns
        .filter((run) => scheduleIds.has(run.scheduleId))
        .filter((run) => !input.scheduleId || run.scheduleId === input.scheduleId)
        .filter((run) => !input.trigger || run.trigger === input.trigger)
        .filter((run) => !input.status || run.status === input.status)
        .filter((run) => !cursor || run.createdAt < cursor.createdAt || (run.createdAt === cursor.createdAt && run.id < cursor.id))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const page = runs.slice(0, input.limit);
      return {
        items: page.map((run) => {
          const linkedSessions = state.sessions.filter((session) => session.scheduleRunId === run.id);
          const schedule = state.projectSchedules.find((candidate) => candidate.id === run.scheduleId)!;
          return {
            ...run,
            scheduleKey: schedule.key,
            sessionCount: linkedSessions.length,
            usage: summarizeSessionUsage(linkedSessions),
            sessions: linkedSessions,
          };
        }),
        nextCursor: runs.length > input.limit ? page.at(-1)?.id ?? null : null,
      };
    },

    async getScheduleRunDetail(scheduleRunId) {
      const run = state.scheduleRuns.find((candidate) => candidate.id === scheduleRunId);
      if (!run) return null;
      const schedule = state.projectSchedules.find((candidate) => candidate.id === run.scheduleId);
      const version = state.scheduleVersions.find((candidate) => candidate.id === run.scheduleVersionId);
      const release = state.releases.find((candidate) => candidate.id === run.releaseId);
      const deployment = state.deployments.find((candidate) => candidate.id === run.deploymentId);
      if (!schedule || !version || !release || !deployment) return null;
      const linkedSessions = state.sessions
        .filter((session) => session.scheduleRunId === run.id)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
      return {
        ...run,
        scheduleKey: schedule.key,
        sessionCount: linkedSessions.length,
        usage: summarizeSessionUsage(linkedSessions),
        sessions: linkedSessions,
        version,
        release,
        deployment,
      };
    },

    async claimScheduleRunActivation(scheduleRunId, now = new Date(), staleAfterMs = 300_000) {
      const run = state.scheduleRuns.find((candidate) => candidate.id === scheduleRunId);
      if (!run) return null;
      const stale = run.status === "activating" && new Date(run.updatedAt).getTime() <= now.getTime() - staleAfterMs;
      if (run.status !== "queued" && !stale) return null;
      run.status = "activating";
      run.startedAt ??= now.toISOString();
      run.updatedAt = now.toISOString();
      return run;
    },

    async redeemScheduleRunDispatch(scheduleRunId, deploymentId) {
      const run = state.scheduleRuns.find((candidate) => candidate.id === scheduleRunId);
      if (!run || run.deploymentId !== deploymentId || run.status !== "activating") return null;
      run.status = "dispatching";
      run.attempt += 1;
      run.startedAt ??= new Date().toISOString();
      run.updatedAt = new Date().toISOString();
      return run;
    },

    async completeScheduleRun(scheduleRunId, input) {
      const run = state.scheduleRuns.find((candidate) => candidate.id === scheduleRunId);
      if (!run) return null;
      const schedule = state.projectSchedules.find((candidate) => candidate.id === run.scheduleId);
      if (!schedule) throw new Error("ScheduleRun references an unknown ProjectSchedule.");

      const trigger: SessionTrigger = run.trigger === "cron" ? "cron" : "manual";
      for (const eveSessionId of new Set(input.eveSessionIds ?? [])) {
        let session = state.sessions.find(
          (candidate) => candidate.projectId === schedule.projectId && candidate.eveSessionId === eveSessionId,
        );
        if (session) {
          session.deploymentId = run.deploymentId;
          session.trigger = trigger;
          session.scheduleId = run.scheduleId;
          session.scheduleRunId = run.id;
          continue;
        }
        const now = new Date().toISOString();
        session = {
          id: createId("sess"),
          projectId: schedule.projectId,
          deploymentId: run.deploymentId,
          eveSessionId,
          continuationToken: null,
          rootNodeId: null,
          routeId: null,
          experimentId: null,
          variantName: null,
          trigger,
          scheduleId: run.scheduleId,
          scheduleRunId: run.id,
          status: "running",
          startedAt: now,
          completedAt: null,
          usage: emptySessionTokenUsage(),
        };
        state.sessions.push(session);
      }

      const now = new Date().toISOString();
      run.status = input.status;
      run.error = input.error ?? null;
      run.completedAt = now;
      run.updatedAt = now;
      return run;
    },

    async acquireActivationLease(input) {
      const deployment = state.deployments.find((candidate) => candidate.id === input.deploymentId);
      if (!deployment) throw new Error("Cannot activate an unknown Deployment.");
      const now = input.now ?? new Date();
      const nowIso = now.toISOString();
      const latestRuntimeInstance = state.runtimeInstances
        .filter((candidate) => candidate.deploymentId === input.deploymentId)
        .sort((a, b) => b.generation - a.generation)[0];
      if (latestRuntimeInstance?.status === "draining") {
        throw new RuntimeInstanceDrainingError();
      }
      let runtimeInstance = latestRuntimeInstance &&
        (latestRuntimeInstance.status === "starting" || latestRuntimeInstance.status === "ready")
        ? latestRuntimeInstance
        : undefined;
      const starter = !runtimeInstance;
      if (!runtimeInstance) {
        const generation = Math.max(
          0,
          ...state.runtimeInstances
            .filter((candidate) => candidate.deploymentId === input.deploymentId)
            .map((candidate) => candidate.generation),
        ) + 1;
        runtimeInstance = {
          id: createId("rti"),
          deploymentId: input.deploymentId,
          generation,
          status: "starting",
          endpointHost: null,
          endpointPort: null,
          startedAt: nowIso,
          readyAt: null,
          stoppedAt: null,
          lastError: null,
        };
        state.runtimeInstances.push(runtimeInstance);
      }
      let lease = state.activationLeases.find(
        (candidate) =>
          candidate.deploymentId === input.deploymentId &&
          candidate.kind === input.kind &&
          candidate.ownerId === input.ownerId,
      );
      if (lease) {
        lease.runtimeInstanceId = runtimeInstance.id;
        lease.expiresAt = input.expiresAt.toISOString();
        lease.releasedAt = null;
      } else {
        lease = {
          id: createId("lease"),
          deploymentId: input.deploymentId,
          runtimeInstanceId: runtimeInstance.id,
          kind: input.kind,
          ownerId: input.ownerId,
          expiresAt: input.expiresAt.toISOString(),
          releasedAt: null,
        };
        state.activationLeases.push(lease);
      }
      return { lease, runtimeInstance, starter };
    },

    async getRuntimeInstance(runtimeInstanceId) {
      return state.runtimeInstances.find((candidate) => candidate.id === runtimeInstanceId) ?? null;
    },

    async listDeploymentRuntimeInstances(deploymentId) {
      return state.runtimeInstances
        .filter((candidate) => candidate.deploymentId === deploymentId)
        .sort((a, b) => a.generation - b.generation);
    },

    async adoptRuntimeInstance(deploymentId, endpoint, now = new Date()) {
      const deployment = state.deployments.find((candidate) => candidate.id === deploymentId);
      if (!deployment) return null;
      const latest = state.runtimeInstances
        .filter((candidate) => candidate.deploymentId === deploymentId)
        .sort((a, b) => b.generation - a.generation)[0];
      if (latest && (latest.status === "starting" || latest.status === "ready" || latest.status === "draining")) {
        return null;
      }
      const nowIso = now.toISOString();
      const instance: RuntimeInstance = {
        id: createId("rti"),
        deploymentId,
        generation: (latest?.generation ?? 0) + 1,
        status: "ready",
        endpointHost: endpoint.endpointHost,
        endpointPort: endpoint.endpointPort,
        startedAt: nowIso,
        readyAt: nowIso,
        stoppedAt: null,
        lastError: null,
      };
      state.runtimeInstances.push(instance);
      return instance;
    },

    async listRuntimeInstances(statuses, limit) {
      if (!Number.isInteger(limit) || limit < 1) throw new Error("RuntimeInstance list limit must be positive.");
      const allowed = new Set(statuses);
      return state.runtimeInstances
        .filter((candidate) => allowed.has(candidate.status))
        .sort((a, b) => a.deploymentId.localeCompare(b.deploymentId) || a.generation - b.generation)
        .slice(0, limit);
    },

    async updateRuntimeInstance(runtimeInstanceId, input, now = new Date()) {
      const instance = state.runtimeInstances.find((candidate) => candidate.id === runtimeInstanceId);
      if (!instance) return null;
      instance.status = input.status;
      if (input.endpointHost !== undefined) instance.endpointHost = input.endpointHost;
      if (input.endpointPort !== undefined) instance.endpointPort = input.endpointPort;
      if (input.error !== undefined) instance.lastError = input.error;
      if (input.status === "ready") instance.readyAt = now.toISOString();
      if (input.status === "stopped" || input.status === "failed") instance.stoppedAt = now.toISOString();
      return instance;
    },

    async getActivationLease(leaseId) {
      return state.activationLeases.find((candidate) => candidate.id === leaseId) ?? null;
    },

    async renewActivationLease(leaseId, expiresAt, now = new Date()) {
      const lease = state.activationLeases.find((candidate) => candidate.id === leaseId);
      if (!lease || lease.releasedAt !== null || lease.expiresAt <= now.toISOString()) return null;
      lease.expiresAt = expiresAt.toISOString();
      return lease;
    },

    async releaseActivationLease(leaseId, now = new Date()) {
      const lease = state.activationLeases.find((candidate) => candidate.id === leaseId);
      if (!lease) return null;
      lease.releasedAt ??= now.toISOString();
      return lease;
    },

    async hasActiveActivationLeases(deploymentId, now = new Date()) {
      const nowIso = now.toISOString();
      return state.activationLeases.some(
        (candidate) => candidate.deploymentId === deploymentId && candidate.releasedAt === null && candidate.expiresAt > nowIso,
      );
    },

    async claimIdleRuntimeInstances(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error("Runtime idle claim limit must be positive.");
      if (!Number.isFinite(input.idleTtlMs) || input.idleTtlMs < 0) throw new Error("Runtime idle TTL must be non-negative.");
      const schedulePrewarmMs = input.schedulePrewarmMs ?? 0;
      if (!Number.isFinite(schedulePrewarmMs) || schedulePrewarmMs < 0) {
        throw new Error("Schedule prewarm window must be non-negative.");
      }
      const cutoff = input.now.getTime() - input.idleTtlMs;
      const scheduleHorizon = input.now.getTime() + schedulePrewarmMs;
      const protectedScheduleRunStatuses = new Set(["queued", "activating", "dispatching", "running"]);
      const claimed: RuntimeInstance[] = [];
      const candidates = state.runtimeInstances
        .filter((instance) => instance.status === "draining" || instance.status === "ready")
        .sort((a, b) => a.deploymentId.localeCompare(b.deploymentId) || a.generation - b.generation);
      for (const instance of candidates) {
        if (claimed.length >= input.limit) break;
        if (instance.status === "draining") {
          claimed.push(instance);
          continue;
        }
        if (await this.hasActiveActivationLeases(instance.deploymentId, input.now)) continue;
        if (state.scheduleRuns.some(
          (run) => run.deploymentId === instance.deploymentId && protectedScheduleRunStatuses.has(run.status),
        )) continue;
        const targetProjectIds = new Set(
          state.projectSchedulerTargets
            .filter((target) => target.deploymentId === instance.deploymentId)
            .map((target) => target.projectId),
        );
        if (schedulePrewarmMs > 0 && state.projectSchedules.some(
          (schedule) =>
            targetProjectIds.has(schedule.projectId) &&
            schedule.enabled &&
            schedule.nextRunAt !== null &&
            Date.parse(schedule.nextRunAt) <= scheduleHorizon,
        )) continue;
        const activityTimes = [instance.readyAt, instance.startedAt]
          .concat(
            state.activationLeases
              .filter((lease) => lease.runtimeInstanceId === instance.id)
              .map((lease) => lease.releasedAt ?? lease.expiresAt),
          )
          .filter((value): value is string => value !== null)
          .map((value) => Date.parse(value));
        if (Math.max(...activityTimes) > cutoff) continue;
        instance.status = "draining";
        claimed.push(instance);
      }
      return claimed;
    },

    async listSessions(projectId) {
      return state.sessions.filter((session) => session.projectId === projectId);
    },

    async getSession(sessionId) {
      return state.sessions.find((session) => session.id === sessionId) ?? null;
    },

    async listSessionsPage(projectId, input) {
      const cursor = input.cursor
        ? state.sessions.find((session) => session.id === input.cursor && session.projectId === projectId)
        : null;
      if (input.cursor && !cursor) return { items: [], nextCursor: null };
      const sessions = state.sessions
        .filter((session) => session.projectId === projectId)
        .filter((session) => !input.trigger || session.trigger === input.trigger)
        .filter((session) => !input.scheduleId || session.scheduleId === input.scheduleId)
        .filter((session) => !input.scheduleRunId || session.scheduleRunId === input.scheduleRunId)
        .filter((session) => !input.unlinkedOnly || session.scheduleRunId === null)
        .filter((session) => !cursor || session.startedAt < cursor.startedAt || (session.startedAt === cursor.startedAt && session.id < cursor.id))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
      const page = sessions.slice(0, input.limit);
      return { items: page, nextCursor: sessions.length > input.limit ? page.at(-1)?.id ?? null : null };
    },

    async listSessionEvents(sessionId) {
      return state.sessionEvents.filter((event) => event.sessionId === sessionId).sort((a, b) => a.index - b.index);
    },

    async listSessionNodes(sessionId) {
      return state.sessionNodes.filter((node) => node.rootSessionId === sessionId);
    },

    async ingestObserverEnvelope(envelope) {
      const deployment = state.deployments.find((candidate) => candidate.id === envelope.deploymentId);
      if (!deployment) {
        throw new ObserverEnvelopeRejectedError(
          `Observer deployment ${envelope.deploymentId} is not managed by Eveland.`,
        );
      }

      const discovered = ensureMemorySessionNode(state, deployment, envelope);
      const duplicateEvent = state.sessionEvents.find(
        (candidate) =>
          candidate.sessionNodeId === discovered.node.id &&
          (candidate.observerEventId === envelope.observerEventId || candidate.eventFingerprint === envelope.eventFingerprint),
      );
      if (duplicateEvent) return { ...discovered, event: duplicateEvent, duplicate: true };

      const eventRecord = asRecord(envelope.event);
      const type = typeof eventRecord?.type === "string" ? eventRecord.type : "event";
      const payload = asRecord(eventRecord?.data) ?? eventRecord ?? envelope.event;
      const event: SessionEvent = {
        id: createId("evt"),
        sessionId: discovered.session.id,
        index: state.sessionEvents.filter((candidate) => candidate.sessionId === discovered.session.id).length,
        type,
        payload,
        sessionNodeId: discovered.node.id,
        observerEventId: envelope.observerEventId,
        eventFingerprint: envelope.eventFingerprint,
        observedDeploymentId: envelope.deploymentId,
        sourceSequence: envelope.sourceSequence,
        eventAt: envelope.eventAt,
        createdAt: new Date().toISOString(),
      };
      state.sessionEvents.push(event);

      projectMemorySessionState(state, discovered.session, discovered.node, type, payload);
      linkMemorySubagent(state, discovered.node, payload, type);
      const usage = parseStepUsageEvent(type, payload);
      if (usage) {
        await this.recordModelUsage(discovered.session.id, {
          ...usage,
          eveSessionId: envelope.eveSessionId,
          agentId: discovered.node.agentId,
          agentName: discovered.node.agentName,
        });
      }

      return { ...discovered, event, duplicate: false };
    },

    async listModelUsageEvents(sessionId) {
      return state.modelUsageEvents.filter((event) => event.sessionId === sessionId);
    },

    async listLogs(projectId, type) {
      return state.logs.filter((log) => log.projectId === projectId && (!type || log.type === type));
    },
  };
}

function ensureMemorySessionNode(
  state: MemoryState,
  deployment: DeploymentRecord,
  envelope: ObserverEnvelopeV1,
): { session: Session; node: SessionNode } {
  const existing = state.sessionNodes.find(
    (candidate) => candidate.projectId === deployment.projectId && candidate.eveSessionId === envelope.eveSessionId,
  );
  if (existing) {
    existing.lastObservedDeploymentId = envelope.deploymentId;
    existing.resolutionStatus = "observed";
    existing.agentName = envelope.agent.name ?? existing.agentName;
    existing.nodeId = envelope.agent.nodeId ?? existing.nodeId;
    existing.channelKind = envelope.channelKind ?? existing.channelKind;
    existing.updatedAt = new Date().toISOString();
    const session = state.sessions.find((candidate) => candidate.id === existing.rootSessionId);
    if (!session) throw new Error(`Observer session ${existing.rootSessionId} is missing.`);
    if (existing.parentNodeId === null) upgradeObserverTrigger(session, envelope.channelKind);
    return { session, node: existing };
  }

  let parent = envelope.parentEveSessionId
    ? state.sessionNodes.find(
        (candidate) => candidate.projectId === deployment.projectId && candidate.eveSessionId === envelope.parentEveSessionId,
      )
    : null;
  const now = new Date().toISOString();
  const binding = state.sessionBindings.find(
    (candidate) => candidate.projectId === deployment.projectId && candidate.eveSessionId === envelope.eveSessionId,
  );
  if (!parent && envelope.parentEveSessionId) {
    const parentBinding = state.sessionBindings.find(
      (candidate) => candidate.projectId === deployment.projectId && candidate.eveSessionId === envelope.parentEveSessionId,
    );
    let placeholderSession = state.sessions.find(
      (candidate) => candidate.projectId === deployment.projectId && candidate.eveSessionId === envelope.parentEveSessionId,
    );
    if (!placeholderSession) {
      placeholderSession = {
        id: createId("sess"),
        projectId: deployment.projectId,
        deploymentId: parentBinding?.deploymentId ?? envelope.deploymentId,
        eveSessionId: envelope.parentEveSessionId,
        continuationToken: null,
        rootNodeId: null,
        routeId: parentBinding?.routeId ?? null,
        experimentId: parentBinding?.experimentId ?? null,
        variantName: parentBinding?.variantName ?? null,
        trigger: parentBinding?.trigger ?? "direct_http",
        scheduleId: null,
        scheduleRunId: null,
        status: "running",
        startedAt: envelope.eventAt,
        completedAt: null,
        usage: emptySessionTokenUsage(),
      };
      state.sessions.push(placeholderSession);
    }
    parent = {
      id: createId("node"),
      rootSessionId: placeholderSession.id,
      projectId: deployment.projectId,
      eveSessionId: envelope.parentEveSessionId,
      parentNodeId: null,
      parentEveSessionId: null,
      startedDeploymentId: envelope.deploymentId,
      lastObservedDeploymentId: envelope.deploymentId,
      agentId: null,
      agentName: null,
      nodeId: null,
      channelKind: null,
      modelId: null,
      eveVersion: null,
      remoteUrl: null,
      resolutionStatus: "unresolved",
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    placeholderSession.rootNodeId = parent.id;
    state.sessionNodes.push(parent);
  }
  let session = parent ? state.sessions.find((candidate) => candidate.id === parent.rootSessionId) : undefined;
  if (!session && !envelope.parentEveSessionId) {
    session = state.sessions.find(
      (candidate) => candidate.projectId === deployment.projectId && candidate.eveSessionId === envelope.eveSessionId,
    );
  }
  if (!session) {
    session = {
      id: createId("sess"),
      projectId: deployment.projectId,
      deploymentId: envelope.deploymentId,
      eveSessionId: envelope.eveSessionId,
      continuationToken: null,
      rootNodeId: null,
      routeId: binding?.routeId ?? null,
      experimentId: binding?.experimentId ?? null,
      variantName: binding?.variantName ?? null,
      trigger: binding?.trigger ?? triggerFromChannel(envelope.channelKind),
      scheduleId: null,
      scheduleRunId: null,
      status: "running",
      startedAt: envelope.eventAt,
      completedAt: null,
      usage: emptySessionTokenUsage(),
    };
    state.sessions.push(session);
  }

  const node: SessionNode = {
    id: createId("node"),
    rootSessionId: session.id,
    projectId: deployment.projectId,
    eveSessionId: envelope.eveSessionId,
    parentNodeId: parent?.id ?? null,
    parentEveSessionId: envelope.parentEveSessionId,
    startedDeploymentId: envelope.deploymentId,
    lastObservedDeploymentId: envelope.deploymentId,
    agentId: envelope.agent.id,
    agentName: envelope.agent.name,
    nodeId: envelope.agent.nodeId,
    channelKind: envelope.channelKind,
    modelId: null,
    eveVersion: null,
    remoteUrl: null,
    resolutionStatus: "observed",
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
  state.sessionNodes.push(node);
  if (!parent) {
    session.rootNodeId = node.id;
    session.eveSessionId = node.eveSessionId;
  }
  return { session, node };
}

function mergeMemorySessions(state: MemoryState, target: Session, source: Session): void {
  for (const node of state.sessionNodes) {
    if (node.rootSessionId === source.id) node.rootSessionId = target.id;
  }
  const mergedEvents = state.sessionEvents
    .filter((event) => event.sessionId === target.id || event.sessionId === source.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  mergedEvents.forEach((event, index) => {
    event.sessionId = target.id;
    event.index = index;
  });
  for (const usage of state.modelUsageEvents) {
    if (usage.sessionId === source.id) usage.sessionId = target.id;
  }
  target.rootNodeId ??= source.rootNodeId;
  target.deploymentId ??= source.deploymentId;
  target.eveSessionId ??= source.eveSessionId;
  target.routeId ??= source.routeId;
  target.experimentId ??= source.experimentId;
  target.variantName ??= source.variantName;
  addSessionUsage(target, source.usage);
  state.sessions = state.sessions.filter((candidate) => candidate.id !== source.id);
}

function projectMemorySessionState(
  state: MemoryState,
  session: Session,
  node: SessionNode,
  type: string,
  payload: unknown,
): void {
  const record = asRecord(payload);
  if (type === "session.started") {
    const runtime = asRecord(record?.runtime);
    node.agentId = stringValue(runtime?.agentId) ?? node.agentId;
    node.agentName = stringValue(runtime?.agentName) ?? node.agentName;
    node.modelId = stringValue(runtime?.modelId) ?? node.modelId;
    node.eveVersion = stringValue(runtime?.eveVersion) ?? node.eveVersion;
  }

  let status: SessionStatus | null = null;
  if (type === "session.started" || type === "turn.started") status = "running";
  else if (type === "input.requested") status = "waiting_approval";
  else if (type === "session.waiting") status = node.status === "waiting_approval" ? "waiting_approval" : "waiting";
  else if (type === "session.completed") status = "completed";
  else if (type === "session.failed") status = "failed";
  if (!status) return;

  node.status = status;
  node.updatedAt = new Date().toISOString();
  if (node.parentNodeId === null) {
    session.status = status;
    session.completedAt = status === "completed" || status === "failed" ? new Date().toISOString() : null;
    const project = state.projects.find((candidate) => candidate.id === session.projectId);
    if (project) project.latestSessionStatus = status;
  }
}

function linkMemorySubagent(state: MemoryState, parent: SessionNode, payload: unknown, type: string): void {
  if (type !== "subagent.called") return;
  const record = asRecord(payload);
  const childEveSessionId = stringValue(record?.childSessionId);
  if (!childEveSessionId) return;
  const remoteUrl = stringValue(asRecord(record?.remote)?.url);

  const existing = state.sessionNodes.find(
    (candidate) => candidate.projectId === parent.projectId && candidate.eveSessionId === childEveSessionId,
  );
  if (existing) {
    if (existing.rootSessionId !== parent.rootSessionId) mergeMemoryRootSessions(state, existing.rootSessionId, parent.rootSessionId);
    existing.rootSessionId = parent.rootSessionId;
    existing.parentNodeId = parent.id;
    existing.parentEveSessionId = parent.eveSessionId;
    existing.agentName = stringValue(record?.name) ?? existing.agentName;
    existing.remoteUrl = remoteUrl ?? existing.remoteUrl;
    existing.updatedAt = new Date().toISOString();
    return;
  }

  const now = new Date().toISOString();
  state.sessionNodes.push({
    id: createId("node"),
    rootSessionId: parent.rootSessionId,
    projectId: parent.projectId,
    eveSessionId: childEveSessionId,
    parentNodeId: parent.id,
    parentEveSessionId: parent.eveSessionId,
    startedDeploymentId: parent.lastObservedDeploymentId,
    lastObservedDeploymentId: parent.lastObservedDeploymentId,
    agentId: null,
    agentName: stringValue(record?.name),
    nodeId: null,
    channelKind: "subagent",
    modelId: null,
    eveVersion: null,
    remoteUrl,
    resolutionStatus: "unresolved",
    status: "running",
    createdAt: now,
    updatedAt: now,
  });
}

function mergeMemoryRootSessions(state: MemoryState, fromSessionId: string, toSessionId: string): void {
  const from = state.sessions.find((session) => session.id === fromSessionId);
  const to = state.sessions.find((session) => session.id === toSessionId);
  if (!from || !to) return;
  for (const node of state.sessionNodes) if (node.rootSessionId === fromSessionId) node.rootSessionId = toSessionId;
  const movedEvents = state.sessionEvents.filter((event) => event.sessionId === fromSessionId);
  for (const event of movedEvents) {
    event.sessionId = toSessionId;
    event.index = state.sessionEvents.filter((candidate) => candidate.sessionId === toSessionId && candidate !== event).length;
  }
  for (const usage of state.modelUsageEvents) if (usage.sessionId === fromSessionId) usage.sessionId = toSessionId;
  addSessionUsage(to, from.usage);
  state.sessions = state.sessions.filter((session) => session.id !== fromSessionId);
}

function addSessionUsage(target: Session, usage: Session["usage"]): void {
  target.usage.inputTokens += usage.inputTokens;
  target.usage.outputTokens += usage.outputTokens;
  target.usage.cacheReadTokens += usage.cacheReadTokens;
  target.usage.cacheWriteTokens += usage.cacheWriteTokens;
  if (usage.costUsd !== null) target.usage.costUsd = (target.usage.costUsd ?? 0) + usage.costUsd;
  target.usage.reportedSteps += usage.reportedSteps;
  target.usage.missingSteps += usage.missingSteps;
  target.usage.status = target.usage.reportedSteps > 0 ? (target.usage.missingSteps > 0 ? "partial" : "reported") : "missing";
}

function triggerFromChannel(channelKind: string | null): SessionTrigger {
  if (channelKind === "schedule") return "cron";
  if (channelKind?.startsWith("channel:")) return "channel";
  if (channelKind && channelKind !== "http" && channelKind !== "eve") return "webhook";
  return "direct_http";
}

function upgradeObserverTrigger(session: Session, channelKind: string | null): void {
  if (session.trigger !== "direct_http") return;
  const discovered = triggerFromChannel(channelKind);
  if (discovered !== "direct_http") session.trigger = discovered;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function emptySessionTokenUsage(): Session["usage"] {
  return {
    status: "none",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    reportedSteps: 0,
    missingSteps: 0,
  };
}

function addUsageToSession(session: Session, event: ModelUsageEvent): void {
  session.usage.inputTokens += event.inputTokens ?? 0;
  session.usage.outputTokens += event.outputTokens ?? 0;
  session.usage.cacheReadTokens += event.cacheReadTokens ?? 0;
  session.usage.cacheWriteTokens += event.cacheWriteTokens ?? 0;
  if (event.costUsd !== null) {
    session.usage.costUsd = (session.usage.costUsd ?? 0) + event.costUsd;
  }
  if (event.usageReported) {
    session.usage.reportedSteps += 1;
  } else {
    session.usage.missingSteps += 1;
  }
  session.usage.status =
    session.usage.reportedSteps > 0
      ? session.usage.missingSteps > 0
        ? "partial"
        : "reported"
      : session.usage.missingSteps > 0
        ? "missing"
        : "none";
}

function normalizeBaseDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!normalized || !/^[a-z0-9.-]+$/.test(normalized)) throw new Error(`Invalid Agent base domain: ${value}`);
  return normalized;
}

function upsertMemoryRoute(
  state: MemoryState,
  input: { projectId: string; hostname: string; kind: AgentRoute["kind"]; deploymentId?: string },
): AgentRoute {
  const now = new Date().toISOString();
  const hostname = input.hostname.toLowerCase();
  const existing = state.agentRoutes.find((route) => {
    if (route.projectId !== input.projectId || route.kind !== input.kind) return false;
    if (input.kind === "project") return true;
    if (input.kind === "deployment" && input.deploymentId) {
      return state.routeTargets.some((target) => target.routeId === route.id && target.deploymentId === input.deploymentId);
    }
    return route.hostname === hostname;
  });
  if (existing) {
    existing.hostname = hostname;
    existing.enabled = true;
    existing.updatedAt = now;
    return existing;
  }
  const route: AgentRoute = {
    id: createId("route"),
    projectId: input.projectId,
    hostname,
    kind: input.kind,
    enabled: true,
    policyRevision: 1,
    createdAt: now,
    updatedAt: now,
  };
  state.agentRoutes.push(route);
  return route;
}

function createJob(projectId: string, type: JobType, payload: Record<string, unknown>): Job {
  const now = new Date().toISOString();
  return {
    id: createId("job"),
    projectId,
    type,
    status: "queued",
    payload,
    attempts: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

function toPublicSecret(secret: SecretRecord): PublicSecret {
  const { encryptedValue: _encryptedValue, ...publicSecret } = secret;
  return publicSecret;
}

function toPublicGitCredential(credential: GitCredentialRecord): PublicGitCredential {
  const { encryptedToken: _encryptedToken, userId: _userId, ...publicCredential } = credential;
  return publicCredential;
}

function toPublicSourcePreflight(preflight: SourcePreflightRecord): SourcePreflight {
  const {
    userId: _userId,
    sourcePath: _sourcePath,
    commitSha: _commitSha,
    attempts: _attempts,
    lockedAt: _lockedAt,
    gitCredential: _gitCredential,
    ...publicPreflight
  } = preflight;
  return publicPreflight;
}
