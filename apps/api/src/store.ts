import { createId } from "@eveland/shared/ids";
import type {
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
  LogRecord,
  DeploymentStatus,
  SourceRevision,
  SourceFileRecord,
} from "./types.js";

export type CreateProjectInput = {
  name: string;
  importKind: ProjectImportKind;
  gitUrl?: string | null;
  sourcePath?: string | null;
};

export type Store = {
  listProjects(): Promise<Project[]>;
  createProject(input: CreateProjectInput): Promise<Project>;
  getProject(projectId: string): Promise<Project | null>;
  deleteProject(projectId: string): Promise<boolean>;
  listSecrets(projectId: string): Promise<PublicSecret[]>;
  upsertSecret(projectId: string, key: string, value: string): Promise<PublicSecret>;
  deleteSecret(projectId: string, secretId: string): Promise<boolean>;
  listSecretRecords(projectId: string): Promise<SecretRecord[]>;
  enqueueJob(projectId: string, type: JobType, payload?: Record<string, unknown>): Promise<Job>;
  claimNextJob(workerId: string): Promise<Job | null>;
  completeJob(jobId: string): Promise<void>;
  failJob(jobId: string, error: string): Promise<void>;
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
  getRelease(releaseId: string): Promise<ReleaseRecord | null>;
  createSession(input: {
    projectId: string;
    deploymentId?: string | null;
    trigger: SessionTrigger;
    scheduleId?: string | null;
    eveSessionId?: string | null;
    continuationToken?: string | null;
  }): Promise<Session>;
  appendSessionEvent(sessionId: string, type: string, payload: unknown): Promise<SessionEvent>;
  completeSession(
    sessionId: string,
    input: { status: SessionStatus; eveSessionId?: string | null; continuationToken?: string | null },
  ): Promise<Session | null>;
  listSchedules(projectId: string): Promise<ScheduleRecord[]>;
  listSessions(projectId: string): Promise<Session[]>;
  listSessionEvents(sessionId: string): Promise<SessionEvent[]>;
  listLogs(projectId: string, type?: LogRecord["type"]): Promise<LogRecord[]>;
};

export type StoreState = MemoryState;

type MemoryState = {
  projects: Project[];
  secrets: SecretRecord[];
  jobs: Job[];
  schedules: ScheduleRecord[];
  sessions: Session[];
  sessionEvents: SessionEvent[];
  logs: LogRecord[];
  sourceRevisions: SourceRevision[];
  sourceFiles: SourceFileRecord[];
  releases: ReleaseRecord[];
  deployments: DeploymentRecord[];
};

