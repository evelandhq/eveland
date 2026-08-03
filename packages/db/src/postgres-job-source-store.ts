import { createId } from "@eveland/core/ids";
import { decodeJobPayload } from "@eveland/core/jobs";
import type { Job, JobType } from "@eveland/core/contracts";
import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import {
  InvalidJobRecordError,
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
import type {
  EnqueueJobArguments,
  JobStore,
  LogStore,
  ProjectStore,
  SourceStore,
} from "./store-domains.js";
import type { PostgresStoreContext } from "./postgres-store-support.js";
import { insertJobRowTx } from "./postgres-store-support.js";

type PostgresJobSourceDomain = JobStore &
  Pick<ProjectStore, "updateProjectState"> &
  Pick<
    SourceStore,
    | "recordSourceRevision"
    | "getCurrentSourceRevision"
    | "listSourceRevisions"
    | "getSourceRevision"
    | "listSourceRevisionFiles"
    | "listSourceFiles"
    | "getSourceFile"
  > &
  Pick<LogStore, "appendLog">;

export function createPostgresJobSourceStore({
  db,
}: PostgresStoreContext): PostgresJobSourceDomain {
  const enqueueJob = async <Type extends JobType>(
    projectId: string,
    ...jobInput: EnqueueJobArguments<Type>
  ): Promise<Job<Type>> => {
    const [type, payloadInput] = jobInput;
    const row = await db.transaction((tx) =>
      insertJobRowTx(tx, { projectId, type, payload: payloadInput ?? {} }),
    );
    const job = jobRowToJob(row);
    if (job.type !== type) {
      throw new Error(`Enqueued job ${job.id} changed type at persistence.`);
    }
    return job as Job<Type>;
  };

  const getCurrentSourceRevision: SourceStore["getCurrentSourceRevision"] = async (projectId) => {
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project?.sourceRevisionId) return null;

    const [revision] = await db
      .select()
      .from(sourceRevisions)
      .where(eq(sourceRevisions.id, project.sourceRevisionId))
      .limit(1);
    return revision ? sourceRevisionRowToSourceRevision(revision) : null;
  };

  async function listProjectJobs(projectId: string, options?: { limit?: number }): Promise<Job[]>;
  async function listProjectJobs<Type extends JobType>(
    projectId: string,
    options: { type: Type; limit?: number },
  ): Promise<Job<Type>[]>;
  async function listProjectJobs(
    projectId: string,
    options: { type?: JobType; limit?: number } = {},
  ): Promise<Job[]> {
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
    const mapped = rows.map(jobRowToJob);
    if (options.type && mapped.some((job) => job.type !== options.type)) {
      throw new Error("Listed job changed type at persistence.");
    }
    return mapped;
  }

  return {
    enqueueJob,
    listProjectJobs,

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
        const created = await insertJobRowTx(tx, {
          projectId,
          type: "archive_deployment",
          payload: {
            deploymentId,
            ...(options.automatic ? { automatic: true } : {}),
          },
        });
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
            if (!recovered) throw new Error("Failed to recover stale Deployment activation job.");
            return jobRowToJob(recovered);
          }
          return jobRowToJob(existing);
        }
        const created = await insertJobRowTx(tx, {
          projectId,
          type: "ensure_deployment_running",
          payload: { deploymentId, runtimeInstanceId },
          createdAt: now,
          updatedAt: now,
        });
        if (!created) throw new Error("Failed to enqueue Deployment activation.");
        return jobRowToJob(created);
      });
    },

    async claimNextJob(_workerId, now = new Date()) {
      while (true) {
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
                  -- One running job per project: concurrent jobs for the same
                  -- project interleave stop/start/updateProjectState and race
                  -- host-port allocation, so a queued job waits until the
                  -- project's running job completes, fails, or is recovered as
                  -- stale. Other projects' jobs are unaffected.
                  and not exists (
                    select 1 from ${jobs} running
                    where running.project_id = candidate.project_id
                      and running.id <> candidate.id
                      and running.status = 'running'
                  )
                  and (
                    project.deletion_status is distinct from 'deleting'
                    or candidate.type = 'delete_project'
                  )
                order by candidate.created_at asc, candidate.sequence asc
                limit 1
                for update skip locked
              )`,
            ),
          )
          .returning();

        if (!row) return null;
        try {
          return jobRowToJob(row);
        } catch (error) {
          if (!(error instanceof InvalidJobRecordError)) throw error;
          const quarantined = await db
            .update(jobs)
            .set({
              status: "failed",
              lastError: `Invalid persisted job contract for ${row.id}.`,
              lockedAt: null,
              updatedAt: now,
            })
            .where(
              and(eq(jobs.id, row.id), eq(jobs.status, "running"), eq(jobs.attempts, row.attempts)),
            )
            .returning({ id: jobs.id });
          if (quarantined.length !== 1) {
            throw new Error(`Failed to quarantine invalid job ${row.id}.`);
          }
        }
      }
    },

    async recoverStaleJobs(now = new Date(), staleAfterMs = 300_000, limit = 25) {
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
              .where(and(eq(jobs.status, "running"), lte(jobs.lockedAt, cutoff)))
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
        .where(and(eq(jobs.id, jobId), eq(jobs.status, "running"), eq(jobs.attempts, attempt)))
        .returning({ id: jobs.id });
      return renewed.length === 1;
    },

    async replaceJobPayload(jobId, type, payload, attempt) {
      const decodedPayload = decodeJobPayload(type, payload);
      const updated = await db
        .update(jobs)
        .set({ payload: decodedPayload, updatedAt: new Date() })
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.type, type),
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
            : and(eq(jobs.id, jobId), eq(jobs.status, "running"), eq(jobs.attempts, attempt)),
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
            : and(eq(jobs.id, jobId), eq(jobs.status, "running"), eq(jobs.attempts, attempt)),
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
      // Recording a revision is all-or-nothing: it replaces the project's
      // schedules and then repoints the project at the new revision. Run
      // outside a transaction, a failure between those steps left a project
      // with no schedules, or a source pointer disagreeing with what is
      // actually stored.
      return db.transaction(async (tx) => {
        const [revisionRow] = await tx
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
          await tx.insert(sourceFiles).values(
            input.files.map((file) => ({
              id: createId("file"),
              revisionId: revisionRow.id,
              path: file.path,
              content: file.content,
              size: Buffer.byteLength(file.content),
            })),
          );
        }

        await tx.delete(schedules).where(eq(schedules.projectId, input.projectId));
        if (input.schedules.length > 0) {
          await tx.insert(schedules).values(
            input.schedules.map((schedule) => ({
              id: createId("sch"),
              projectId: input.projectId,
              ...schedule,
              nextRunAt: schedule.nextRunAt ? new Date(schedule.nextRunAt) : null,
            })),
          );
        }

        await tx
          .update(projects)
          .set({
            sourceRevisionId: revisionRow.id,
            status: sql`case when ${projects.deploymentId} is null then 'imported' else ${projects.status} end`,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, input.projectId));

        return sourceRevisionRowToSourceRevision(revisionRow);
      });
    },

    getCurrentSourceRevision,

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
      const revision = await getCurrentSourceRevision(projectId);
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
      const revision = await getCurrentSourceRevision(projectId);
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
  };
}
