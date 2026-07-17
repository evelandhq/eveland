import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { claimDeploymentKey, claimProjectSlug, createId } from "@eveland/core/ids";
import { parseStepUsageEvent } from "@eveland/core/eve";
import { ObserverEnvelopeRejectedError, type ObserverEnvelopeV1 } from "@eveland/core/observer";
import type { Database } from "./client.js";
import {
  deploymentRowToDeployment,
  agentRouteRowToAgentRoute,
  jobRowToJob,
  logRowToLog,
  projectRowToProject,
  releaseRowToRelease,
  secretRowToSecretRecord,
  scheduleRowToSchedule,
  secretRowToPublicSecret,
  sessionEventRowToSessionEvent,
  sessionNodeRowToSessionNode,
  sessionRowToSession,
  sourceFileRowToSourceFile,
  sourceRevisionRowToSourceRevision,
  sessionBindingRowToSessionBinding,
  projectScheduleRowToProjectSchedule,
  scheduleVersionRowToScheduleVersion,
  projectSchedulerTargetRowToProjectSchedulerTarget,
  scheduleRunRowToScheduleRun,
  runtimeInstanceRowToRuntimeInstance,
  activationLeaseRowToActivationLease,
} from "./mappers.js";
import {
  deployments,
  agentRoutes,
  jobs,
  logs,
  modelUsageEvents,
  projects,
  releases,
  schedules,
  secrets,
  sessionEvents,
  sessionBindings,
  sessionNodes,
  sessions,
  sourceFiles,
  sourceRevisions,
  routeTargets,
  teams,
  users,
  projectSchedules,
  scheduleVersions,
  projectSchedulerTargets,
  scheduleRuns,
  runtimeInstances,
  activationLeases,
} from "./schema.js";
import {
  DEFAULT_TEAM_ID,
  RuntimeInstanceDrainingError,
  projectDeletionSourcePaths,
  type CreateProjectInput,
  type Store,
} from "./store.js";
import { summarizeSessionUsage } from "./session-usage.js";
import type {
  DeploymentStatus,
  JobType,
  LogRecord,
  SessionStatus,
  SessionTrigger,
} from "@eveland/core/contracts";
import { validateRouteTargets } from "@eveland/core/routing";
import { getNextRunAt } from "@eveland/core/schedules";
import { createEveVersionInfo, readDeclaredEveVersion } from "@eveland/core/source";

const defaultOwner = {
  id: "user_local_admin",
  email: "admin@example.com",
  name: "Local Admin",
};

