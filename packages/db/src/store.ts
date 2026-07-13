import { createId, createRoutingKey } from "@eveland/core/ids";
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
} from "@eveland/core/contracts";
import { parseStepUsageEvent, type ModelStepUsage } from "@eveland/core/eve";
import type { ObserverEnvelopeV1 } from "@eveland/core/observer";

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
  getDeployment(deploymentId: string): Promise<DeploymentRecord | null>;
  updateDeploymentStatus(deploymentId: string, status: DeploymentStatus): Promise<DeploymentRecord | null>;
  getRelease(releaseId: string): Promise<ReleaseRecord | null>;
  ensureDeploymentRoutes(projectId: string, deploymentId: string, baseDomain: string): Promise<AgentRoute[]>;
  reconcileAgentRoutes(baseDomain: string): Promise<void>;
  findRouteByHostname(hostname: string): Promise<ResolvedAgentRoute | null>;
  findProjectRoute(projectId: string): Promise<ResolvedAgentRoute | null>;
  listProjectRoutes(projectId: string): Promise<ResolvedAgentRoute[]>;
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
  listSessions(projectId: string): Promise<Session[]>;
  listSessionEvents(sessionId: string): Promise<SessionEvent[]>;
  listSessionNodes(sessionId: string): Promise<SessionNode[]>;
  ingestObserverEnvelope(envelope: ObserverEnvelopeV1): Promise<{ session: Session; node: SessionNode; event: SessionEvent; duplicate: boolean }>;
  listModelUsageEvents(sessionId: string): Promise<ModelUsageEvent[]>;
  listLogs(projectId: string, type?: LogRecord["type"]): Promise<LogRecord[]>;
};

export type StoreState = MemoryState;

type MemoryState = {
  projects: Project[];
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
};

export function createMemoryStore(initialState?: Partial<MemoryState>): Store {
  const state: MemoryState = {
    projects: initialState?.projects ?? [],
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
  };

  return {
    async listProjects() {
      return [...state.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async createProject(input) {
      const now = new Date().toISOString();
      const project: Project = {
        id: createId("proj"),
        routingKey: createRoutingKey("p"),
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
      // this project's revisions, the revisions themselves, usage events and
      // session events scoped to this project's sessions, the sessions, then
      // schedules/jobs/secrets, and the projects row last.
      state.logs = state.logs.filter((log) => log.projectId !== projectId);
      const routeIds = state.agentRoutes.filter((route) => route.projectId === projectId).map((route) => route.id);
      state.routeTargets = state.routeTargets.filter((target) => !routeIds.includes(target.routeId));
      state.agentRoutes = state.agentRoutes.filter((route) => route.projectId !== projectId);
      state.sessionBindings = state.sessionBindings.filter((binding) => binding.projectId !== projectId);
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
        deploymentKey: createRoutingKey("d"),
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

    async getDeployment(deploymentId) {
      return state.deployments.find((deployment) => deployment.id === deploymentId) ?? null;
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
        hostname: `${project.routingKey}.${domain}`,
        kind: "project",
      });
      const preview = upsertMemoryRoute(state, {
        projectId,
        hostname: `${deployment.deploymentKey}--${project.routingKey}.${domain}`,
        kind: "deployment",
        deploymentId,
      });
      state.routeTargets = state.routeTargets.filter((target) => target.routeId !== stable.id && target.routeId !== preview.id);
      state.routeTargets.push(
        { routeId: stable.id, deploymentId, weight: 10_000, variantName: null },
        { routeId: preview.id, deploymentId, weight: 10_000, variantName: null },
      );
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
        variantName: null,
        trigger: input.trigger,
        scheduleId: input.scheduleId ?? null,
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
          session.variantName = binding.variantName;
          session.deploymentId = binding.deploymentId;
        }
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

    async listSessionNodes(sessionId) {
      return state.sessionNodes.filter((node) => node.rootSessionId === sessionId);
    },

    async ingestObserverEnvelope(envelope) {
      const deployment = state.deployments.find((candidate) => candidate.id === envelope.deploymentId);
      if (!deployment) throw new Error(`Observer deployment ${envelope.deploymentId} is not managed by Eveland.`);

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
        variantName: parentBinding?.variantName ?? null,
        trigger: parentBinding?.trigger ?? "direct_http",
        scheduleId: null,
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
      variantName: binding?.variantName ?? null,
      trigger: binding?.trigger ?? triggerFromChannel(envelope.channelKind),
      scheduleId: null,
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
  const childEveSessionId = stringValue(asRecord(payload)?.childSessionId);
  if (!childEveSessionId) return;

  const existing = state.sessionNodes.find(
    (candidate) => candidate.projectId === parent.projectId && candidate.eveSessionId === childEveSessionId,
  );
  if (existing) {
    if (existing.rootSessionId !== parent.rootSessionId) mergeMemoryRootSessions(state, existing.rootSessionId, parent.rootSessionId);
    existing.rootSessionId = parent.rootSessionId;
    existing.parentNodeId = parent.id;
    existing.parentEveSessionId = parent.eveSessionId;
    existing.agentName = stringValue(asRecord(payload)?.name) ?? existing.agentName;
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
    agentName: stringValue(asRecord(payload)?.name),
    nodeId: null,
    channelKind: "subagent",
    modelId: null,
    eveVersion: null,
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
