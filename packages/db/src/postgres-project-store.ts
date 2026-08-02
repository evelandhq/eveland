import {
  claimProjectSlug,
  createId,
  slugifyProjectName,
} from "@eveland/core/ids";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  gitCredentialRowToPublic,
  gitCredentialRowToRecord,
  jobRowToJob,
  projectRowToProject,
  sourcePreflightRowToPublic,
  sourcePreflightRowToRecord,
} from "./mappers.js";
import {
  agentRoutes,
  deployments,
  gitCredentials,
  jobs,
  logs,
  modelUsageEvents,
  projectSchedulerTargets,
  projectSchedules,
  projects,
  releases,
  routeTargets,
  scheduleRuns,
  scheduleVersions,
  schedules,
  secrets,
  sessionBindings,
  sessionEvents,
  sessionNodes,
  sessions,
  sourceFiles,
  sourcePreflights,
  sourceRevisions,
  teams,
  users,
} from "./schema.js";
import type {
  CreateProjectInput,
  GitCredentialStore,
  JobStore,
  ProjectStore,
  SourceStore,
} from "./store-domains.js";
import {
  DEFAULT_TEAM_ID,
  ProjectSlugConflictError,
  projectDeletionSourcePaths,
} from "./store-shared.js";

const defaultOwner = {
  id: "user_local_admin",
  email: "admin@example.com",
  name: "Local Admin",
};

import type { PostgresStoreContext } from "./postgres-store-support.js";
import { insertJobRowTx, isUniqueConstraint } from "./postgres-store-support.js";

type PostgresProjectDomain = Omit<ProjectStore, "updateProjectState"> &
  Pick<
    SourceStore,
    | "createSourcePreflight"
    | "getSourcePreflight"
    | "claimNextSourcePreflight"
    | "heartbeatSourcePreflight"
    | "recoverStaleSourcePreflights"
    | "completeSourcePreflight"
    | "failSourcePreflight"
    | "createProjectFromSourcePreflight"
    | "expireSourcePreflights"
  > &
  GitCredentialStore;

type PostgresProjectDependencies = Pick<JobStore, "enqueueJob">;

