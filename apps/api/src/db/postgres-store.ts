import { and, desc, eq, sql } from "drizzle-orm";
import { createId } from "@eveland/shared/ids";
import type { Database } from "./client.js";
import {
  deploymentRowToDeployment,
  jobRowToJob,
  logRowToLog,
  projectRowToProject,
  releaseRowToRelease,
  secretRowToSecretRecord,
  scheduleRowToSchedule,
  secretRowToPublicSecret,
  sessionEventRowToSessionEvent,
  sessionRowToSession,
  sourceFileRowToSourceFile,
  sourceRevisionRowToSourceRevision,
} from "./mappers.js";
import { deployments, jobs, logs, projects, releases, schedules, secrets, sessionEvents, sessions, sourceFiles, sourceRevisions, users } from "./schema.js";
import type { CreateProjectInput, Store } from "../store.js";
import type { JobType, LogRecord } from "../types.js";

const defaultOwner = {
  id: "user_local_admin",
  email: "admin@localhost",
  name: "Local Admin",
};

export function createPostgresStore(database: Database): Store {
  const { db } = database;

  async function ensureDefaultOwner() {
    await db
      .insert(users)
      .values(defaultOwner)
      .onConflictDoNothing({
        target: users.id,
      });
  }

  async function createJob(projectId: string, type: JobType, payload: Record<string, unknown>) {
    const [row] = await db
      .insert(jobs)
      .values({
        id: createId("job"),
        projectId,
        type,
        status: "queued",
        payload,
      })
      .returning();

    if (!row) {
      throw new Error("Failed to create job.");
    }

    return jobRowToJob(row);
  }

  return {
    async listProjects() {
      const rows = await db.select().from(projects).orderBy(desc(projects.updatedAt));
      return rows.map(projectRowToProject);
    },

    async createProject(input: CreateProjectInput) {
      await ensureDefaultOwner();
      const [row] = await db
        .insert(projects)
        .values({
          id: createId("proj"),
          ownerId: defaultOwner.id,
          name: input.name,
          importKind: input.importKind,
          gitUrl: input.gitUrl ?? null,
          status: "import_pending",
          deploymentStatus: "not_deployed",
        })
        .returning();

      if (!row) {
        throw new Error("Failed to create project.");
      }

      await createJob(row.id, "import_source", {
        importKind: input.importKind,
        gitUrl: input.gitUrl ?? null,
        sourcePath: input.sourcePath ?? null,
      });

      return projectRowToProject(row);
    },

    async getProject(projectId) {
      const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      return row ? projectRowToProject(row) : null;
    },

    async deleteProject(projectId) {
      await db.delete(logs).where(eq(logs.projectId, projectId));
      await db.delete(deployments).where(eq(deployments.projectId, projectId));
      await db.delete(releases).where(eq(releases.projectId, projectId));
      const relatedRevisions = await db.select({ id: sourceRevisions.id }).from(sourceRevisions).where(eq(sourceRevisions.projectId, projectId));
      for (const revision of relatedRevisions) {
        await db.delete(sourceFiles).where(eq(sourceFiles.revisionId, revision.id));
      }
      await db.delete(sourceRevisions).where(eq(sourceRevisions.projectId, projectId));
      const relatedSessions = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.projectId, projectId));
      for (const session of relatedSessions) {
        await db.delete(sessionEvents).where(eq(sessionEvents.sessionId, session.id));
      }
      await db.delete(sessions).where(eq(sessions.projectId, projectId));
      await db.delete(schedules).where(eq(schedules.projectId, projectId));
      await db.delete(jobs).where(eq(jobs.projectId, projectId));
      await db.delete(secrets).where(eq(secrets.projectId, projectId));
      const deleted = await db.delete(projects).where(eq(projects.id, projectId)).returning({ id: projects.id });
      return deleted.length > 0;
    },

    async listSecrets(projectId) {
      const rows = await db.select().from(secrets).where(eq(secrets.projectId, projectId)).orderBy(desc(secrets.updatedAt));
      return rows.map(secretRowToPublicSecret);
    },

    async upsertSecret(projectId, key, value) {
      const now = new Date();
      const [row] = await db
        .insert(secrets)
        .values({
          id: createId("secret"),
          projectId,
          key,
          encryptedValue: value,
        })
        .onConflictDoUpdate({
          target: [secrets.projectId, secrets.key],
          set: {
            encryptedValue: value,
            updatedAt: now,
          },
        })
        .returning();

      if (!row) {
        throw new Error("Failed to upsert secret.");
      }

      return secretRowToPublicSecret(row);
    },

    async deleteSecret(projectId, secretId) {
      const deleted = await db
        .delete(secrets)
        .where(and(eq(secrets.projectId, projectId), eq(secrets.id, secretId)))
        .returning({ id: secrets.id });
      return deleted.length > 0;
    },

    async listSecretRecords(projectId) {
      const rows = await db.select().from(secrets).where(eq(secrets.projectId, projectId));
      return rows.map(secretRowToSecretRecord);
    },

    async enqueueJob(projectId, type, payload = {}) {
      return createJob(projectId, type, payload);
    },

    async claimNextJob(_workerId) {
      const [row] = await db
        .update(jobs)
        .set({
          status: "running",
          attempts: sql`${jobs.attempts} + 1`,
          lockedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          eq(
            jobs.id,
            sql`(
              select id
              from ${jobs}
              where status = 'queued'
              order by created_at asc
              limit 1
              for update skip locked
            )`,
          ),
        )
        .returning();

      return row ? jobRowToJob(row) : null;
    },

    async completeJob(jobId) {
      await db
        .update(jobs)
        .set({
          status: "completed",
          updatedAt: new Date(),
          lockedAt: null,
        })
        .where(eq(jobs.id, jobId));
    },

    async failJob(jobId, error) {
      await db
        .update(jobs)
        .set({
          status: "failed",
          lastError: error,
          updatedAt: new Date(),
          lockedAt: null,
        })
        .where(eq(jobs.id, jobId));
    },

    async updateProjectState(projectId, state) {
      const [row] = await db
        .update(projects)
        .set({
          status: state.status,
          deploymentStatus: state.deploymentStatus,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId))
        .returning();

      return row ? projectRowToProject(row) : null;
    },

    async appendLog(input) {
      const [row] = await db
        .insert(logs)
        .values({
          id: createId("log"),
          projectId: input.projectId,
          deploymentId: input.deploymentId ?? null,
          type: input.type,
          line: input.line,
        })
        .returning();

      if (!row) {
        throw new Error("Failed to append log.");
      }

      return logRowToLog(row);
    },

    async recordSourceRevision(input) {
      const [revisionRow] = await db
        .insert(sourceRevisions)
        .values({
          id: createId("src"),
          projectId: input.projectId,
          kind: input.kind,
          commitSha: input.commitSha ?? null,
          sourcePath: input.sourcePath,
          summary: input.summary,
          envVars: input.envVars,
        })
        .returning();

      if (!revisionRow) {
        throw new Error("Failed to create source revision.");
      }

      if (input.files.length > 0) {
        await db.insert(sourceFiles).values(
          input.files.map((file) => ({
            id: createId("file"),
            revisionId: revisionRow.id,
            path: file.path,
            content: file.content,
            size: Buffer.byteLength(file.content),
          })),
        );
      }

      await db.delete(schedules).where(eq(schedules.projectId, input.projectId));
      if (input.schedules.length > 0) {
        await db.insert(schedules).values(
          input.schedules.map((schedule) => ({
            id: createId("sch"),
            projectId: input.projectId,
            ...schedule,
            nextRunAt: schedule.nextRunAt ? new Date(schedule.nextRunAt) : null,
          })),
        );
      }

      await db
        .update(projects)
        .set({
          sourceRevisionId: revisionRow.id,
          status: "imported",
          updatedAt: new Date(),
        })
        .where(eq(projects.id, input.projectId));

      return sourceRevisionRowToSourceRevision(revisionRow);
    },

    async getCurrentSourceRevision(projectId) {
      const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      if (!project?.sourceRevisionId) {
        return null;
      }

      const [revision] = await db.select().from(sourceRevisions).where(eq(sourceRevisions.id, project.sourceRevisionId)).limit(1);
      return revision ? sourceRevisionRowToSourceRevision(revision) : null;
    },

    async getSourceRevision(revisionId) {
      const [revision] = await db.select().from(sourceRevisions).where(eq(sourceRevisions.id, revisionId)).limit(1);
      return revision ? sourceRevisionRowToSourceRevision(revision) : null;
    },

    async listSourceFiles(projectId) {
      const revision = await this.getCurrentSourceRevision(projectId);
      if (!revision) {
        return [];
      }

      const rows = await db.select().from(sourceFiles).where(eq(sourceFiles.revisionId, revision.id)).orderBy(sourceFiles.path);
      return rows.map(sourceFileRowToSourceFile);
    },

    async getSourceFile(projectId, filePath) {
      const revision = await this.getCurrentSourceRevision(projectId);
      if (!revision) {
        return null;
      }

      const [row] = await db
        .select()
        .from(sourceFiles)
        .where(and(eq(sourceFiles.revisionId, revision.id), eq(sourceFiles.path, filePath)))
        .limit(1);
      return row ? sourceFileRowToSourceFile(row) : null;
    },

    async recordDeployment(input) {
      const [releaseRow] = await db
        .insert(releases)
        .values({
          id: input.releaseId ?? createId("rel"),
          projectId: input.projectId,
          sourceRevisionId: input.sourceRevisionId,
          imageTag: input.imageTag,
        })
        .returning();

      if (!releaseRow) {
        throw new Error("Failed to create release.");
      }

      const [deploymentRow] = await db
        .insert(deployments)
        .values({
          id: input.deploymentId ?? createId("dep"),
          projectId: input.projectId,
          releaseId: releaseRow.id,
          containerName: input.containerName,
          internalPort: input.internalPort,
          hostPort: input.hostPort,
          status: "running",
          runtimeKind: input.runtimeKind,
        })
        .returning();

      if (!deploymentRow) {
        throw new Error("Failed to create deployment.");
      }

      await db
        .update(projects)
        .set({
          status: "deployed",
          deploymentStatus: "running",
          releaseId: releaseRow.id,
          deploymentId: deploymentRow.id,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, input.projectId));

      return deploymentRowToDeployment(deploymentRow);
    },

    async getCurrentDeployment(projectId) {
      const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      if (!project?.deploymentId) {
        return null;
      }

      const [deployment] = await db.select().from(deployments).where(eq(deployments.id, project.deploymentId)).limit(1);
      return deployment ? deploymentRowToDeployment(deployment) : null;
    },

    async getRelease(releaseId) {
      const [release] = await db.select().from(releases).where(eq(releases.id, releaseId)).limit(1);
      return release ? releaseRowToRelease(release) : null;
    },

    async createSession(input) {
      const [row] = await db
        .insert(sessions)
        .values({
          id: createId("sess"),
          projectId: input.projectId,
          deploymentId: input.deploymentId ?? null,
          eveSessionId: input.eveSessionId ?? null,
          continuationToken: input.continuationToken ?? null,
          trigger: input.trigger,
          scheduleId: input.scheduleId ?? null,
          status: "running",
        })
        .returning();

      if (!row) {
        throw new Error("Failed to create session.");
      }

      await db
        .update(projects)
        .set({
          latestSessionStatus: "running",
          updatedAt: new Date(),
        })
        .where(eq(projects.id, input.projectId));

      return sessionRowToSession(row);
    },

    async appendSessionEvent(sessionId, type, payload) {
      const existingEvents = await db.select({ index: sessionEvents.index }).from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId));
      const [row] = await db
        .insert(sessionEvents)
        .values({
          id: createId("evt"),
          sessionId,
          index: existingEvents.length,
          type,
          payload,
        })
        .returning();

      if (!row) {
        throw new Error("Failed to append session event.");
      }

      return sessionEventRowToSessionEvent(row);
    },

    async completeSession(sessionId, input) {
      const [row] = await db
        .update(sessions)
        .set({
          status: input.status,
          eveSessionId: input.eveSessionId,
          continuationToken: input.continuationToken,
          completedAt: input.status === "running" ? null : new Date(),
        })
        .where(eq(sessions.id, sessionId))
        .returning();

      if (!row) {
        return null;
      }

      await db
        .update(projects)
        .set({
          latestSessionStatus: input.status,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, row.projectId));

      return sessionRowToSession(row);
    },

    async listSchedules(projectId) {
      const rows = await db.select().from(schedules).where(eq(schedules.projectId, projectId)).orderBy(schedules.name);
      return rows.map(scheduleRowToSchedule);
    },

    async listSessions(projectId) {
      const rows = await db.select().from(sessions).where(eq(sessions.projectId, projectId)).orderBy(desc(sessions.startedAt));
      return rows.map(sessionRowToSession);
    },

    async listSessionEvents(sessionId) {
      const rows = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId)).orderBy(sessionEvents.index);
      return rows.map(sessionEventRowToSessionEvent);
    },

    async listLogs(projectId, type?: LogRecord["type"]) {
      const rows = await db
        .select()
        .from(logs)
        .where(type ? and(eq(logs.projectId, projectId), eq(logs.type, type)) : eq(logs.projectId, projectId))
        .orderBy(logs.createdAt);
      return rows.map(logRowToLog);
    },
  };
}