export function createPostgresStore(database: Database): Store {
  const { db } = database;

  async function ensureDeploymentRoutes(projectId: string, deploymentId: string, baseDomain: string) {
    const domain = normalizeBaseDomain(baseDomain);
    return db.transaction(async (tx) => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      const [deployment] = await tx
        .select()
        .from(deployments)
        .where(and(eq(deployments.id, deploymentId), eq(deployments.projectId, projectId)))
        .limit(1);
      if (!project || !deployment) throw new Error("Cannot create Agent routes for an unknown project or deployment.");

      let [stable] = await tx
        .select()
        .from(agentRoutes)
        .where(and(eq(agentRoutes.projectId, projectId), eq(agentRoutes.kind, "project")))
        .limit(1);
      if (stable) {
        [stable] = await tx
          .update(agentRoutes)
          .set({ hostname: `${project.slug}.${domain}`, enabled: true, updatedAt: new Date() })
          .where(eq(agentRoutes.id, stable.id))
          .returning();
      } else {
        [stable] = await tx
          .insert(agentRoutes)
          .values({
            id: createId("route"),
            projectId,
            hostname: `${project.slug}.${domain}`,
            kind: "project",
            enabled: true,
            policyRevision: 1,
          })
          .returning();
      }
      if (!stable) throw new Error("Failed to materialize the stable Agent route.");

      const [previewMatch] = await tx
        .select({ route: agentRoutes })
        .from(agentRoutes)
        .innerJoin(routeTargets, eq(routeTargets.routeId, agentRoutes.id))
        .where(
          and(
            eq(agentRoutes.projectId, projectId),
            eq(agentRoutes.kind, "deployment"),
            eq(routeTargets.deploymentId, deploymentId),
          ),
        )
        .limit(1);
      let preview = previewMatch?.route;
      if (preview) {
        [preview] = await tx
          .update(agentRoutes)
          .set({ hostname: `${deployment.deploymentKey}--${project.slug}.${domain}`, enabled: true, updatedAt: new Date() })
          .where(eq(agentRoutes.id, preview.id))
          .returning();
      } else {
        [preview] = await tx
          .insert(agentRoutes)
          .values({
            id: createId("route"),
            projectId,
            hostname: `${deployment.deploymentKey}--${project.slug}.${domain}`,
            kind: "deployment",
            enabled: true,
            policyRevision: 1,
          })
          .returning();
      }
      if (!preview) throw new Error("Failed to materialize the deployment preview route.");

      const [existingStableTarget] = await tx.select().from(routeTargets).where(eq(routeTargets.routeId, stable.id)).limit(1);
      if (!existingStableTarget) {
        await tx.insert(routeTargets).values({ routeId: stable.id, deploymentId, weight: 10_000, variantName: null });
      }
      await tx
        .insert(routeTargets)
        .values({ routeId: preview.id, deploymentId, weight: 10_000, variantName: null })
        .onConflictDoUpdate({
          target: [routeTargets.routeId, routeTargets.deploymentId],
          set: { weight: 10_000, variantName: null },
        });
      return [agentRouteRowToAgentRoute(stable), agentRouteRowToAgentRoute(preview)];
    });
  }

  async function ensureDefaultOwner() {
    await db.transaction(async (tx) => {
      await tx.insert(teams).values({ id: DEFAULT_TEAM_ID, name: "Eveland", slug: "eveland" }).onConflictDoNothing({ target: teams.id });
      await tx.insert(users).values(defaultOwner).onConflictDoNothing({ target: users.id });
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
      const row = await claimProjectSlug(input.name, async (slug) => {
        try {
          const [claimed] = await db
            .insert(projects)
            .values({
              id: createId("proj"),
              slug,
              ownerId: defaultOwner.id,
              name: slug,
              importKind: input.importKind,
              gitUrl: input.gitUrl ?? null,
              status: "import_pending",
              deploymentStatus: "not_deployed",
            })
            .returning();
          if (!claimed) throw new Error("Failed to create project.");
          return claimed;
        } catch (error) {
          if (isUniqueConstraint(error, "projects_slug_unique")) return null;
          throw error;
        }
      });

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

    async requestProjectDeletion(projectId) {
      return db.transaction(async (tx) => {
        const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1).for("update");
        if (!project) return { outcome: "not_found" } as const;
        if (project.deletionStatus === "deleting") return { outcome: "already_deleting" } as const;

        const deletionInputs = await tx
          .select({ payload: jobs.payload })
          .from(jobs)
          .where(and(eq(jobs.projectId, projectId), or(eq(jobs.status, "queued"), eq(jobs.type, "delete_project"))));
        const sourcePaths = projectDeletionSourcePaths(deletionInputs.map((input) => input.payload));
        await tx
          .update(projects)
          .set({ deletionStatus: "deleting", deletionError: null, updatedAt: new Date() })
          .where(eq(projects.id, projectId));
        await tx.delete(jobs).where(and(eq(jobs.projectId, projectId), eq(jobs.status, "queued")));
        const [row] = await tx
          .insert(jobs)
          .values({ id: createId("job"), projectId, type: "delete_project", status: "queued", payload: { sourcePaths } })
          .returning();
        if (!row) throw new Error("Failed to create project deletion job.");
        return { outcome: "queued", job: jobRowToJob(row) } as const;
      });
    },

    async setProjectDeletionFailed(projectId, error) {
      const [row] = await db
        .update(projects)
        .set({ deletionStatus: "failed", deletionError: error, updatedAt: new Date() })
        .where(eq(projects.id, projectId))
        .returning();
      return row ? projectRowToProject(row) : null;
    },

    async deleteProject(projectId) {
      // Wrapped in a transaction: this cascade is ~12 sequential statements, and
      // a crash partway through previously left a half-deleted project -- e.g.
      // the delete_project job's own row (deleted a few statements before the
      // projects row) gone while the projects row it targets survives, losing
      // the retry trail. All-or-nothing keeps a crash mid-cascade a no-op.
      return db.transaction(async (tx) => {
        await tx.delete(logs).where(eq(logs.projectId, projectId));
        const relatedSessions = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.projectId, projectId));
        for (const session of relatedSessions) {
          await tx.delete(modelUsageEvents).where(eq(modelUsageEvents.sessionId, session.id));
          await tx.delete(sessionEvents).where(eq(sessionEvents.sessionId, session.id));
        }
        await tx.delete(sessionNodes).where(eq(sessionNodes.projectId, projectId));
        await tx.delete(sessions).where(eq(sessions.projectId, projectId));
        const relatedRoutes = await tx.select({ id: agentRoutes.id }).from(agentRoutes).where(eq(agentRoutes.projectId, projectId));
        await tx.delete(sessionBindings).where(eq(sessionBindings.projectId, projectId));
        for (const route of relatedRoutes) await tx.delete(routeTargets).where(eq(routeTargets.routeId, route.id));
        await tx.delete(agentRoutes).where(eq(agentRoutes.projectId, projectId));
        const relatedProjectSchedules = await tx
          .select({ id: projectSchedules.id })
          .from(projectSchedules)
          .where(eq(projectSchedules.projectId, projectId));
        for (const schedule of relatedProjectSchedules) {
          await tx.delete(scheduleRuns).where(eq(scheduleRuns.scheduleId, schedule.id));
          await tx.delete(scheduleVersions).where(eq(scheduleVersions.scheduleId, schedule.id));
        }
        await tx.delete(projectSchedulerTargets).where(eq(projectSchedulerTargets.projectId, projectId));
        await tx.delete(projectSchedules).where(eq(projectSchedules.projectId, projectId));
        await tx.delete(deployments).where(eq(deployments.projectId, projectId));
        await tx.delete(releases).where(eq(releases.projectId, projectId));
        const relatedRevisions = await tx.select({ id: sourceRevisions.id }).from(sourceRevisions).where(eq(sourceRevisions.projectId, projectId));
        for (const revision of relatedRevisions) {
          await tx.delete(sourceFiles).where(eq(sourceFiles.revisionId, revision.id));
        }
        await tx.delete(sourceRevisions).where(eq(sourceRevisions.projectId, projectId));
        await tx.delete(schedules).where(eq(schedules.projectId, projectId));
        await tx.delete(jobs).where(eq(jobs.projectId, projectId));
        await tx.delete(secrets).where(eq(secrets.projectId, projectId));
        const deleted = await tx.delete(projects).where(eq(projects.id, projectId)).returning({ id: projects.id });
        return deleted.length > 0;
      });
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

    async listProjectJobs(projectId, options = {}) {
      const rows = await db
        .select()
        .from(jobs)
        .where(options.type ? and(eq(jobs.projectId, projectId), eq(jobs.type, options.type)) : eq(jobs.projectId, projectId))
        .orderBy(desc(jobs.createdAt))
        .limit(options.limit ?? 20);
      return rows.map(jobRowToJob);
    },

    async enqueueDeploymentActivation(projectId, deploymentId, runtimeInstanceId, now = new Date(), staleAfterMs = 300_000) {
      return db.transaction(async (tx) => {
        const [runtimeInstance] = await tx
          .select({ id: runtimeInstances.id, deploymentId: runtimeInstances.deploymentId })
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
          if (existing.status === "running" && existing.updatedAt.getTime() <= now.getTime() - staleAfterMs) {
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
        if (!created) throw new Error("Failed to enqueue Deployment activation.");
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
          status: sql`case when ${projects.deploymentId} is null then 'imported' else ${projects.status} end`,
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

    async listSourceRevisions(projectId) {
      const rows = await db.select().from(sourceRevisions).where(eq(sourceRevisions.projectId, projectId));
      return rows.map(sourceRevisionRowToSourceRevision);
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

      const deploymentRow = await claimDeploymentKey(async (deploymentKey) => {
        try {
          const [claimed] = await db
            .insert(deployments)
            .values({
              id: input.deploymentId ?? createId("dep"),
              deploymentKey,
              projectId: input.projectId,
              releaseId: releaseRow.id,
              containerName: input.containerName,
              internalPort: input.internalPort,
              hostPort: input.hostPort,
              status: "running",
              runtimeKind: input.runtimeKind,
            })
            .returning();
          if (!claimed) throw new Error("Failed to create deployment.");
          return claimed;
        } catch (error) {
          if (isUniqueConstraint(error, "deployments_project_key_idx")) return null;
          throw error;
        }
      });

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

    async listDeployments(projectId) {
      const rows = await db
        .select()
        .from(deployments)
        .where(eq(deployments.projectId, projectId))
        .orderBy(desc(deployments.createdAt), desc(deployments.id));
      return rows.map(deploymentRowToDeployment);
    },

    async getDeployment(deploymentId) {
      const [deployment] = await db.select().from(deployments).where(eq(deployments.id, deploymentId)).limit(1);
      return deployment ? deploymentRowToDeployment(deployment) : null;
    },

    async getDeploymentEveVersion(deploymentId) {
      const [record] = await db
        .select({
          sourceRevisionId: sourceRevisions.id,
          summary: sourceRevisions.summary,
        })
        .from(deployments)
        .innerJoin(releases, eq(releases.id, deployments.releaseId))
        .innerJoin(sourceRevisions, eq(sourceRevisions.id, releases.sourceRevisionId))
        .where(eq(deployments.id, deploymentId))
        .limit(1);
      if (!record) return null;
      const summary = record.summary && typeof record.summary === "object"
        ? record.summary as Record<string, unknown>
        : {};
      let version = typeof summary.eveVersion === "string" ? summary.eveVersion : null;
      if (!version) {
        const [packageJson] = await db
          .select({ path: sourceFiles.path, content: sourceFiles.content })
          .from(sourceFiles)
          .where(and(eq(sourceFiles.revisionId, record.sourceRevisionId), eq(sourceFiles.path, "package.json")))
          .limit(1);
        if (packageJson) version = readDeclaredEveVersion([packageJson]);
      }
      return createEveVersionInfo(version, record.sourceRevisionId);
    },

    async getDeploymentByContainerName(containerName) {
      const [deployment] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.containerName, containerName))
        .orderBy(desc(deployments.createdAt), desc(deployments.id))
        .limit(1);
      return deployment ? deploymentRowToDeployment(deployment) : null;
    },

    async updateDeploymentStatus(deploymentId, status) {
      const [deployment] = await db
        .update(deployments)
        .set({ status, updatedAt: new Date() })
        .where(eq(deployments.id, deploymentId))
        .returning();
      return deployment ? deploymentRowToDeployment(deployment) : null;
    },

    async getRelease(releaseId) {
      const [release] = await db.select().from(releases).where(eq(releases.id, releaseId)).limit(1);
      return release ? releaseRowToRelease(release) : null;
    },

    ensureDeploymentRoutes,

    async reconcileAgentRoutes(baseDomain) {
      const rows = await db.select({ projectId: projects.id, deploymentId: projects.deploymentId }).from(projects);
      for (const row of rows) {
        if (row.deploymentId) await ensureDeploymentRoutes(row.projectId, row.deploymentId, baseDomain);
      }
    },

    async findRouteByHostname(hostname) {
      const [route] = await db.select().from(agentRoutes).where(eq(agentRoutes.hostname, hostname.toLowerCase())).limit(1);
      if (!route) return null;
      const targets = await db
        .select({
          routeId: routeTargets.routeId,
          deploymentId: routeTargets.deploymentId,
          weight: routeTargets.weight,
          variantName: routeTargets.variantName,
          hostPort: deployments.hostPort,
          status: deployments.status,
        })
        .from(routeTargets)
        .innerJoin(deployments, eq(deployments.id, routeTargets.deploymentId))
        .where(eq(routeTargets.routeId, route.id));
      return {
        ...agentRouteRowToAgentRoute(route),
        targets: targets.map((target) => ({ ...target, status: target.status as DeploymentStatus })),
      };
    },

    async findProjectRoute(projectId) {
      const [route] = await db
        .select()
        .from(agentRoutes)
        .where(and(eq(agentRoutes.projectId, projectId), eq(agentRoutes.kind, "project")))
        .limit(1);
      if (!route) return null;
      const targets = await db
        .select({
          routeId: routeTargets.routeId,
          deploymentId: routeTargets.deploymentId,
          weight: routeTargets.weight,
          variantName: routeTargets.variantName,
          hostPort: deployments.hostPort,
          status: deployments.status,
        })
        .from(routeTargets)
        .innerJoin(deployments, eq(deployments.id, routeTargets.deploymentId))
        .where(eq(routeTargets.routeId, route.id));
      return {
        ...agentRouteRowToAgentRoute(route),
        targets: targets.map((target) => ({ ...target, status: target.status as DeploymentStatus })),
      };
    },

    async listProjectRoutes(projectId) {
      const routeRows = await db.select().from(agentRoutes).where(eq(agentRoutes.projectId, projectId));
      const resolved = [];
      for (const route of routeRows) {
        const targets = await db
          .select({
            routeId: routeTargets.routeId,
            deploymentId: routeTargets.deploymentId,
            weight: routeTargets.weight,
            variantName: routeTargets.variantName,
            hostPort: deployments.hostPort,
            status: deployments.status,
          })
          .from(routeTargets)
          .innerJoin(deployments, eq(deployments.id, routeTargets.deploymentId))
          .where(eq(routeTargets.routeId, route.id));
        resolved.push({
          ...agentRouteRowToAgentRoute(route),
          targets: targets.map((target) => ({ ...target, status: target.status as DeploymentStatus })),
        });
      }
      return resolved;
    },

    async updateRouteTargets(routeId, targets) {
      validateRouteTargets(targets);
      await db.transaction(async (tx) => {
        const [route] = await tx.select().from(agentRoutes).where(eq(agentRoutes.id, routeId)).limit(1);
        if (!route) throw new Error("Agent route not found.");
        if (route.kind === "deployment") throw new Error("Deployment preview routes are immutable.");
        for (const target of targets) {
          const [deployment] = await tx.select().from(deployments).where(eq(deployments.id, target.deploymentId)).limit(1);
          if (!deployment || deployment.projectId !== route.projectId) throw new Error("Route target deployment does not belong to the project.");
          if (target.weight > 0 && deployment.status !== "running") throw new Error("A weighted route target must be running.");
        }
        await tx.delete(routeTargets).where(eq(routeTargets.routeId, routeId));
        await tx.insert(routeTargets).values(targets.map((target) => ({ routeId, ...target })));
        await tx
          .update(agentRoutes)
          .set({ policyRevision: sql`${agentRoutes.policyRevision} + 1`, updatedAt: new Date() })
          .where(eq(agentRoutes.id, routeId));
      });
      const [route] = await db.select().from(agentRoutes).where(eq(agentRoutes.id, routeId)).limit(1);
      if (!route) throw new Error("Agent route not found after update.");
      return (await this.findRouteByHostname(route.hostname))!;
    },

    async promoteDeployment(projectId, deploymentId) {
      const hostname = await db.transaction(async (tx) => {
        const [route] = await tx
          .select()
          .from(agentRoutes)
          .where(and(eq(agentRoutes.projectId, projectId), eq(agentRoutes.kind, "project")))
          .limit(1);
        const [deployment] = await tx
          .select()
          .from(deployments)
          .where(and(eq(deployments.id, deploymentId), eq(deployments.projectId, projectId)))
          .limit(1);
        if (!route) throw new Error("Project route not found.");
        if (!deployment || deployment.status !== "running") throw new Error("A promoted deployment must be running and belong to the project.");
        await tx.delete(routeTargets).where(eq(routeTargets.routeId, route.id));
        await tx.insert(routeTargets).values({ routeId: route.id, deploymentId, weight: 10_000, variantName: null });
        await tx.update(agentRoutes).set({ policyRevision: sql`${agentRoutes.policyRevision} + 1`, updatedAt: new Date() }).where(eq(agentRoutes.id, route.id));
        await tx.update(projects).set({ deploymentId, releaseId: deployment.releaseId, deploymentStatus: deployment.status, updatedAt: new Date() }).where(eq(projects.id, projectId));
        const now = new Date();
        await tx
          .insert(projectSchedulerTargets)
          .values({ projectId, deploymentId, updatedAt: now })
          .onConflictDoUpdate({ target: projectSchedulerTargets.projectId, set: { deploymentId, updatedAt: now } });
        const scheduleRows = await tx.select().from(projectSchedules).where(eq(projectSchedules.projectId, projectId));
        const [release] = await tx.select().from(releases).where(eq(releases.id, deployment.releaseId)).limit(1);
        if (!release) throw new Error("Promoted Deployment has no Release.");
        for (const schedule of scheduleRows) {
          const [version] = await tx
            .select()
            .from(scheduleVersions)
            .where(and(eq(scheduleVersions.scheduleId, schedule.id), eq(scheduleVersions.sourceRevisionId, release.sourceRevisionId)))
            .limit(1);
          await tx
            .update(projectSchedules)
            .set({ nextRunAt: version && schedule.enabled ? getNextRunAt(version.cron, now) : null, updatedAt: now })
            .where(eq(projectSchedules.id, schedule.id));
        }
        return route.hostname;
      });
      return (await this.findRouteByHostname(hostname))!;
    },

    async ensureAliasRoute(projectId, alias, baseDomain, targets) {
      validateRouteTargets(targets);
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(alias)) throw new Error("Alias must be a DNS-safe label.");
      const hostname = await db.transaction(async (tx) => {
        const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1);
        if (!project) throw new Error("Project not found.");
        for (const target of targets) {
          const [deployment] = await tx.select().from(deployments).where(eq(deployments.id, target.deploymentId)).limit(1);
          if (!deployment || deployment.projectId !== projectId || (target.weight > 0 && deployment.status !== "running")) {
            throw new Error("Alias target must be a running deployment in this project.");
          }
        }
        const hostname = `${alias}--${project.slug}.${normalizeBaseDomain(baseDomain)}`;
        const [existing] = await tx.select().from(agentRoutes).where(eq(agentRoutes.hostname, hostname)).limit(1);
        const [route] = existing
          ? await tx.update(agentRoutes).set({ enabled: true, policyRevision: sql`${agentRoutes.policyRevision} + 1`, updatedAt: new Date() }).where(eq(agentRoutes.id, existing.id)).returning()
          : await tx.insert(agentRoutes).values({ id: createId("route"), projectId, hostname, kind: "alias" }).returning();
        if (!route) throw new Error("Failed to materialize alias route.");
        await tx.delete(routeTargets).where(eq(routeTargets.routeId, route.id));
        await tx.insert(routeTargets).values(targets.map((target) => ({ routeId: route.id, ...target })));
        return hostname;
      });
      return (await this.findRouteByHostname(hostname))!;
    },

    async getDeploymentRetention(projectId, keepRecent = 3) {
      const deploymentList = await this.listDeployments(projectId);
      const routes = await this.listProjectRoutes(projectId);
      const targeted = new Set(routes.filter((route) => route.kind !== "deployment").flatMap((route) => route.targets.map((target) => target.deploymentId)));
      const bindingRows = await db.select().from(sessionBindings).where(eq(sessionBindings.projectId, projectId));
      const sessionRows = await db.select().from(sessions).where(eq(sessions.projectId, projectId));
      const terminalByEveId = new Map(sessionRows.filter((session) => session.eveSessionId).map((session) => [session.eveSessionId!, ["completed", "failed"].includes(session.status)]));
      const active = new Set(bindingRows.filter((binding) => terminalByEveId.get(binding.eveSessionId) !== true).map((binding) => binding.deploymentId));
      const recent = new Set(deploymentList.slice(0, keepRecent).map((deployment) => deployment.id));
      return deploymentList.map((deployment) => {
        const reasons: Array<"route_target" | "active_session" | "recent_artifact"> = [];
        if (targeted.has(deployment.id)) reasons.push("route_target");
        if (active.has(deployment.id)) reasons.push("active_session");
        if (recent.has(deployment.id)) reasons.push("recent_artifact");
        return { deployment, protected: reasons.length > 0, reasons };
      });
    },

    async findSessionBinding(projectId, eveSessionId) {
      const [binding] = await db
        .select()
        .from(sessionBindings)
        .where(and(eq(sessionBindings.projectId, projectId), eq(sessionBindings.eveSessionId, eveSessionId)))
        .limit(1);
      return binding ? sessionBindingRowToSessionBinding(binding) : null;
    },

    async bindSession(input) {
      const [binding] = await db
        .insert(sessionBindings)
        .values({ id: createId("bind"), ...input })
        .onConflictDoUpdate({
          target: [sessionBindings.projectId, sessionBindings.eveSessionId],
          set: { ...input, updatedAt: new Date() },
        })
        .returning();
      if (!binding) throw new Error("Failed to persist the Gateway SessionBinding.");
      await db
        .update(sessions)
        .set({
          trigger: input.trigger,
          routeId: input.routeId,
          experimentId: input.experimentId,
          variantName: input.variantName,
          deploymentId: input.deploymentId,
        })
        .where(and(eq(sessions.projectId, input.projectId), eq(sessions.eveSessionId, input.eveSessionId)));
      return sessionBindingRowToSessionBinding(binding);
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

    async getSessionByEveSessionId(projectId, eveSessionId) {
      const [row] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.projectId, projectId), eq(sessions.eveSessionId, eveSessionId)))
        .limit(1);
      return row ? sessionRowToSession(row) : null;
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

    async recordModelUsage(sessionId, usage) {
      return db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(modelUsageEvents)
          .values({
            id: createId("usage"),
            sessionId,
            eveSessionId: usage.eveSessionId ?? sessionId,
            agentId: usage.agentId ?? null,
            agentName: usage.agentName ?? null,
            turnId: usage.turnId,
            stepIndex: usage.stepIndex,
            finishReason: usage.finishReason,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            costUsd: usage.costUsd,
            usageReported: usage.usageReported,
          })
          .onConflictDoNothing({
            target: [modelUsageEvents.sessionId, modelUsageEvents.eveSessionId, modelUsageEvents.turnId, modelUsageEvents.stepIndex],
          })
          .returning();

        if (!inserted) {
          const [existing] = await tx
            .select()
            .from(modelUsageEvents)
            .where(
              and(
                eq(modelUsageEvents.sessionId, sessionId),
                eq(modelUsageEvents.eveSessionId, usage.eveSessionId ?? sessionId),
                eq(modelUsageEvents.turnId, usage.turnId),
                eq(modelUsageEvents.stepIndex, usage.stepIndex),
              ),
            )
            .limit(1);
          if (!existing) {
            throw new Error("Failed to read the existing model usage event.");
          }
          return modelUsageRowToModelUsageEvent(existing);
        }

        await tx
          .update(sessions)
          .set({
            inputTokens: sql`${sessions.inputTokens} + ${usage.inputTokens ?? 0}`,
            outputTokens: sql`${sessions.outputTokens} + ${usage.outputTokens ?? 0}`,
            cacheReadTokens: sql`${sessions.cacheReadTokens} + ${usage.cacheReadTokens ?? 0}`,
            cacheWriteTokens: sql`${sessions.cacheWriteTokens} + ${usage.cacheWriteTokens ?? 0}`,
            ...(usage.costUsd === null ? {} : { costUsd: sql`coalesce(${sessions.costUsd}, 0) + ${usage.costUsd}` }),
            ...(usage.usageReported
              ? { usageReportedSteps: sql`${sessions.usageReportedSteps} + 1` }
              : { usageMissingSteps: sql`${sessions.usageMissingSteps} + 1` }),
          })
          .where(eq(sessions.id, sessionId));

        return modelUsageRowToModelUsageEvent(inserted);
      });
    },

    async completeSession(sessionId, input) {
      return db.transaction(async (tx) => {
        let [current] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
        if (!current) return null;

        if (input.eveSessionId) {
          const [observed] = await tx
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.projectId, current.projectId),
                eq(sessions.eveSessionId, input.eveSessionId),
                sql`${sessions.id} <> ${sessionId}`,
              ),
            )
            .limit(1);
          if (observed) {
            await tx.update(sessionNodes).set({ rootSessionId: sessionId }).where(eq(sessionNodes.rootSessionId, observed.id));
            await tx.update(sessionEvents).set({ sessionId }).where(eq(sessionEvents.sessionId, observed.id));
            await tx.update(modelUsageEvents).set({ sessionId }).where(eq(modelUsageEvents.sessionId, observed.id));
            [current] = await tx
              .update(sessions)
              .set({
                rootNodeId: current.rootNodeId ?? observed.rootNodeId,
                deploymentId: current.deploymentId ?? observed.deploymentId,
                routeId: current.routeId ?? observed.routeId,
                experimentId: current.experimentId ?? observed.experimentId,
                variantName: current.variantName ?? observed.variantName,
                inputTokens: sql`${sessions.inputTokens} + ${observed.inputTokens}`,
                outputTokens: sql`${sessions.outputTokens} + ${observed.outputTokens}`,
                cacheReadTokens: sql`${sessions.cacheReadTokens} + ${observed.cacheReadTokens}`,
                cacheWriteTokens: sql`${sessions.cacheWriteTokens} + ${observed.cacheWriteTokens}`,
                costUsd:
                  observed.costUsd === null
                    ? current.costUsd
                    : sql`coalesce(${sessions.costUsd}, 0) + ${observed.costUsd}`,
                usageReportedSteps: sql`${sessions.usageReportedSteps} + ${observed.usageReportedSteps}`,
                usageMissingSteps: sql`${sessions.usageMissingSteps} + ${observed.usageMissingSteps}`,
              })
              .where(eq(sessions.id, sessionId))
              .returning();
            await tx.delete(sessions).where(eq(sessions.id, observed.id));
          }
        }

        const [binding] = input.eveSessionId
          ? await tx
              .select()
              .from(sessionBindings)
              .where(
                and(
                  eq(sessionBindings.projectId, current!.projectId),
                  eq(sessionBindings.eveSessionId, input.eveSessionId),
                ),
              )
              .limit(1)
          : [];

        const [row] = await tx
          .update(sessions)
          .set({
            status: input.status,
            eveSessionId: input.eveSessionId,
            continuationToken: input.continuationToken,
            ...(binding
              ? {
                  trigger: binding.trigger,
                  routeId: binding.routeId,
                  experimentId: binding.experimentId,
                  variantName: binding.variantName,
                  deploymentId: binding.deploymentId,
                }
              : {}),
            completedAt: input.status === "completed" || input.status === "failed" ? new Date() : null,
          })
          .where(eq(sessions.id, sessionId))
          .returning();
        if (!row) return null;

        await tx
          .update(projects)
          .set({ latestSessionStatus: input.status, updatedAt: new Date() })
          .where(eq(projects.id, row.projectId));
        return sessionRowToSession(row);
      });
    },

    async listSchedules(projectId) {
      const rows = await db.select().from(schedules).where(eq(schedules.projectId, projectId)).orderBy(schedules.name);
      return rows.map(scheduleRowToSchedule);
    },

    async recordScheduleVersions(input) {
      return db.transaction(async (tx) => {
        const [revision] = await tx
          .select({ id: sourceRevisions.id })
          .from(sourceRevisions)
          .where(and(eq(sourceRevisions.id, input.sourceRevisionId), eq(sourceRevisions.projectId, input.projectId)))
          .limit(1);
        if (!revision) throw new Error("Cannot record schedule versions for an unknown SourceRevision.");

        const seenKeys = new Set<string>();
        const result = [];
        for (const definition of input.definitions) {
          if (seenKeys.has(definition.key)) throw new Error(`Duplicate schedule key: ${definition.key}`);
          seenKeys.add(definition.key);

          let [scheduleRow] = await tx
            .insert(projectSchedules)
            .values({ id: createId("sch"), projectId: input.projectId, key: definition.key })
            .onConflictDoNothing({ target: [projectSchedules.projectId, projectSchedules.key] })
            .returning();
          if (!scheduleRow) {
            [scheduleRow] = await tx
              .select()
              .from(projectSchedules)
              .where(and(eq(projectSchedules.projectId, input.projectId), eq(projectSchedules.key, definition.key)))
              .limit(1);
          }
          if (!scheduleRow) throw new Error(`Failed to upsert ProjectSchedule ${definition.key}.`);

          let [versionRow] = await tx
            .insert(scheduleVersions)
            .values({
              id: createId("schv"),
              scheduleId: scheduleRow.id,
              sourceRevisionId: input.sourceRevisionId,
              kind: definition.kind,
              cron: definition.cron,
              sourcePath: definition.sourcePath,
              definitionHash: definition.definitionHash,
            })
            .onConflictDoNothing({ target: [scheduleVersions.scheduleId, scheduleVersions.sourceRevisionId] })
            .returning();
          if (!versionRow) {
            [versionRow] = await tx
              .select()
              .from(scheduleVersions)
              .where(
                and(
                  eq(scheduleVersions.scheduleId, scheduleRow.id),
                  eq(scheduleVersions.sourceRevisionId, input.sourceRevisionId),
                ),
              )
              .limit(1);
          }
          if (!versionRow) throw new Error(`Failed to persist ScheduleVersion ${definition.key}.`);
          if (
            versionRow.definitionHash !== definition.definitionHash ||
            versionRow.cron !== definition.cron ||
            versionRow.kind !== definition.kind ||
            versionRow.sourcePath !== definition.sourcePath
          ) {
            throw new Error(`ScheduleVersion ${versionRow.id} is immutable.`);
          }
          result.push({
            schedule: projectScheduleRowToProjectSchedule(scheduleRow),
            version: scheduleVersionRowToScheduleVersion(versionRow),
          });
        }
        return result;
      });
    },

    async listProjectScheduleVersions(projectId, sourceRevisionId) {
      const rows = await db
        .select({ schedule: projectSchedules, version: scheduleVersions })
        .from(projectSchedules)
        .innerJoin(scheduleVersions, eq(scheduleVersions.scheduleId, projectSchedules.id))
        .where(
          and(eq(projectSchedules.projectId, projectId), eq(scheduleVersions.sourceRevisionId, sourceRevisionId)),
        )
        .orderBy(projectSchedules.key);
      return rows.map((row) => ({
        schedule: projectScheduleRowToProjectSchedule(row.schedule),
        version: scheduleVersionRowToScheduleVersion(row.version),
      }));
    },

    async listProjectScheduleSummaries(projectId) {
      const rows = await db
        .select({ schedule: projectSchedules, version: scheduleVersions, targetDeploymentId: projectSchedulerTargets.deploymentId })
        .from(projectSchedules)
        .leftJoin(projectSchedulerTargets, eq(projectSchedulerTargets.projectId, projectSchedules.projectId))
        .leftJoin(deployments, eq(deployments.id, projectSchedulerTargets.deploymentId))
        .leftJoin(releases, eq(releases.id, deployments.releaseId))
        .leftJoin(
          scheduleVersions,
          and(
            eq(scheduleVersions.scheduleId, projectSchedules.id),
            eq(scheduleVersions.sourceRevisionId, releases.sourceRevisionId),
          ),
        )
        .where(eq(projectSchedules.projectId, projectId))
        .orderBy(projectSchedules.key);
      return rows.map((row) => ({
        schedule: projectScheduleRowToProjectSchedule(row.schedule),
        version: row.version ? scheduleVersionRowToScheduleVersion(row.version) : null,
        targetDeploymentId: row.targetDeploymentId,
      }));
    },

    async getProjectSchedule(scheduleId) {
      const [row] = await db.select().from(projectSchedules).where(eq(projectSchedules.id, scheduleId)).limit(1);
      return row ? projectScheduleRowToProjectSchedule(row) : null;
    },

    async setProjectSchedulerTarget(projectId, deploymentId, now = new Date()) {
      return db.transaction(async (tx) => {
        const [targetDeployment] = await tx
          .select({ deployment: deployments, release: releases })
          .from(deployments)
          .innerJoin(releases, eq(releases.id, deployments.releaseId))
          .where(and(eq(deployments.id, deploymentId), eq(deployments.projectId, projectId)))
          .limit(1);
        if (!targetDeployment) throw new Error("Cannot target an unknown Deployment for schedules.");

        const [target] = await tx
          .insert(projectSchedulerTargets)
          .values({ projectId, deploymentId, updatedAt: now })
          .onConflictDoUpdate({
            target: projectSchedulerTargets.projectId,
            set: { deploymentId, updatedAt: now },
          })
          .returning();
        if (!target) throw new Error("Failed to update the Project scheduler target.");

        const scheduleRows = await tx.select().from(projectSchedules).where(eq(projectSchedules.projectId, projectId));
        for (const scheduleRow of scheduleRows) {
          const [version] = await tx
            .select()
            .from(scheduleVersions)
            .where(
              and(
                eq(scheduleVersions.scheduleId, scheduleRow.id),
                eq(scheduleVersions.sourceRevisionId, targetDeployment.release.sourceRevisionId),
              ),
            )
            .limit(1);
          await tx
            .update(projectSchedules)
            .set({
              nextRunAt: version && scheduleRow.enabled ? getNextRunAt(version.cron, now) : null,
              updatedAt: now,
            })
            .where(eq(projectSchedules.id, scheduleRow.id));
        }
        return projectSchedulerTargetRowToProjectSchedulerTarget(target);
      });
    },

    async listUpcomingScheduleTargets(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error("Schedule prewarm limit must be positive.");
      const rows = await db
        .select({
          scheduleId: projectSchedules.id,
          projectId: projectSchedules.projectId,
          deploymentId: projectSchedulerTargets.deploymentId,
          nextRunAt: projectSchedules.nextRunAt,
        })
        .from(projectSchedules)
        .innerJoin(projectSchedulerTargets, eq(projectSchedulerTargets.projectId, projectSchedules.projectId))
        .innerJoin(deployments, eq(deployments.id, projectSchedulerTargets.deploymentId))
        .where(and(
          eq(projectSchedules.enabled, true),
          gt(projectSchedules.nextRunAt, input.after),
          lte(projectSchedules.nextRunAt, input.before),
          sql`${deployments.status} not in ('archived', 'failed')`,
        ))
        .orderBy(asc(projectSchedules.nextRunAt), asc(projectSchedules.id))
        .limit(input.limit);
      return rows.flatMap((row) => row.nextRunAt ? [{
        scheduleId: row.scheduleId,
        projectId: row.projectId,
        deploymentId: row.deploymentId,
        nextRunAt: row.nextRunAt.toISOString(),
      }] : []);
    },

    async createManualScheduleRun(projectId, scheduleId, now = new Date()) {
      return db.transaction(async (tx) => {
        const [schedule] = await tx
          .select()
          .from(projectSchedules)
          .where(and(eq(projectSchedules.id, scheduleId), eq(projectSchedules.projectId, projectId)))
          .limit(1);
        if (!schedule) throw new Error("Project schedule not found.");
        if (!schedule.enabled) throw new Error("Project schedule is disabled.");
        const [target] = await tx
          .select({ deployment: deployments, release: releases })
          .from(projectSchedulerTargets)
          .innerJoin(deployments, eq(deployments.id, projectSchedulerTargets.deploymentId))
          .innerJoin(releases, eq(releases.id, deployments.releaseId))
          .where(eq(projectSchedulerTargets.projectId, projectId))
          .limit(1);
        if (!target) throw new Error("Project schedule has no deployable scheduler target.");
        const [version] = await tx
          .select()
          .from(scheduleVersions)
          .where(
            and(
              eq(scheduleVersions.scheduleId, scheduleId),
              eq(scheduleVersions.sourceRevisionId, target.release.sourceRevisionId),
            ),
          )
          .limit(1);
        if (!version) throw new Error("Project schedule has no deployable scheduler target.");
        const [run] = await tx
          .insert(scheduleRuns)
          .values({
            id: createId("srun"),
            scheduleId,
            scheduleVersionId: version.id,
            releaseId: target.release.id,
            deploymentId: target.deployment.id,
            dueAt: now,
            trigger: "manual",
            status: "queued",
            missedTicks: 0,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!run) throw new Error("Failed to create manual ScheduleRun.");
        await tx.insert(jobs).values({
          id: createId("job"),
          projectId,
          type: "trigger_schedule",
          status: "queued",
          payload: { scheduleRunId: run.id },
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        });
        return scheduleRunRowToScheduleRun(run);
      });
    },

    async claimDueScheduleRuns(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error("Schedule claim limit must be positive.");
      return db.transaction(async (tx) => {
        const due = await tx
          .select({
            schedule: projectSchedules,
            version: scheduleVersions,
            deployment: deployments,
            release: releases,
          })
          .from(projectSchedules)
          .innerJoin(projectSchedulerTargets, eq(projectSchedulerTargets.projectId, projectSchedules.projectId))
          .innerJoin(deployments, eq(deployments.id, projectSchedulerTargets.deploymentId))
          .innerJoin(releases, eq(releases.id, deployments.releaseId))
          .innerJoin(
            scheduleVersions,
            and(
              eq(scheduleVersions.scheduleId, projectSchedules.id),
              eq(scheduleVersions.sourceRevisionId, releases.sourceRevisionId),
            ),
          )
          .where(
            and(
              eq(projectSchedules.enabled, true),
              lte(projectSchedules.nextRunAt, input.now),
            ),
          )
          .orderBy(asc(projectSchedules.nextRunAt), asc(projectSchedules.id))
          .limit(input.limit)
          .for("update", { skipLocked: true });

        const claimed = [];
        for (const row of due) {
          if (!row.schedule.nextRunAt) continue;
          const dueAt = row.schedule.nextRunAt;
          let next = getNextRunAt(row.version.cron, dueAt);
          let missedTicks = 0;
          while (next <= input.now) {
            missedTicks += 1;
            next = getNextRunAt(row.version.cron, next);
          }

          const [run] = await tx
            .insert(scheduleRuns)
            .values({
              id: createId("srun"),
              scheduleId: row.schedule.id,
              scheduleVersionId: row.version.id,
              releaseId: row.release.id,
              deploymentId: row.deployment.id,
              dueAt,
              trigger: "cron",
              status: "queued",
              missedTicks,
              createdAt: input.now,
              updatedAt: input.now,
            })
            .onConflictDoNothing({
              target: [scheduleRuns.scheduleVersionId, scheduleRuns.dueAt],
              where: sql`${scheduleRuns.trigger} = 'cron'`,
            })
            .returning();
          if (!run) continue;

          await tx
            .update(projectSchedules)
            .set({ nextRunAt: next, updatedAt: input.now })
            .where(eq(projectSchedules.id, row.schedule.id));
          await tx.insert(jobs).values({
            id: createId("job"),
            projectId: row.schedule.projectId,
            type: "trigger_schedule",
            status: "queued",
            payload: { scheduleRunId: run.id },
            attempts: 0,
            createdAt: input.now,
            updatedAt: input.now,
          });
          claimed.push(scheduleRunRowToScheduleRun(run));
        }
        return claimed;
      });
    },

    async getScheduleRun(scheduleRunId) {
      const [row] = await db.select().from(scheduleRuns).where(eq(scheduleRuns.id, scheduleRunId)).limit(1);
      return row ? scheduleRunRowToScheduleRun(row) : null;
    },

    async listScheduleRuns(projectId, input) {
      const conditions = [eq(projectSchedules.projectId, projectId)];
      if (input.scheduleId) conditions.push(eq(scheduleRuns.scheduleId, input.scheduleId));
      if (input.trigger) conditions.push(eq(scheduleRuns.trigger, input.trigger));
      if (input.status) conditions.push(eq(scheduleRuns.status, input.status));
      if (input.cursor) {
        const [cursor] = await db
          .select({ id: scheduleRuns.id, createdAt: scheduleRuns.createdAt })
          .from(scheduleRuns)
          .innerJoin(projectSchedules, eq(projectSchedules.id, scheduleRuns.scheduleId))
          .where(and(eq(scheduleRuns.id, input.cursor), eq(projectSchedules.projectId, projectId)))
          .limit(1);
        if (!cursor) return { items: [], nextCursor: null };
        if (cursor) conditions.push(or(
          lt(scheduleRuns.createdAt, cursor.createdAt),
          and(eq(scheduleRuns.createdAt, cursor.createdAt), lt(scheduleRuns.id, cursor.id)),
        )!);
      }
      const rows = await db
        .select({ run: scheduleRuns, scheduleKey: projectSchedules.key })
        .from(scheduleRuns)
        .innerJoin(projectSchedules, eq(projectSchedules.id, scheduleRuns.scheduleId))
        .where(and(...conditions))
        .orderBy(desc(scheduleRuns.createdAt), desc(scheduleRuns.id))
        .limit(input.limit + 1);
      const pageRows = rows.slice(0, input.limit);
      const linkedRows = pageRows.length > 0
        ? await db.select().from(sessions).where(inArray(sessions.scheduleRunId, pageRows.map((row) => row.run.id)))
        : [];
      const linkedSessions = linkedRows.map(sessionRowToSession);
      return {
        items: pageRows.map((row) => {
          const runSessions = linkedSessions.filter((session) => session.scheduleRunId === row.run.id);
          return {
            ...scheduleRunRowToScheduleRun(row.run),
            scheduleKey: row.scheduleKey,
            sessionCount: runSessions.length,
            usage: summarizeSessionUsage(runSessions),
            sessions: runSessions,
          };
        }),
        nextCursor: rows.length > input.limit ? pageRows.at(-1)?.run.id ?? null : null,
      };
    },

    async getScheduleRunDetail(scheduleRunId) {
      const [row] = await db
        .select({
          run: scheduleRuns,
          scheduleKey: projectSchedules.key,
          version: scheduleVersions,
          release: releases,
          deployment: deployments,
        })
        .from(scheduleRuns)
        .innerJoin(projectSchedules, eq(projectSchedules.id, scheduleRuns.scheduleId))
        .innerJoin(scheduleVersions, eq(scheduleVersions.id, scheduleRuns.scheduleVersionId))
        .innerJoin(releases, eq(releases.id, scheduleRuns.releaseId))
        .innerJoin(deployments, eq(deployments.id, scheduleRuns.deploymentId))
        .where(eq(scheduleRuns.id, scheduleRunId))
        .limit(1);
      if (!row) return null;
      const linkedRows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.scheduleRunId, scheduleRunId))
        .orderBy(desc(sessions.startedAt), desc(sessions.id));
      const linkedSessions = linkedRows.map(sessionRowToSession);
      return {
        ...scheduleRunRowToScheduleRun(row.run),
        scheduleKey: row.scheduleKey,
        sessionCount: linkedSessions.length,
        usage: summarizeSessionUsage(linkedSessions),
        sessions: linkedSessions,
        version: scheduleVersionRowToScheduleVersion(row.version),
        release: releaseRowToRelease(row.release),
        deployment: deploymentRowToDeployment(row.deployment),
      };
    },

    async claimScheduleRunActivation(scheduleRunId, now = new Date(), staleAfterMs = 300_000) {
      const staleBefore = new Date(now.getTime() - staleAfterMs);
      const [claimed] = await db
        .update(scheduleRuns)
        .set({ status: "activating", startedAt: now, updatedAt: now })
        .where(
          and(
            eq(scheduleRuns.id, scheduleRunId),
            or(
              eq(scheduleRuns.status, "queued"),
              and(eq(scheduleRuns.status, "activating"), lte(scheduleRuns.updatedAt, staleBefore)),
            ),
          ),
        )
        .returning();
      return claimed ? scheduleRunRowToScheduleRun(claimed) : null;
    },

    async redeemScheduleRunDispatch(scheduleRunId, deploymentId) {
      const now = new Date();
      const [row] = await db
        .update(scheduleRuns)
        .set({ status: "dispatching", attempt: sql`${scheduleRuns.attempt} + 1`, updatedAt: now })
        .where(
          and(
            eq(scheduleRuns.id, scheduleRunId),
            eq(scheduleRuns.deploymentId, deploymentId),
            eq(scheduleRuns.status, "activating"),
          ),
        )
        .returning();
      return row ? scheduleRunRowToScheduleRun(row) : null;
    },

    async completeScheduleRun(scheduleRunId, input) {
      return db.transaction(async (tx) => {
        const [run] = await tx.select().from(scheduleRuns).where(eq(scheduleRuns.id, scheduleRunId)).limit(1).for("update");
        if (!run) return null;
        const [schedule] = await tx
          .select()
          .from(projectSchedules)
          .where(eq(projectSchedules.id, run.scheduleId))
          .limit(1);
        if (!schedule) throw new Error("ScheduleRun references an unknown ProjectSchedule.");

        const trigger = run.trigger === "cron" ? "cron" : "manual";
        for (const eveSessionId of new Set(input.eveSessionIds ?? [])) {
          const [existing] = await tx
            .select({ id: sessions.id })
            .from(sessions)
            .where(and(eq(sessions.projectId, schedule.projectId), eq(sessions.eveSessionId, eveSessionId)))
            .limit(1);
          if (existing) {
            await tx
              .update(sessions)
              .set({
                deploymentId: run.deploymentId,
                trigger,
                scheduleId: run.scheduleId,
                scheduleRunId: run.id,
              })
              .where(eq(sessions.id, existing.id));
            continue;
          }
          await tx.insert(sessions).values({
            id: createId("sess"),
            projectId: schedule.projectId,
            deploymentId: run.deploymentId,
            eveSessionId,
            trigger,
            scheduleId: run.scheduleId,
            scheduleRunId: run.id,
            status: "running",
          });
        }

        const now = new Date();
        const [completed] = await tx
          .update(scheduleRuns)
          .set({ status: input.status, error: input.error ?? null, completedAt: now, updatedAt: now })
          .where(eq(scheduleRuns.id, scheduleRunId))
          .returning();
        return completed ? scheduleRunRowToScheduleRun(completed) : null;
      });
    },

    async acquireActivationLease(input) {
      return db.transaction(async (tx) => {
        const [deployment] = await tx
          .select({ id: deployments.id })
          .from(deployments)
          .where(eq(deployments.id, input.deploymentId))
          .limit(1)
          .for("update");
        if (!deployment) throw new Error("Cannot activate an unknown Deployment.");
        const now = input.now ?? new Date();
        const [latestRuntimeInstance] = await tx
          .select()
          .from(runtimeInstances)
          .where(eq(runtimeInstances.deploymentId, input.deploymentId))
          .orderBy(desc(runtimeInstances.generation))
          .limit(1)
          .for("update");
        if (latestRuntimeInstance?.status === "draining") {
          throw new RuntimeInstanceDrainingError();
        }
        let runtimeInstance = latestRuntimeInstance &&
          (latestRuntimeInstance.status === "starting" || latestRuntimeInstance.status === "ready")
          ? latestRuntimeInstance
          : undefined;
        const starter = !runtimeInstance;
        if (!runtimeInstance) {
          const [latest] = await tx
            .select({ generation: runtimeInstances.generation })
            .from(runtimeInstances)
            .where(eq(runtimeInstances.deploymentId, input.deploymentId))
            .orderBy(desc(runtimeInstances.generation))
            .limit(1);
          [runtimeInstance] = await tx
            .insert(runtimeInstances)
            .values({
              id: createId("rti"),
              deploymentId: input.deploymentId,
              generation: (latest?.generation ?? 0) + 1,
              status: "starting",
              startedAt: now,
            })
            .returning();
        }
        if (!runtimeInstance) throw new Error("Failed to create RuntimeInstance.");
        const [lease] = await tx
          .insert(activationLeases)
          .values({
            id: createId("lease"),
            deploymentId: input.deploymentId,
            runtimeInstanceId: runtimeInstance.id,
            kind: input.kind,
            ownerId: input.ownerId,
            expiresAt: input.expiresAt,
          })
          .onConflictDoUpdate({
            target: [activationLeases.deploymentId, activationLeases.kind, activationLeases.ownerId],
            set: { runtimeInstanceId: runtimeInstance.id, expiresAt: input.expiresAt, releasedAt: null },
          })
          .returning();
        if (!lease) throw new Error("Failed to create ActivationLease.");
        return {
          lease: activationLeaseRowToActivationLease(lease),
          runtimeInstance: runtimeInstanceRowToRuntimeInstance(runtimeInstance),
          starter,
        };
      });
    },

    async getRuntimeInstance(runtimeInstanceId) {
      const [row] = await db.select().from(runtimeInstances).where(eq(runtimeInstances.id, runtimeInstanceId)).limit(1);
      return row ? runtimeInstanceRowToRuntimeInstance(row) : null;
    },

    async listDeploymentRuntimeInstances(deploymentId) {
      const rows = await db
        .select()
        .from(runtimeInstances)
        .where(eq(runtimeInstances.deploymentId, deploymentId))
        .orderBy(asc(runtimeInstances.generation));
      return rows.map(runtimeInstanceRowToRuntimeInstance);
    },

    async adoptRuntimeInstance(deploymentId, endpoint, now = new Date()) {
      return db.transaction(async (tx) => {
        // Same deployment-level lock acquireActivationLease takes, so adoption
        // and activation serialize on the runtime_instances generation chain
        // instead of racing to insert the same generation.
        const [deployment] = await tx
          .select({ id: deployments.id })
          .from(deployments)
          .where(eq(deployments.id, deploymentId))
          .limit(1)
          .for("update");
        if (!deployment) return null;
        const [latest] = await tx
          .select()
          .from(runtimeInstances)
          .where(eq(runtimeInstances.deploymentId, deploymentId))
          .orderBy(desc(runtimeInstances.generation))
          .limit(1)
          .for("update");
        if (latest && (latest.status === "starting" || latest.status === "ready" || latest.status === "draining")) {
          return null;
        }
        const [row] = await tx
          .insert(runtimeInstances)
          .values({
            id: createId("rti"),
            deploymentId,
            generation: (latest?.generation ?? 0) + 1,
            status: "ready",
            endpointHost: endpoint.endpointHost,
            endpointPort: endpoint.endpointPort,
            startedAt: now,
            readyAt: now,
          })
          .returning();
        return row ? runtimeInstanceRowToRuntimeInstance(row) : null;
      });
    },

    async listRuntimeInstances(statuses, limit) {
      if (!Number.isInteger(limit) || limit < 1) throw new Error("RuntimeInstance list limit must be positive.");
      if (statuses.length === 0) return [];
      const rows = await db
        .select()
        .from(runtimeInstances)
        .where(or(...statuses.map((status) => eq(runtimeInstances.status, status))))
        .orderBy(asc(runtimeInstances.deploymentId), asc(runtimeInstances.generation))
        .limit(limit);
      return rows.map(runtimeInstanceRowToRuntimeInstance);
    },

    async updateRuntimeInstance(runtimeInstanceId, input, now = new Date()) {
      const [row] = await db
        .update(runtimeInstances)
        .set({
          status: input.status,
          ...(input.endpointHost !== undefined ? { endpointHost: input.endpointHost } : {}),
          ...(input.endpointPort !== undefined ? { endpointPort: input.endpointPort } : {}),
          ...(input.error !== undefined ? { lastError: input.error } : {}),
          ...(input.status === "ready" ? { readyAt: now } : {}),
          ...(input.status === "stopped" || input.status === "failed" ? { stoppedAt: now } : {}),
        })
        .where(eq(runtimeInstances.id, runtimeInstanceId))
        .returning();
      return row ? runtimeInstanceRowToRuntimeInstance(row) : null;
    },

    async getActivationLease(leaseId) {
      const [row] = await db.select().from(activationLeases).where(eq(activationLeases.id, leaseId)).limit(1);
      return row ? activationLeaseRowToActivationLease(row) : null;
    },

    async renewActivationLease(leaseId, expiresAt, now = new Date()) {
      const [row] = await db
        .update(activationLeases)
        .set({ expiresAt })
        .where(
          and(
            eq(activationLeases.id, leaseId),
            isNull(activationLeases.releasedAt),
            gt(activationLeases.expiresAt, now),
          ),
        )
        .returning();
      return row ? activationLeaseRowToActivationLease(row) : null;
    },

    async releaseActivationLease(leaseId, now = new Date()) {
      const [row] = await db
        .update(activationLeases)
        .set({ releasedAt: now })
        .where(and(eq(activationLeases.id, leaseId), isNull(activationLeases.releasedAt)))
        .returning();
      if (row) return activationLeaseRowToActivationLease(row);
      const [existing] = await db.select().from(activationLeases).where(eq(activationLeases.id, leaseId)).limit(1);
      return existing ? activationLeaseRowToActivationLease(existing) : null;
    },

    async hasActiveActivationLeases(deploymentId, now = new Date()) {
      const [row] = await db
        .select({ id: activationLeases.id })
        .from(activationLeases)
        .where(
          and(
            eq(activationLeases.deploymentId, deploymentId),
            isNull(activationLeases.releasedAt),
            gt(activationLeases.expiresAt, now),
          ),
        )
        .limit(1);
      return Boolean(row);
    },

    async claimIdleRuntimeInstances(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error("Runtime idle claim limit must be positive.");
      if (!Number.isFinite(input.idleTtlMs) || input.idleTtlMs < 0) throw new Error("Runtime idle TTL must be non-negative.");
      const schedulePrewarmMs = input.schedulePrewarmMs ?? 0;
      if (!Number.isFinite(schedulePrewarmMs) || schedulePrewarmMs < 0) {
        throw new Error("Schedule prewarm window must be non-negative.");
      }
      return db.transaction(async (tx) => {
        const cutoffAt = new Date(input.now.getTime() - input.idleTtlMs);
        const scheduleHorizon = new Date(input.now.getTime() + schedulePrewarmMs);
        const candidates = await tx
          .select()
          .from(runtimeInstances)
          .where(or(
            eq(runtimeInstances.status, "draining"),
            and(
              eq(runtimeInstances.status, "ready"),
              sql`not exists (
                select 1 from activation_leases as active_lease
                where active_lease.deployment_id = ${runtimeInstances.deploymentId}
                  and active_lease.released_at is null
                  and active_lease.expires_at > ${input.now.toISOString()}::timestamptz
              )`,
              sql`not exists (
                select 1 from schedule_runs as protected_run
                where protected_run.deployment_id = ${runtimeInstances.deploymentId}
                  and protected_run.status in ('queued', 'activating', 'dispatching', 'running')
              )`,
              ...(schedulePrewarmMs > 0 ? [sql`not exists (
                  select 1
                  from project_scheduler_targets as protected_target
                  join project_schedules as upcoming_schedule
                    on upcoming_schedule.project_id = protected_target.project_id
                  where protected_target.deployment_id = ${runtimeInstances.deploymentId}
                    and upcoming_schedule.enabled = true
                    and upcoming_schedule.next_run_at is not null
                    and upcoming_schedule.next_run_at <= ${scheduleHorizon.toISOString()}::timestamptz
                )`] : []),
              sql`greatest(
                coalesce(${runtimeInstances.readyAt}, ${runtimeInstances.startedAt}, '-infinity'::timestamptz),
                coalesce((
                  select max(coalesce(instance_lease.released_at, instance_lease.expires_at))
                  from activation_leases as instance_lease
                  where instance_lease.runtime_instance_id = ${runtimeInstances.id}
                ), '-infinity'::timestamptz)
              ) <= ${cutoffAt.toISOString()}::timestamptz`,
            ),
          ))
          .orderBy(asc(runtimeInstances.deploymentId), asc(runtimeInstances.generation))
          .limit(input.limit)
          .for("update", { skipLocked: true });
        const claimed = [];
        for (const candidate of candidates) {
          if (candidate.status === "draining") {
            claimed.push(runtimeInstanceRowToRuntimeInstance(candidate));
            continue;
          }
          const [activeLease] = await tx
            .select({ id: activationLeases.id })
            .from(activationLeases)
            .where(
              and(
                eq(activationLeases.deploymentId, candidate.deploymentId),
                isNull(activationLeases.releasedAt),
                gt(activationLeases.expiresAt, input.now),
              ),
            )
            .limit(1);
          if (activeLease) continue;
          const leaseRows = await tx
            .select({ expiresAt: activationLeases.expiresAt, releasedAt: activationLeases.releasedAt })
            .from(activationLeases)
            .where(eq(activationLeases.runtimeInstanceId, candidate.id));
          const activityTimes = [candidate.readyAt, candidate.startedAt]
            .concat(leaseRows.map((lease) => lease.releasedAt ?? lease.expiresAt))
            .filter((value): value is Date => value !== null)
            .map((value) => value.getTime());
          if (Math.max(...activityTimes) > cutoffAt.getTime()) continue;
          const [updated] = await tx
            .update(runtimeInstances)
            .set({ status: "draining" })
            .where(and(eq(runtimeInstances.id, candidate.id), eq(runtimeInstances.status, "ready")))
            .returning();
          if (updated) claimed.push(runtimeInstanceRowToRuntimeInstance(updated));
        }
        return claimed;
      });
    },

    async listSessions(projectId) {
      const rows = await db.select().from(sessions).where(eq(sessions.projectId, projectId)).orderBy(desc(sessions.startedAt));
      return rows.map(sessionRowToSession);
    },

    async getSession(sessionId) {
      const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      return row ? sessionRowToSession(row) : null;
    },

    async listSessionsPage(projectId, input) {
      const conditions = [eq(sessions.projectId, projectId)];
      if (input.trigger) conditions.push(eq(sessions.trigger, input.trigger));
      if (input.scheduleId) conditions.push(eq(sessions.scheduleId, input.scheduleId));
      if (input.scheduleRunId) conditions.push(eq(sessions.scheduleRunId, input.scheduleRunId));
      if (input.unlinkedOnly) conditions.push(isNull(sessions.scheduleRunId));
      if (input.cursor) {
        const [cursor] = await db
          .select({ id: sessions.id, startedAt: sessions.startedAt })
          .from(sessions)
          .where(and(eq(sessions.id, input.cursor), eq(sessions.projectId, projectId)))
          .limit(1);
        if (!cursor) return { items: [], nextCursor: null };
        if (cursor) conditions.push(or(
          lt(sessions.startedAt, cursor.startedAt),
          and(eq(sessions.startedAt, cursor.startedAt), lt(sessions.id, cursor.id)),
        )!);
      }
      const rows = await db
        .select()
        .from(sessions)
        .where(and(...conditions))
        .orderBy(desc(sessions.startedAt), desc(sessions.id))
        .limit(input.limit + 1);
      const pageRows = rows.slice(0, input.limit);
      return {
        items: pageRows.map(sessionRowToSession),
        nextCursor: rows.length > input.limit ? pageRows.at(-1)?.id ?? null : null,
      };
    },

    async listSessionEvents(sessionId) {
      const rows = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId)).orderBy(sessionEvents.index);
      return rows.map(sessionEventRowToSessionEvent);
    },

    async listSessionNodes(sessionId) {
      const rows = await db.select().from(sessionNodes).where(eq(sessionNodes.rootSessionId, sessionId)).orderBy(sessionNodes.createdAt);
      return rows.map(sessionNodeRowToSessionNode);
    },

    async ingestObserverEnvelope(envelope) {
      return db.transaction(async (tx) => {
        const [deployment] = await tx.select().from(deployments).where(eq(deployments.id, envelope.deploymentId)).limit(1);
        if (!deployment) {
          throw new ObserverEnvelopeRejectedError(
            `Observer deployment ${envelope.deploymentId} is not managed by Eveland.`,
          );
        }
        const [binding] = await tx
          .select()
          .from(sessionBindings)
          .where(
            and(
              eq(sessionBindings.projectId, deployment.projectId),
              eq(sessionBindings.eveSessionId, envelope.eveSessionId),
            ),
          )
          .limit(1);

        let [node] = await tx
          .select()
          .from(sessionNodes)
          .where(and(eq(sessionNodes.projectId, deployment.projectId), eq(sessionNodes.eveSessionId, envelope.eveSessionId)))
          .limit(1);
        let sessionRow;

        if (node) {
          [node] = await tx
            .update(sessionNodes)
            .set({
              lastObservedDeploymentId: envelope.deploymentId,
              agentName: envelope.agent.name ?? node.agentName,
              nodeId: envelope.agent.nodeId ?? node.nodeId,
              channelKind: envelope.channelKind ?? node.channelKind,
              resolutionStatus: "observed",
              updatedAt: new Date(),
            })
            .where(eq(sessionNodes.id, node.id))
            .returning();
          [sessionRow] = await tx.select().from(sessions).where(eq(sessions.id, node!.rootSessionId)).limit(1);
          if (sessionRow && node!.parentNodeId === null) {
            const discoveredTrigger = triggerFromObserverChannel(envelope.channelKind);
            if (sessionRow.trigger === "direct_http" && discoveredTrigger !== "direct_http") {
              [sessionRow] = await tx
                .update(sessions)
                .set({ trigger: discoveredTrigger })
                .where(eq(sessions.id, sessionRow.id))
                .returning();
            }
          }
        } else {
          let parent = envelope.parentEveSessionId
            ? (
                await tx
                  .select()
                  .from(sessionNodes)
                  .where(
                    and(
                      eq(sessionNodes.projectId, deployment.projectId),
                      eq(sessionNodes.eveSessionId, envelope.parentEveSessionId),
                    ),
                  )
                  .limit(1)
              )[0]
            : undefined;
          if (!parent && envelope.parentEveSessionId) {
            const [parentBinding] = await tx
              .select()
              .from(sessionBindings)
              .where(
                and(
                  eq(sessionBindings.projectId, deployment.projectId),
                  eq(sessionBindings.eveSessionId, envelope.parentEveSessionId),
                ),
              )
              .limit(1);
            [sessionRow] = await tx
              .select()
              .from(sessions)
              .where(
                and(
                  eq(sessions.projectId, deployment.projectId),
                  eq(sessions.eveSessionId, envelope.parentEveSessionId),
                ),
              )
              .limit(1);
            if (!sessionRow) {
              [sessionRow] = await tx
                .insert(sessions)
                .values({
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
                  status: "running",
                  startedAt: new Date(envelope.eventAt),
                })
                .returning();
            }
            if (!sessionRow) throw new Error("Failed to create observer parent placeholder session.");
            [parent] = await tx
              .insert(sessionNodes)
              .values({
                id: createId("node"),
                rootSessionId: sessionRow.id,
                projectId: deployment.projectId,
                eveSessionId: envelope.parentEveSessionId,
                parentNodeId: null,
                parentEveSessionId: null,
                startedDeploymentId: envelope.deploymentId,
                lastObservedDeploymentId: envelope.deploymentId,
                resolutionStatus: "unresolved",
                status: "running",
              })
              .returning();
            if (!parent) throw new Error("Failed to create observer parent placeholder node.");
            [sessionRow] = await tx
              .update(sessions)
              .set({ rootNodeId: parent.id })
              .where(eq(sessions.id, sessionRow.id))
              .returning();
          }
          if (parent) [sessionRow] = await tx.select().from(sessions).where(eq(sessions.id, parent.rootSessionId)).limit(1);
          if (!sessionRow && !envelope.parentEveSessionId) {
            [sessionRow] = await tx
              .select()
              .from(sessions)
              .where(and(eq(sessions.projectId, deployment.projectId), eq(sessions.eveSessionId, envelope.eveSessionId)))
              .limit(1);
          }
          if (!sessionRow) {
            [sessionRow] = await tx
              .insert(sessions)
              .values({
                id: createId("sess"),
                projectId: deployment.projectId,
                deploymentId: binding?.deploymentId ?? envelope.deploymentId,
                eveSessionId: envelope.eveSessionId,
                continuationToken: null,
                rootNodeId: null,
                routeId: binding?.routeId ?? null,
                experimentId: binding?.experimentId ?? null,
                variantName: binding?.variantName ?? null,
                trigger: binding?.trigger ?? triggerFromObserverChannel(envelope.channelKind),
                scheduleId: null,
                status: "running",
                startedAt: new Date(envelope.eventAt),
              })
              .returning();
          }
          if (!sessionRow) throw new Error("Failed to create observer root session.");

          [node] = await tx
            .insert(sessionNodes)
            .values({
              id: createId("node"),
              rootSessionId: sessionRow.id,
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
              resolutionStatus: "observed",
              status: "running",
            })
            .returning();
          if (!node) throw new Error("Failed to create observer session node.");
          if (!parent) {
            [sessionRow] = await tx
              .update(sessions)
              .set({ rootNodeId: node.id, eveSessionId: node.eveSessionId })
              .where(eq(sessions.id, sessionRow.id))
              .returning();
          }
        }
        if (!node || !sessionRow) throw new Error("Failed to resolve observer session node.");

        const [duplicate] = await tx
          .select()
          .from(sessionEvents)
          .where(
            and(
              eq(sessionEvents.sessionNodeId, node.id),
              or(
                eq(sessionEvents.observerEventId, envelope.observerEventId),
                eq(sessionEvents.eventFingerprint, envelope.eventFingerprint),
              ),
            ),
          )
          .limit(1);
        if (duplicate) {
          return {
            session: sessionRowToSession(sessionRow),
            node: sessionNodeRowToSessionNode(node),
            event: sessionEventRowToSessionEvent(duplicate),
            duplicate: true,
          };
        }

        const eventRecord = recordValue(envelope.event);
        const type = typeof eventRecord?.type === "string" ? eventRecord.type : "event";
        const payload = recordValue(eventRecord?.data) ?? eventRecord ?? envelope.event;
        const [countRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(sessionEvents)
          .where(eq(sessionEvents.sessionId, sessionRow.id));
        const [eventRow] = await tx
          .insert(sessionEvents)
          .values({
            id: createId("evt"),
            sessionId: sessionRow.id,
            sessionNodeId: node.id,
            observerEventId: envelope.observerEventId,
            eventFingerprint: envelope.eventFingerprint,
            observedDeploymentId: envelope.deploymentId,
            sourceSequence: envelope.sourceSequence,
            index: countRow?.count ?? 0,
            type,
            payload,
            eventAt: new Date(envelope.eventAt),
          })
          .returning();
        if (!eventRow) throw new Error("Failed to insert observer event.");

        const projectedStatus = observerStatus(type, node.status);
        const runtime = type === "session.started" ? recordValue(recordValue(payload)?.runtime) : null;
        [node] = await tx
          .update(sessionNodes)
          .set({
            status: projectedStatus ?? node.status,
            resolutionStatus: "observed",
            agentId: stringValue(runtime?.agentId) ?? node.agentId,
            agentName: stringValue(runtime?.agentName) ?? node.agentName,
            modelId: stringValue(runtime?.modelId) ?? node.modelId,
            eveVersion: stringValue(runtime?.eveVersion) ?? node.eveVersion,
            updatedAt: new Date(),
          })
          .where(eq(sessionNodes.id, node.id))
          .returning();

        if (projectedStatus && node?.parentNodeId === null) {
          [sessionRow] = await tx
            .update(sessions)
            .set({
              status: projectedStatus,
              completedAt: projectedStatus === "completed" || projectedStatus === "failed" ? new Date() : null,
            })
            .where(eq(sessions.id, sessionRow.id))
            .returning();
          await tx
            .update(projects)
            .set({ latestSessionStatus: projectedStatus, updatedAt: new Date() })
            .where(eq(projects.id, deployment.projectId));
        }

        if (type === "subagent.called") {
          const subagentPayload = recordValue(payload);
          const childEveSessionId = stringValue(subagentPayload?.childSessionId);
          const remoteUrl = stringValue(recordValue(subagentPayload?.remote)?.url);
          if (childEveSessionId) {
            let [child] = await tx
              .select()
              .from(sessionNodes)
              .where(and(eq(sessionNodes.projectId, deployment.projectId), eq(sessionNodes.eveSessionId, childEveSessionId)))
              .limit(1);
            if (child) {
              if (child.rootSessionId !== sessionRow!.id) {
                const oldRootSessionId = child.rootSessionId;
                const [oldRoot] = await tx.select().from(sessions).where(eq(sessions.id, oldRootSessionId)).limit(1);
                await tx.update(sessionNodes).set({ rootSessionId: sessionRow!.id }).where(eq(sessionNodes.rootSessionId, oldRootSessionId));
                await tx.update(sessionEvents).set({ sessionId: sessionRow!.id }).where(eq(sessionEvents.sessionId, oldRootSessionId));
                await tx.update(modelUsageEvents).set({ sessionId: sessionRow!.id }).where(eq(modelUsageEvents.sessionId, oldRootSessionId));
                if (oldRoot) {
                  await tx
                    .update(sessions)
                    .set({
                      inputTokens: sql`${sessions.inputTokens} + ${oldRoot.inputTokens}`,
                      outputTokens: sql`${sessions.outputTokens} + ${oldRoot.outputTokens}`,
                      cacheReadTokens: sql`${sessions.cacheReadTokens} + ${oldRoot.cacheReadTokens}`,
                      cacheWriteTokens: sql`${sessions.cacheWriteTokens} + ${oldRoot.cacheWriteTokens}`,
                      costUsd: oldRoot.costUsd === null ? sessions.costUsd : sql`coalesce(${sessions.costUsd}, 0) + ${oldRoot.costUsd}`,
                      usageReportedSteps: sql`${sessions.usageReportedSteps} + ${oldRoot.usageReportedSteps}`,
                      usageMissingSteps: sql`${sessions.usageMissingSteps} + ${oldRoot.usageMissingSteps}`,
                    })
                    .where(eq(sessions.id, sessionRow!.id));
                  await tx.delete(sessions).where(eq(sessions.id, oldRootSessionId));
                }
              }
              [child] = await tx
                .update(sessionNodes)
                .set({
                  rootSessionId: sessionRow!.id,
                  parentNodeId: node!.id,
                  parentEveSessionId: node!.eveSessionId,
                  agentName: stringValue(subagentPayload?.name) ?? child.agentName,
                  remoteUrl: remoteUrl ?? child.remoteUrl,
                  updatedAt: new Date(),
                })
                .where(eq(sessionNodes.id, child.id))
                .returning();
            } else {
              await tx.insert(sessionNodes).values({
                id: createId("node"),
                rootSessionId: sessionRow!.id,
                projectId: deployment.projectId,
                eveSessionId: childEveSessionId,
                parentNodeId: node!.id,
                parentEveSessionId: node!.eveSessionId,
                startedDeploymentId: envelope.deploymentId,
                lastObservedDeploymentId: envelope.deploymentId,
                agentName: stringValue(subagentPayload?.name),
                channelKind: "subagent",
                remoteUrl,
                resolutionStatus: "unresolved",
                status: "running",
              });
            }
          }
        }

        const usage = parseStepUsageEvent(type, payload);
        if (usage) {
          const [insertedUsage] = await tx
            .insert(modelUsageEvents)
            .values({
              id: createId("usage"),
              sessionId: sessionRow!.id,
              sessionNodeId: node!.id,
              eveSessionId: envelope.eveSessionId,
              agentId: node!.agentId,
              agentName: node!.agentName,
              turnId: usage.turnId,
              stepIndex: usage.stepIndex,
              finishReason: usage.finishReason,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
              costUsd: usage.costUsd,
              usageReported: usage.usageReported,
            })
            .onConflictDoNothing()
            .returning();
          if (insertedUsage) {
            await tx
              .update(sessions)
              .set({
                inputTokens: sql`${sessions.inputTokens} + ${usage.inputTokens ?? 0}`,
                outputTokens: sql`${sessions.outputTokens} + ${usage.outputTokens ?? 0}`,
                cacheReadTokens: sql`${sessions.cacheReadTokens} + ${usage.cacheReadTokens ?? 0}`,
                cacheWriteTokens: sql`${sessions.cacheWriteTokens} + ${usage.cacheWriteTokens ?? 0}`,
                ...(usage.costUsd === null ? {} : { costUsd: sql`coalesce(${sessions.costUsd}, 0) + ${usage.costUsd}` }),
                ...(usage.usageReported
                  ? { usageReportedSteps: sql`${sessions.usageReportedSteps} + 1` }
                  : { usageMissingSteps: sql`${sessions.usageMissingSteps} + 1` }),
              })
              .where(eq(sessions.id, sessionRow!.id));
          }
        }

        [sessionRow] = await tx.select().from(sessions).where(eq(sessions.id, sessionRow!.id)).limit(1);
        if (!sessionRow || !node) throw new Error("Observer projection lost its root session.");
        return {
          session: sessionRowToSession(sessionRow),
          node: sessionNodeRowToSessionNode(node),
          event: sessionEventRowToSessionEvent(eventRow),
          duplicate: false,
        };
      });
    },

    async listModelUsageEvents(sessionId) {
      const rows = await db
        .select()
        .from(modelUsageEvents)
        .where(eq(modelUsageEvents.sessionId, sessionId))
        .orderBy(modelUsageEvents.createdAt);
      return rows.map(modelUsageRowToModelUsageEvent);
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

function modelUsageRowToModelUsageEvent(row: typeof modelUsageEvents.$inferSelect) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    eveSessionId: row.eveSessionId,
    agentId: row.agentId,
    agentName: row.agentName,
    turnId: row.turnId,
    stepIndex: row.stepIndex,
    finishReason: row.finishReason,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    costUsd: row.costUsd,
    usageReported: row.usageReported,
    createdAt: row.createdAt.toISOString(),
  };
}

function triggerFromObserverChannel(channelKind: string | null): SessionTrigger {
  if (channelKind === "schedule") return "cron";
  if (channelKind?.startsWith("channel:")) return "channel";
  if (channelKind && channelKind !== "http" && channelKind !== "eve") return "webhook";
  return "direct_http";
}

function normalizeBaseDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!normalized || !/^[a-z0-9.-]+$/.test(normalized)) throw new Error(`Invalid Agent base domain: ${value}`);
  return normalized;
}

function observerStatus(type: string, current: string): SessionStatus | null {
  if (type === "session.started" || type === "turn.started") return "running";
  if (type === "input.requested") return "waiting_approval";
  if (type === "session.waiting") return current === "waiting_approval" ? "waiting_approval" : "waiting";
  if (type === "session.completed") return "completed";
  if (type === "session.failed") return "failed";
  return null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isUniqueConstraint(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
  if (record.code === "23505" && (record.constraint_name === constraint || record.constraint === constraint)) {
    return true;
  }
  return isUniqueConstraint(record.cause, constraint);
}