export function createPostgresProjectStore({
  db,
}: PostgresStoreContext, {
  enqueueJob,
}: PostgresProjectDependencies): PostgresProjectDomain {
  const ensureDefaultOwner = async () => {
    await db.transaction(async (tx) => {
      await tx
        .insert(teams)
        .values({ id: DEFAULT_TEAM_ID, name: "Eveland", slug: "eveland" })
        .onConflictDoNothing({ target: teams.id });
      await tx
        .insert(users)
        .values(defaultOwner)
        .onConflictDoNothing({ target: users.id });
    });
  };

  return {
    async listProjects() {
      const rows = await db
        .select({
          ...getTableColumns(projects),
          nextScheduleAt:
            sql<Date | null>`min(${projectSchedules.nextRunAt})`.mapWith(
              projectSchedules.nextRunAt,
            ),
        })
        .from(projects)
        .leftJoin(
          projectSchedules,
          and(
            eq(projectSchedules.projectId, projects.id),
            eq(projectSchedules.enabled, true),
          ),
        )
        .groupBy(projects.id)
        .orderBy(
          desc(projects.createdAt),
          asc(projects.name),
          asc(projects.id),
        );
      return rows.map(projectRowToProject);
    },

    async isProjectSlugAvailable(slug) {
      const [row] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.slug, slug))
        .limit(1);
      return !row;
    },

    async createProject(input: CreateProjectInput) {
      await ensureDefaultOwner();
      const row = await claimProjectSlug(
        input.name,
        async (slug) => {
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
        },
        input.requireExactSlug ? { maxAttempts: 1 } : undefined,
      ).catch((error: unknown) => {
        if (
          input.requireExactSlug &&
          error instanceof Error &&
          error.message.startsWith("Failed to claim a unique project slug")
        ) {
          throw new ProjectSlugConflictError();
        }
        throw error;
      });

      await enqueueJob(row.id, "import_source", {
        importKind: input.importKind,
        gitUrl: input.gitUrl ?? null,
        sourcePath: input.sourcePath ?? null,
        ...(input.deployAfterImport ? { deployAfterImport: true } : {}),
        ...(input.gitCredential ? { gitCredential: input.gitCredential } : {}),
      });

      return projectRowToProject(row);
    },

    async createSourcePreflight(input) {
      if (input.userId === defaultOwner.id) await ensureDefaultOwner();
      const [row] = await db
        .insert(sourcePreflights)
        .values({
          id: createId("pre"),
          userId: input.userId,
          kind: input.kind,
          gitUrl: input.gitUrl ?? null,
          sourcePath: input.sourcePath ?? null,
          credentialHost: input.gitCredential?.host ?? null,
          encryptedToken: input.gitCredential?.encryptedToken ?? null,
          persistCredential: input.gitCredential?.persistAfterImport ?? false,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!row) throw new Error("Failed to create source preflight.");
      return sourcePreflightRowToPublic(row);
    },

    async getSourcePreflight(preflightId, userId) {
      const [row] = await db
        .select()
        .from(sourcePreflights)
        .where(
          and(
            eq(sourcePreflights.id, preflightId),
            eq(sourcePreflights.userId, userId),
          ),
        )
        .limit(1);
      return row ? sourcePreflightRowToPublic(row) : null;
    },

    async claimNextSourcePreflight(_workerId, now = new Date()) {
      const [row] = await db
        .update(sourcePreflights)
        .set({
          status: "running",
          attempts: sql`${sourcePreflights.attempts} + 1`,
          lockedAt: now,
          updatedAt: now,
        })
        .where(
          eq(
            sourcePreflights.id,
            sql`(
          select candidate.id
          from ${sourcePreflights} candidate
          where candidate.status = 'queued' and candidate.expires_at > ${now.toISOString()}
          order by candidate.created_at asc
          limit 1
          for update skip locked
        )`,
          ),
        )
        .returning();
      return row ? sourcePreflightRowToRecord(row) : null;
    },

    async heartbeatSourcePreflight(preflightId, attempt, now = new Date()) {
      const renewed = await db
        .update(sourcePreflights)
        .set({ lockedAt: now, updatedAt: now })
        .where(
          and(
            eq(sourcePreflights.id, preflightId),
            eq(sourcePreflights.status, "running"),
            eq(sourcePreflights.attempts, attempt),
          ),
        )
        .returning({ id: sourcePreflights.id });
      return renewed.length === 1;
    },

    async recoverStaleSourcePreflights(
      now = new Date(),
      staleAfterMs = 300_000,
      limit = 25,
    ) {
      const cutoff = new Date(now.getTime() - staleAfterMs);
      const recovered = await db
        .update(sourcePreflights)
        .set({ status: "queued", lockedAt: null, updatedAt: now })
        .where(
          inArray(
            sourcePreflights.id,
            db
              .select({ id: sourcePreflights.id })
              .from(sourcePreflights)
              .where(
                and(
                  eq(sourcePreflights.status, "running"),
                  lte(sourcePreflights.lockedAt, cutoff),
                ),
              )
              .orderBy(asc(sourcePreflights.lockedAt))
              .limit(limit),
          ),
        )
        .returning({ id: sourcePreflights.id });
      return recovered.length;
    },

    async completeSourcePreflight(preflightId, attempt, result) {
      const completed = await db
        .update(sourcePreflights)
        .set({
          status: "completed",
          sourcePath: result.sourcePath,
          commitSha: result.commitSha,
          summary: result.summary,
          error: null,
          lockedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sourcePreflights.id, preflightId),
            eq(sourcePreflights.status, "running"),
            eq(sourcePreflights.attempts, attempt),
          ),
        )
        .returning({ id: sourcePreflights.id });
      return completed.length === 1;
    },

    async failSourcePreflight(preflightId, attempt, error) {
      const failed = await db
        .update(sourcePreflights)
        .set({
          status: "failed",
          error,
          lockedAt: null,
          credentialHost: null,
          encryptedToken: null,
          persistCredential: false,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sourcePreflights.id, preflightId),
            eq(sourcePreflights.status, "running"),
            eq(sourcePreflights.attempts, attempt),
          ),
        )
        .returning({ id: sourcePreflights.id });
      return failed.length === 1;
    },

    async createProjectFromSourcePreflight(input) {
      await ensureDefaultOwner();
      return db.transaction(async (tx) => {
        const [preflight] = await tx
          .select()
          .from(sourcePreflights)
          .where(
            and(
              eq(sourcePreflights.id, input.preflightId),
              eq(sourcePreflights.userId, input.userId),
            ),
          )
          .limit(1)
          .for("update");
        if (!preflight) return { outcome: "not_found" } as const;
        if (preflight.status === "consumed")
          return { outcome: "consumed" } as const;
        if (
          preflight.status !== "completed" ||
          !preflight.sourcePath ||
          preflight.expiresAt <= new Date()
        ) {
          return { outcome: "not_ready" } as const;
        }

        const slug = slugifyProjectName(input.name);
        let projectRow: typeof projects.$inferSelect;
        try {
          const [created] = await tx
            .insert(projects)
            .values({
              id: createId("proj"),
              slug,
              ownerId: defaultOwner.id,
              name: slug,
              importKind: preflight.kind,
              gitUrl: preflight.gitUrl,
              status: "import_pending",
              deploymentStatus: "not_deployed",
            })
            .returning();
          if (!created) throw new Error("Failed to create project.");
          projectRow = created;
        } catch (error) {
          if (isUniqueConstraint(error, "projects_slug_unique"))
            throw new ProjectSlugConflictError();
          throw error;
        }

        const gitCredential =
          preflight.credentialHost && preflight.encryptedToken
            ? {
                userId: preflight.userId,
                host: preflight.credentialHost,
                encryptedToken: preflight.encryptedToken,
                persistAfterImport: preflight.persistCredential,
              }
            : null;
        if (input.secrets?.length) {
          await tx.insert(secrets).values(
            input.secrets.map((secret) => ({
              id: createId("secret"),
              projectId: projectRow.id,
              key: secret.key,
              kind: secret.kind ?? "secret",
              encryptedValue: secret.encryptedValue,
            })),
          );
        }
        await insertJobRowTx(tx, {
          projectId: projectRow.id,
          type: "import_source",
          payload: {
            importKind: preflight.kind,
            gitUrl: preflight.gitUrl,
            sourcePath: preflight.sourcePath,
            ...(input.deployAfterImport ? { deployAfterImport: true } : {}),
            ...(gitCredential ? { gitCredential } : {}),
          },
        });
        await tx
          .update(sourcePreflights)
          .set({
            status: "consumed",
            credentialHost: null,
            encryptedToken: null,
            persistCredential: false,
            updatedAt: new Date(),
          })
          .where(eq(sourcePreflights.id, preflight.id));
        return {
          outcome: "created",
          project: projectRowToProject(projectRow),
        } as const;
      });
    },

    async expireSourcePreflights(now = new Date(), limit = 25) {
      const expired = await db
        .delete(sourcePreflights)
        .where(
          inArray(
            sourcePreflights.id,
            db
              .select({ id: sourcePreflights.id })
              .from(sourcePreflights)
              .where(
                and(
                  sql`${sourcePreflights.status} <> 'running'`,
                  lte(sourcePreflights.expiresAt, now),
                ),
              )
              .orderBy(asc(sourcePreflights.expiresAt))
              .limit(limit),
          ),
        )
        .returning({
          sourcePath: sourcePreflights.sourcePath,
          status: sourcePreflights.status,
        });
      return [
        ...new Set(
          expired.flatMap((row) =>
            row.status !== "consumed" && row.sourcePath ? [row.sourcePath] : [],
          ),
        ),
      ];
    },

    async getProject(projectId) {
      const [row] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      return row ? projectRowToProject(row) : null;
    },

    async updateProjectMetadata(projectId, input) {
      const [row] = await db
        .update(projects)
        .set({
          name: input.name,
          description: input.description,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId))
        .returning();
      return row ? projectRowToProject(row) : null;
    },

    async listGitCredentials(userId) {
      const rows = await db
        .select()
        .from(gitCredentials)
        .where(eq(gitCredentials.userId, userId))
        .orderBy(desc(gitCredentials.updatedAt));
      return rows.map(gitCredentialRowToPublic);
    },

    async getGitCredential(userId, host) {
      const [row] = await db
        .select()
        .from(gitCredentials)
        .where(
          and(eq(gitCredentials.userId, userId), eq(gitCredentials.host, host)),
        )
        .limit(1);
      return row ? gitCredentialRowToRecord(row) : null;
    },

    async upsertGitCredential(userId, host, encryptedToken) {
      const [row] = await db
        .insert(gitCredentials)
        .values({ id: createId("gitcred"), userId, host, encryptedToken })
        .onConflictDoUpdate({
          target: [gitCredentials.userId, gitCredentials.host],
          set: { encryptedToken, updatedAt: new Date() },
        })
        .returning();
      if (!row) throw new Error("Failed to upsert Git credential.");
      return gitCredentialRowToRecord(row);
    },

    async deleteGitCredential(userId, credentialId) {
      const rows = await db
        .delete(gitCredentials)
        .where(
          and(
            eq(gitCredentials.userId, userId),
            eq(gitCredentials.id, credentialId),
          ),
        )
        .returning({ id: gitCredentials.id });
      return rows.length > 0;
    },

    async requestProjectDeletion(projectId) {
      return db.transaction(async (tx) => {
        const [project] = await tx
          .select()
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1)
          .for("update");
        if (!project) return { outcome: "not_found" } as const;
        if (project.deletionStatus === "deleting")
          return { outcome: "already_deleting" } as const;

        const deletionInputs = await tx
          .select({ payload: jobs.payload })
          .from(jobs)
          .where(
            and(
              eq(jobs.projectId, projectId),
              or(eq(jobs.status, "queued"), eq(jobs.type, "delete_project")),
            ),
          );
        const sourcePaths = projectDeletionSourcePaths(
          deletionInputs.map((input) => input.payload),
        );
        await tx
          .update(projects)
          .set({
            deletionStatus: "deleting",
            deletionError: null,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, projectId));
        await tx
          .delete(jobs)
          .where(and(eq(jobs.projectId, projectId), eq(jobs.status, "queued")));
        const row = await insertJobRowTx(tx, {
          projectId,
          type: "delete_project",
          payload: { sourcePaths },
        });
        return { outcome: "queued", job: jobRowToJob(row) } as const;
      });
    },

    async setProjectDeletionFailed(projectId, error) {
      const [row] = await db
        .update(projects)
        .set({
          deletionStatus: "failed",
          deletionError: error,
          updatedAt: new Date(),
        })
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
        const relatedSessions = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.projectId, projectId));
        for (const session of relatedSessions) {
          await tx
            .delete(modelUsageEvents)
            .where(eq(modelUsageEvents.sessionId, session.id));
          await tx
            .delete(sessionEvents)
            .where(eq(sessionEvents.sessionId, session.id));
        }
        await tx
          .delete(sessionNodes)
          .where(eq(sessionNodes.projectId, projectId));
        await tx.delete(sessions).where(eq(sessions.projectId, projectId));
        const relatedRoutes = await tx
          .select({ id: agentRoutes.id })
          .from(agentRoutes)
          .where(eq(agentRoutes.projectId, projectId));
        await tx
          .delete(sessionBindings)
          .where(eq(sessionBindings.projectId, projectId));
        for (const route of relatedRoutes)
          await tx
            .delete(routeTargets)
            .where(eq(routeTargets.routeId, route.id));
        await tx
          .delete(agentRoutes)
          .where(eq(agentRoutes.projectId, projectId));
        const relatedProjectSchedules = await tx
          .select({ id: projectSchedules.id })
          .from(projectSchedules)
          .where(eq(projectSchedules.projectId, projectId));
        for (const schedule of relatedProjectSchedules) {
          await tx
            .delete(scheduleRuns)
            .where(eq(scheduleRuns.scheduleId, schedule.id));
          await tx
            .delete(scheduleVersions)
            .where(eq(scheduleVersions.scheduleId, schedule.id));
        }
        await tx
          .delete(projectSchedulerTargets)
          .where(eq(projectSchedulerTargets.projectId, projectId));
        await tx
          .delete(projectSchedules)
          .where(eq(projectSchedules.projectId, projectId));
        await tx
          .delete(deployments)
          .where(eq(deployments.projectId, projectId));
        await tx.delete(releases).where(eq(releases.projectId, projectId));
        const relatedRevisions = await tx
          .select({ id: sourceRevisions.id })
          .from(sourceRevisions)
          .where(eq(sourceRevisions.projectId, projectId));
        for (const revision of relatedRevisions) {
          await tx
            .delete(sourceFiles)
            .where(eq(sourceFiles.revisionId, revision.id));
        }
        await tx
          .delete(sourceRevisions)
          .where(eq(sourceRevisions.projectId, projectId));
        await tx.delete(schedules).where(eq(schedules.projectId, projectId));
        await tx.delete(jobs).where(eq(jobs.projectId, projectId));
        await tx.delete(secrets).where(eq(secrets.projectId, projectId));
        const deleted = await tx
          .delete(projects)
          .where(eq(projects.id, projectId))
          .returning({ id: projects.id });
        return deleted.length > 0;
      });
    },
  };
}
