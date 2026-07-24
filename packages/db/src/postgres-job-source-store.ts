import { createId } from "@eveland/core/ids";
import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import {
  jobRowToJob,
  logRowToLog,
  projectRowToProject,
  sourceFileRowToSourceFile,
  sourceRevisionRowToSourceRevision,
} from "./mappers.js";
import {
  deployments,
  jobs,
  logs,
  projects,
  runtimeInstances,
  schedules,
  sourceFiles,
  sourceRevisions,
} from "./schema.js";

const defaultOwner = {
  id: "user_local_admin",
  email: "admin@example.com",
  name: "Local Admin",
};

import type {
  PostgresDomain,
  PostgresStoreContext,
} from "./postgres-store-support.js";

export function createPostgresJobSourceStore({
  db,
  ensureDeploymentRoutes,
  ensureDefaultOwner,
  createJob,
}: PostgresStoreContext): PostgresDomain {
  return {
    async enqueueJob(projectId, type, payload = {}) {
      return createJob(projectId, type, payload);
    },

    async listProjectJobs(projectId, options = {}) {
      const rows = await db
        .select()
        .from(jobs)
        .where(
          options.type
            ? and(eq(jobs.projectId, projectId), eq(jobs.type, options.type))
            : eq(jobs.projectId, projectId),
        )
        .orderBy(desc(jobs.createdAt))
        .limit(options.limit ?? 20);
      return rows.map(jobRowToJob);
    },

    async enqueueDeploymentArchive(projectId, deploymentId, options = {}) {
      return db.transaction(async (tx) => {
        const [deployment] = await tx
          .select({
            id: deployments.id,
            projectId: deployments.projectId,
          })
          .from(deployments)
          .where(eq(deployments.id, deploymentId))
          .limit(1)
          .for("update");
        if (!deployment || deployment.projectId !== projectId) {
          throw new Error("Deployment archive Project is invalid.");
        }
        const [existing] = await tx
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.projectId, projectId),
              eq(jobs.type, "archive_deployment"),
              or(eq(jobs.status, "queued"), eq(jobs.status, "running")),
              sql`${jobs.payload}->>'deploymentId' = ${deploymentId}`,
            ),
          )
          .orderBy(desc(jobs.createdAt))
          .limit(1);
        if (existing) {
          return { job: jobRowToJob(existing), created: false };
        }
        const [created] = await tx
          .insert(jobs)
          .values({
            id: createId("job"),
            projectId,
            type: "archive_deployment",
            status: "queued",
            payload: {
              deploymentId,
              ...(options.automatic ? { automatic: true } : {}),
            },
          })
          .returning();
        if (!created) throw new Error("Failed to enqueue Deployment archive.");
        return { job: jobRowToJob(created), created: true };
      });
    },

    async enqueueDeploymentActivation(
      projectId,
      deploymentId,
      runtimeInstanceId,
      now = new Date(),
      staleAfterMs = 300_000,
    ) {
      return db.transaction(async (tx) => {
        const [runtimeInstance] = await tx
          .select({
            id: runtimeInstances.id,
            deploymentId: runtimeInstances.deploymentId,
          })
          .from(runtimeInstances)
          .where(eq(runtimeInstances.id, runtimeInstanceId))
          .limit(1)
          .for("update");
        if (!runtimeInstance || runtimeInstance.deploymentId !== deploymentId) {
          throw new Error("Deployment activation RuntimeInstance is invalid.");
        }
        const [deployment] = await tx
          .select({ projectId: deployments.projectId })
          .from(deployments)
          .where(eq(deployments.id, deploymentId))
          .limit(1);
        if (!deployment || deployment.projectId !== projectId) {
          throw new Error("Deployment activation Project is invalid.");
        }
        const [existing] = await tx
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.projectId, projectId),
              eq(jobs.type, "ensure_deployment_running"),
              or(eq(jobs.status, "queued"), eq(jobs.status, "running")),
              sql`${jobs.payload}->>'runtimeInstanceId' = ${runtimeInstanceId}`,
            ),
          )
          .orderBy(desc(jobs.createdAt))
          .limit(1)
          .for("update");
        if (existing) {
          if (
            existing.status === "running" &&
            existing.updatedAt.getTime() <= now.getTime() - staleAfterMs
          ) {
            const [recovered] = await tx
              .update(jobs)
              .set({ status: "queued", lockedAt: null, updatedAt: now })
              .where(eq(jobs.id, existing.id))
              .returning();
            if (!recovered)
              throw new Error(
                "Failed to recover stale Deployment activation job.",
              );
            return jobRowToJob(recovered);
          }
          return jobRowToJob(existing);
        }
        const [created] = await tx
          .insert(jobs)
          .values({
            id: createId("job"),
            projectId,
            type: "ensure_deployment_running",
            status: "queued",
            payload: { deploymentId, runtimeInstanceId },
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!created)
          throw new Error("Failed to enqueue Deployment activation.");
        return jobRowToJob(created);
      });
    },

    async claimNextJob(_workerId, now = new Date()) {
      const [row] = await db
        .update(jobs)
        .set({
          status: "running",
          attempts: sql`${jobs.attempts} + 1`,
          lockedAt: now,
          updatedAt: now,
        })
        .where(
          eq(
            jobs.id,
            sql`(
              select candidate.id
              from ${jobs} candidate
              join ${projects} project on project.id = candidate.project_id
              where candidate.status = 'queued'
                and (
                  project.deletion_status is distinct from 'deleting'
                  or (
                    candidate.type = 'delete_project'
                    and not exists (
                      select 1 from ${jobs} running
                      where running.project_id = candidate.project_id
                        and running.id <> candidate.id
                        and running.status = 'running'
                    )
                  )
                )
              order by candidate.created_at asc
              limit 1
              for update skip locked
            )`,
          ),
        )
        .returning();

      return row ? jobRowToJob(row) : null;
    },

    async recoverStaleJobs(
      now = new Date(),
      staleAfterMs = 300_000,
      limit = 25,
    ) {
      const cutoff = new Date(now.getTime() - staleAfterMs);
      const recovered = await db
        .update(jobs)
        .set({ status: "queued", lockedAt: null, updatedAt: now })
        .where(
          inArray(
            jobs.id,
            db
              .select({ id: jobs.id })
              .from(jobs)
              .where(
                and(eq(jobs.status, "running"), lte(jobs.lockedAt, cutoff)),
              )
              .orderBy(asc(jobs.lockedAt))
              .limit(limit),
          ),
        )
        .returning({ id: jobs.id });
      return recovered.length;
    },

    async heartbeatJob(jobId, attempt, now = new Date()) {
      const renewed = await db
        .update(jobs)
        .set({ lockedAt: now, updatedAt: now })
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.status, "running"),
            eq(jobs.attempts, attempt),
          ),
        )
        .returning({ id: jobs.id });
      return renewed.length === 1;
    },

    async replaceJobPayload(jobId, payload, attempt) {
      const updated = await db
        .update(jobs)
        .set({ payload, updatedAt: new Date() })
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.status, "running"),
            eq(jobs.attempts, attempt),
          ),
        )
        .returning({ id: jobs.id });
      return updated.length === 1;
    },

    async completeJob(jobId, attempt) {
      const completed = await db
        .update(jobs)
        .set({
          status: "completed",
          updatedAt: new Date(),
          lockedAt: null,
        })
        .where(
          attempt === undefined
            ? eq(jobs.id, jobId)
            : and(
                eq(jobs.id, jobId),
                eq(jobs.status, "running"),
                eq(jobs.attempts, attempt),
              ),
        )
        .returning({ id: jobs.id });
      return completed.length === 1;
    },

    async failJob(jobId, error, attempt) {
      const failed = await db
        .update(jobs)
        .set({
          status: "failed",
          lastError: error,
          updatedAt: new Date(),
          lockedAt: null,
        })
        .where(
          attempt === undefined
            ? eq(jobs.id, jobId)
            : and(
                eq(jobs.id, jobId),
                eq(jobs.status, "running"),
                eq(jobs.attempts, attempt),
              ),
        )
        .returning({ id: jobs.id });
      return failed.length === 1;
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

      await db
        .delete(schedules)
        .where(eq(schedules.projectId, input.projectId));
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
          status: sql`case when ${projects.deploymentId} is null then 'imported' else ${projects.status} end`,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, input.projectId));

      return sourceRevisionRowToSourceRevision(revisionRow);
    },

    async getCurrentSourceRevision(projectId) {
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (!project?.sourceRevisionId) {
        return null;
      }

      const [revision] = await db
        .select()
        .from(sourceRevisions)
        .where(eq(sourceRevisions.id, project.sourceRevisionId))
        .limit(1);
      return revision ? sourceRevisionRowToSourceRevision(revision) : null;
    },

    async listSourceRevisions(projectId) {
      const rows = await db
        .select()
        .from(sourceRevisions)
        .where(eq(sourceRevisions.projectId, projectId));
      return rows.map(sourceRevisionRowToSourceRevision);
    },

    async getSourceRevision(revisionId) {
      const [revision] = await db
        .select()
        .from(sourceRevisions)
        .where(eq(sourceRevisions.id, revisionId))
        .limit(1);
      return revision ? sourceRevisionRowToSourceRevision(revision) : null;
    },

    async listSourceRevisionFiles(revisionId) {
      const rows = await db
        .select()
        .from(sourceFiles)
        .where(eq(sourceFiles.revisionId, revisionId))
        .orderBy(sourceFiles.path);
      return rows.map(sourceFileRowToSourceFile);
    },

    async listSourceFiles(projectId) {
      const revision = await this.getCurrentSourceRevision(projectId);
      if (!revision) {
        return [];
      }

      const rows = await db
        .select()
        .from(sourceFiles)
        .where(eq(sourceFiles.revisionId, revision.id))
        .orderBy(sourceFiles.path);
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
        .where(
          and(
            eq(sourceFiles.revisionId, revision.id),
            eq(sourceFiles.path, filePath),
          ),
        )
        .limit(1);
      return row ? sourceFileRowToSourceFile(row) : null;
    },
  };
}
