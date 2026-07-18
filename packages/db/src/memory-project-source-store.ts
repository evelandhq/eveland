import type {
  GitCredentialRecord,
  Project,
  PublicGitCredential,
  SourcePreflight,
  SourcePreflightRecord,
  SourceRevision,
} from "@eveland/core/contracts";
import { claimProjectSlug, createId, slugifyProjectName } from "@eveland/core/ids";
import { createEveVersionInfo, readDeclaredEveVersion } from "@eveland/core/source";
import type { MemoryState } from "./memory-state.js";
import { createMemoryJob, type MemoryDomain } from "./memory-store-support.js";
import type { GitCredentialStore, ProjectStore, SourceStore } from "./store-domains.js";
import { DEFAULT_TEAM_ID, ProjectSlugConflictError, projectDeletionSourcePaths } from "./store-shared.js";

export function createMemoryProjectSourceStore(
  state: MemoryState,
): MemoryDomain<ProjectStore & SourceStore & GitCredentialStore> {
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
      state.jobs.push(createMemoryJob(project.id, "import_source", {
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
      for (const secret of input.secrets ?? []) {
        state.secrets.push({
          id: createId("secret"),
          projectId: project.id,
          key: secret.key,
          encryptedValue: secret.encryptedValue,
          createdAt: now,
          updatedAt: now,
        });
      }
      state.jobs.push(createMemoryJob(project.id, "import_source", {
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
      const job = createMemoryJob(projectId, "delete_project", { sourcePaths });
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
      state.platformSecretProfileBindings = state.platformSecretProfileBindings.filter(
        (binding) => binding.projectId !== projectId,
      );
      const connectionIds = state.agentConnections
        .filter((connection) => connection.target.projectId === projectId)
        .map((connection) => connection.id);
      state.agentAuthCredentials = state.agentAuthCredentials.filter(
        (credential) => !connectionIds.includes(credential.agentConnectionId),
      );
      state.agentAuthTransactions = state.agentAuthTransactions.filter(
        (transaction) => !connectionIds.includes(transaction.agentConnectionId),
      );
      state.agentConnections = state.agentConnections.filter((connection) => connection.target.projectId !== projectId);
      state.projects = state.projects.filter((project) => project.id !== projectId);
      return state.projects.length !== before;
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

  };
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
