import { createId } from "@eveland/core/ids";
import { getNextRunAt } from "@eveland/core/schedules";
import { and, asc, desc, eq, gt, inArray, lt, lte, or, sql } from "drizzle-orm";
import {
  deploymentRowToDeployment,
  projectScheduleRowToProjectSchedule,
  projectSchedulerTargetRowToProjectSchedulerTarget,
  releaseRowToRelease,
  scheduleRowToSchedule,
  scheduleRunRowToScheduleRun,
  scheduleVersionRowToScheduleVersion,
  sessionRowToSession,
} from "./mappers.js";
import {
  deployments,
  jobs,
  projectSchedulerTargets,
  projectSchedules,
  releases,
  scheduleRuns,
  scheduleVersions,
  schedules,
  sessions,
  sourceRevisions,
} from "./schema.js";
import { summarizeSessionUsage } from "./session-usage.js";

const defaultOwner = {
  id: "user_local_admin",
  email: "admin@example.com",
  name: "Local Admin",
};

import type {
  PostgresDomain,
  PostgresStoreContext,
} from "./postgres-store-support.js";

export function createPostgresScheduleStore({
  db,
  ensureDeploymentRoutes,
  ensureDefaultOwner,
  createJob,
}: PostgresStoreContext): PostgresDomain {
  return {
    async listSchedules(projectId) {
      const rows = await db
        .select()
        .from(schedules)
        .where(eq(schedules.projectId, projectId))
        .orderBy(schedules.name);
      return rows.map(scheduleRowToSchedule);
    },

    async recordScheduleVersions(input) {
      return db.transaction(async (tx) => {
        const [revision] = await tx
          .select({ id: sourceRevisions.id })
          .from(sourceRevisions)
          .where(
            and(
              eq(sourceRevisions.id, input.sourceRevisionId),
              eq(sourceRevisions.projectId, input.projectId),
            ),
          )
          .limit(1);
        if (!revision)
          throw new Error(
            "Cannot record schedule versions for an unknown SourceRevision.",
          );

        const seenKeys = new Set<string>();
        const result = [];
        for (const definition of input.definitions) {
          if (seenKeys.has(definition.key))
            throw new Error(`Duplicate schedule key: ${definition.key}`);
          seenKeys.add(definition.key);

          let [scheduleRow] = await tx
            .insert(projectSchedules)
            .values({
              id: createId("sch"),
              projectId: input.projectId,
              key: definition.key,
            })
            .onConflictDoNothing({
              target: [projectSchedules.projectId, projectSchedules.key],
            })
            .returning();
          if (!scheduleRow) {
            [scheduleRow] = await tx
              .select()
              .from(projectSchedules)
              .where(
                and(
                  eq(projectSchedules.projectId, input.projectId),
                  eq(projectSchedules.key, definition.key),
                ),
              )
              .limit(1);
          }
          if (!scheduleRow)
            throw new Error(
              `Failed to upsert ProjectSchedule ${definition.key}.`,
            );

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
            .onConflictDoNothing({
              target: [
                scheduleVersions.scheduleId,
                scheduleVersions.sourceRevisionId,
              ],
            })
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
          if (!versionRow)
            throw new Error(
              `Failed to persist ScheduleVersion ${definition.key}.`,
            );
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
        .innerJoin(
          scheduleVersions,
          eq(scheduleVersions.scheduleId, projectSchedules.id),
        )
        .where(
          and(
            eq(projectSchedules.projectId, projectId),
            eq(scheduleVersions.sourceRevisionId, sourceRevisionId),
          ),
        )
        .orderBy(projectSchedules.key);
      return rows.map((row) => ({
        schedule: projectScheduleRowToProjectSchedule(row.schedule),
        version: scheduleVersionRowToScheduleVersion(row.version),
      }));
    },

    async listProjectScheduleSummaries(projectId) {
      const rows = await db
        .select({
          schedule: projectSchedules,
          version: scheduleVersions,
          targetDeploymentId: projectSchedulerTargets.deploymentId,
        })
        .from(projectSchedules)
        .leftJoin(
          projectSchedulerTargets,
          eq(projectSchedulerTargets.projectId, projectSchedules.projectId),
        )
        .leftJoin(
          deployments,
          eq(deployments.id, projectSchedulerTargets.deploymentId),
        )
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
        version: row.version
          ? scheduleVersionRowToScheduleVersion(row.version)
          : null,
        targetDeploymentId: row.targetDeploymentId,
      }));
    },

    async getProjectSchedule(scheduleId) {
      const [row] = await db
        .select()
        .from(projectSchedules)
        .where(eq(projectSchedules.id, scheduleId))
        .limit(1);
      return row ? projectScheduleRowToProjectSchedule(row) : null;
    },

    async setProjectSchedulerTarget(projectId, deploymentId, now = new Date()) {
      return db.transaction(async (tx) => {
        const [targetDeployment] = await tx
          .select({ deployment: deployments, release: releases })
          .from(deployments)
          .innerJoin(releases, eq(releases.id, deployments.releaseId))
          .where(
            and(
              eq(deployments.id, deploymentId),
              eq(deployments.projectId, projectId),
            ),
          )
          .limit(1);
        if (!targetDeployment)
          throw new Error("Cannot target an unknown Deployment for schedules.");

        const [target] = await tx
          .insert(projectSchedulerTargets)
          .values({ projectId, deploymentId, updatedAt: now })
          .onConflictDoUpdate({
            target: projectSchedulerTargets.projectId,
            set: { deploymentId, updatedAt: now },
          })
          .returning();
        if (!target)
          throw new Error("Failed to update the Project scheduler target.");

        const scheduleRows = await tx
          .select()
          .from(projectSchedules)
          .where(eq(projectSchedules.projectId, projectId));
        for (const scheduleRow of scheduleRows) {
          const [version] = await tx
            .select()
            .from(scheduleVersions)
            .where(
              and(
                eq(scheduleVersions.scheduleId, scheduleRow.id),
                eq(
                  scheduleVersions.sourceRevisionId,
                  targetDeployment.release.sourceRevisionId,
                ),
              ),
            )
            .limit(1);
          await tx
            .update(projectSchedules)
            .set({
              nextRunAt:
                version && scheduleRow.enabled
                  ? getNextRunAt(version.cron, now)
                  : null,
              updatedAt: now,
            })
            .where(eq(projectSchedules.id, scheduleRow.id));
        }
        return projectSchedulerTargetRowToProjectSchedulerTarget(target);
      });
    },

    async listUpcomingScheduleTargets(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1)
        throw new Error("Schedule prewarm limit must be positive.");
      const rows = await db
        .select({
          scheduleId: projectSchedules.id,
          projectId: projectSchedules.projectId,
          deploymentId: projectSchedulerTargets.deploymentId,
          nextRunAt: projectSchedules.nextRunAt,
        })
        .from(projectSchedules)
        .innerJoin(
          projectSchedulerTargets,
          eq(projectSchedulerTargets.projectId, projectSchedules.projectId),
        )
        .innerJoin(
          deployments,
          eq(deployments.id, projectSchedulerTargets.deploymentId),
        )
        .where(
          and(
            eq(projectSchedules.enabled, true),
            gt(projectSchedules.nextRunAt, input.after),
            lte(projectSchedules.nextRunAt, input.before),
            sql`${deployments.status} not in ('archived', 'failed')`,
          ),
        )
        .orderBy(asc(projectSchedules.nextRunAt), asc(projectSchedules.id))
        .limit(input.limit);
      return rows.flatMap((row) =>
        row.nextRunAt
          ? [
              {
                scheduleId: row.scheduleId,
                projectId: row.projectId,
                deploymentId: row.deploymentId,
                nextRunAt: row.nextRunAt.toISOString(),
              },
            ]
          : [],
      );
    },

    async createManualScheduleRun(projectId, scheduleId, now = new Date()) {
      return db.transaction(async (tx) => {
        const [schedule] = await tx
          .select()
          .from(projectSchedules)
          .where(
            and(
              eq(projectSchedules.id, scheduleId),
              eq(projectSchedules.projectId, projectId),
            ),
          )
          .limit(1);
        if (!schedule) throw new Error("Project schedule not found.");
        if (!schedule.enabled) throw new Error("Project schedule is disabled.");
        const [target] = await tx
          .select({ deployment: deployments, release: releases })
          .from(projectSchedulerTargets)
          .innerJoin(
            deployments,
            eq(deployments.id, projectSchedulerTargets.deploymentId),
          )
          .innerJoin(releases, eq(releases.id, deployments.releaseId))
          .where(eq(projectSchedulerTargets.projectId, projectId))
          .limit(1);
        if (!target)
          throw new Error(
            "Project schedule has no deployable scheduler target.",
          );
        const [version] = await tx
          .select()
          .from(scheduleVersions)
          .where(
            and(
              eq(scheduleVersions.scheduleId, scheduleId),
              eq(
                scheduleVersions.sourceRevisionId,
                target.release.sourceRevisionId,
              ),
            ),
          )
          .limit(1);
        if (!version)
          throw new Error(
            "Project schedule has no deployable scheduler target.",
          );
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
      if (!Number.isInteger(input.limit) || input.limit < 1)
        throw new Error("Schedule claim limit must be positive.");
      return db.transaction(async (tx) => {
        const due = await tx
          .select({
            schedule: projectSchedules,
            version: scheduleVersions,
            deployment: deployments,
            release: releases,
          })
          .from(projectSchedules)
          .innerJoin(
            projectSchedulerTargets,
            eq(projectSchedulerTargets.projectId, projectSchedules.projectId),
          )
          .innerJoin(
            deployments,
            eq(deployments.id, projectSchedulerTargets.deploymentId),
          )
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
      const [row] = await db
        .select()
        .from(scheduleRuns)
        .where(eq(scheduleRuns.id, scheduleRunId))
        .limit(1);
      return row ? scheduleRunRowToScheduleRun(row) : null;
    },

    async listScheduleRuns(projectId, input) {
      const conditions = [eq(projectSchedules.projectId, projectId)];
      if (input.scheduleId)
        conditions.push(eq(scheduleRuns.scheduleId, input.scheduleId));
      if (input.trigger)
        conditions.push(eq(scheduleRuns.trigger, input.trigger));
      if (input.status) conditions.push(eq(scheduleRuns.status, input.status));
      if (input.cursor) {
        const [cursor] = await db
          .select({ id: scheduleRuns.id, createdAt: scheduleRuns.createdAt })
          .from(scheduleRuns)
          .innerJoin(
            projectSchedules,
            eq(projectSchedules.id, scheduleRuns.scheduleId),
          )
          .where(
            and(
              eq(scheduleRuns.id, input.cursor),
              eq(projectSchedules.projectId, projectId),
            ),
          )
          .limit(1);
        if (!cursor) return { items: [], nextCursor: null };
        if (cursor)
          conditions.push(
            or(
              lt(scheduleRuns.createdAt, cursor.createdAt),
              and(
                eq(scheduleRuns.createdAt, cursor.createdAt),
                lt(scheduleRuns.id, cursor.id),
              ),
            )!,
          );
      }
      const rows = await db
        .select({ run: scheduleRuns, scheduleKey: projectSchedules.key })
        .from(scheduleRuns)
        .innerJoin(
          projectSchedules,
          eq(projectSchedules.id, scheduleRuns.scheduleId),
        )
        .where(and(...conditions))
        .orderBy(desc(scheduleRuns.createdAt), desc(scheduleRuns.id))
        .limit(input.limit + 1);
      const pageRows = rows.slice(0, input.limit);
      const linkedRows =
        pageRows.length > 0
          ? await db
              .select()
              .from(sessions)
              .where(
                inArray(
                  sessions.scheduleRunId,
                  pageRows.map((row) => row.run.id),
                ),
              )
          : [];
      const linkedSessions = linkedRows.map(sessionRowToSession);
      return {
        items: pageRows.map((row) => {
          const runSessions = linkedSessions.filter(
            (session) => session.scheduleRunId === row.run.id,
          );
          return {
            ...scheduleRunRowToScheduleRun(row.run),
            scheduleKey: row.scheduleKey,
            sessionCount: runSessions.length,
            usage: summarizeSessionUsage(runSessions),
            sessions: runSessions,
          };
        }),
        nextCursor:
          rows.length > input.limit ? (pageRows.at(-1)?.run.id ?? null) : null,
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
        .innerJoin(
          projectSchedules,
          eq(projectSchedules.id, scheduleRuns.scheduleId),
        )
        .innerJoin(
          scheduleVersions,
          eq(scheduleVersions.id, scheduleRuns.scheduleVersionId),
        )
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

    async claimScheduleRunActivation(
      scheduleRunId,
      now = new Date(),
      staleAfterMs = 300_000,
    ) {
      const staleBefore = new Date(now.getTime() - staleAfterMs);
      const [claimed] = await db
        .update(scheduleRuns)
        .set({ status: "activating", startedAt: now, updatedAt: now })
        .where(
          and(
            eq(scheduleRuns.id, scheduleRunId),
            or(
              eq(scheduleRuns.status, "queued"),
              and(
                eq(scheduleRuns.status, "activating"),
                lte(scheduleRuns.updatedAt, staleBefore),
              ),
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
        .set({
          status: "dispatching",
          attempt: sql`${scheduleRuns.attempt} + 1`,
          updatedAt: now,
        })
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
        const [run] = await tx
          .select()
          .from(scheduleRuns)
          .where(eq(scheduleRuns.id, scheduleRunId))
          .limit(1)
          .for("update");
        if (!run) return null;
        const [schedule] = await tx
          .select()
          .from(projectSchedules)
          .where(eq(projectSchedules.id, run.scheduleId))
          .limit(1);
        if (!schedule)
          throw new Error("ScheduleRun references an unknown ProjectSchedule.");

        const trigger = run.trigger === "cron" ? "cron" : "manual";
        for (const eveSessionId of new Set(input.eveSessionIds ?? [])) {
          const [existing] = await tx
            .select({ id: sessions.id })
            .from(sessions)
            .where(
              and(
                eq(sessions.projectId, schedule.projectId),
                eq(sessions.eveSessionId, eveSessionId),
              ),
            )
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
          .set({
            status: input.status,
            error: input.error ?? null,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(scheduleRuns.id, scheduleRunId))
          .returning();
        return completed ? scheduleRunRowToScheduleRun(completed) : null;
      });
    },
  };
}