export function createMemoryStore(initialState?: Partial<MemoryState>): Store {
  const state: MemoryState = {
    projects: initialState?.projects ?? [],
    secrets: initialState?.secrets ?? [],
    jobs: initialState?.jobs ?? [],
    schedules: initialState?.schedules ?? [],
    sessions: initialState?.sessions ?? [],
    sessionEvents: initialState?.sessionEvents ?? [],
    logs: initialState?.logs ?? [],
    sourceRevisions: initialState?.sourceRevisions ?? [],
    sourceFiles: initialState?.sourceFiles ?? [],
    releases: initialState?.releases ?? [],
    deployments: initialState?.deployments ?? [],
  };

  return {
    async listProjects() {
      return [...state.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async createProject(input) {
      const now = new Date().toISOString();
      const project: Project = {
        id: createId("proj"),
        name: input.name,
        importKind: input.importKind,
        gitUrl: input.gitUrl ?? null,
        status: "import_pending",
        deploymentStatus: "not_deployed",
        sourceRevisionId: null,
        releaseId: null,
        deploymentId: null,
        latestSessionStatus: null,
        nextScheduleAt: null,
        createdAt: now,
        updatedAt: now,
      };

      state.projects.push(project);
      state.jobs.push(createJob(project.id, "import_source", { importKind: input.importKind, gitUrl: input.gitUrl ?? null, sourcePath: input.sourcePath ?? null }));
      return project;
    },

    async getProject(projectId) {
      return state.projects.find((project) => project.id === projectId) ?? null;
    },

    async deleteProject(projectId) {
      const before = state.projects.length;
      const sessionIds = state.sessions.filter((session) => session.projectId === projectId).map((session) => session.id);
      const revisionIds = state.sourceRevisions.filter((revision) => revision.projectId === projectId).map((revision) => revision.id);

      // Mirrors the Postgres store's cascade order (db/postgres-store.ts
      // deleteProject): logs, deployments, releases, source files scoped to
      // this project's revisions, the revisions themselves, session events
      // scoped to this project's sessions, the sessions, then
      // schedules/jobs/secrets, and the projects row last.
      state.logs = state.logs.filter((log) => log.projectId !== projectId);
      state.deployments = state.deployments.filter((deployment) => deployment.projectId !== projectId);
      state.releases = state.releases.filter((release) => release.projectId !== projectId);
      state.sourceFiles = state.sourceFiles.filter((file) => !revisionIds.includes(file.revisionId));
      state.sourceRevisions = state.sourceRevisions.filter((revision) => revision.projectId !== projectId);
      state.sessionEvents = state.sessionEvents.filter((event) => !sessionIds.includes(event.sessionId));
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

    async claimNextJob(_workerId) {
      const job = state.jobs.find((candidate) => candidate.status === "queued");
      if (!job) {
        return null;
      }

      job.status = "running";
      job.attempts += 1;
      job.updatedAt = new Date().toISOString();
      return job;
    },

    async completeJob(jobId) {
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      if (job) {
        job.status = "completed";
        job.updatedAt = new Date().toISOString();
      }
    },

    async failJob(jobId, error) {
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      if (job) {
        job.status = "failed";
        job.lastError = error;
        job.updatedAt = new Date().toISOString();
      }
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
      await this.updateProjectState(input.projectId, { status: "imported" });
      const project = state.projects.find((candidate) => candidate.id === input.projectId);
      if (project) {
        project.sourceRevisionId = revision.id;
      }
      return revision;
    },

    async getCurrentSourceRevision(projectId) {
      const project = state.projects.find((candidate) => candidate.id === projectId);
      return state.sourceRevisions.find((revision) => revision.id === project?.sourceRevisionId) ?? null;
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
      const deployment: DeploymentRecord = {
        id: input.deploymentId ?? createId("dep"),
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
      state.releases.push(release);
      state.deployments.push(deployment);

      const project = state.projects.find((candidate) => candidate.id === input.projectId);
      if (project) {
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

    async getRelease(releaseId) {
      return state.releases.find((release) => release.id === releaseId) ?? null;
    },

    async createSession(input) {
      const now = new Date().toISOString();
      const session: Session = {
        id: createId("sess"),
        projectId: input.projectId,
        deploymentId: input.deploymentId ?? null,
        eveSessionId: input.eveSessionId ?? null,
        continuationToken: input.continuationToken ?? null,
        trigger: input.trigger,
        scheduleId: input.scheduleId ?? null,
        status: "running",
        startedAt: now,
        completedAt: null,
      };
      state.sessions.push(session);
      const project = state.projects.find((candidate) => candidate.id === input.projectId);
      if (project) {
        project.latestSessionStatus = session.status;
        project.updatedAt = now;
      }
      return session;
    },

    async appendSessionEvent(sessionId, type, payload) {
      const event: SessionEvent = {
        id: createId("evt"),
        sessionId,
        index: state.sessionEvents.filter((candidate) => candidate.sessionId === sessionId).length,
        type,
        payload,
        createdAt: new Date().toISOString(),
      };
      state.sessionEvents.push(event);
      return event;
    },

    async completeSession(sessionId, input) {
      const session = state.sessions.find((candidate) => candidate.id === sessionId);
      if (!session) {
        return null;
      }

      const now = new Date().toISOString();
      session.status = input.status;
      session.eveSessionId = input.eveSessionId ?? session.eveSessionId;
      session.continuationToken = input.continuationToken ?? session.continuationToken;
      session.completedAt = input.status === "running" ? null : now;

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

    async listSessions(projectId) {
      return state.sessions.filter((session) => session.projectId === projectId);
    },

    async listSessionEvents(sessionId) {
      return state.sessionEvents.filter((event) => event.sessionId === sessionId).sort((a, b) => a.index - b.index);
    },

    async listLogs(projectId, type) {
      return state.logs.filter((log) => log.projectId === projectId && (!type || log.type === type));
    },
  };
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
