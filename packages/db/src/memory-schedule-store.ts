import type {
  ProjectScheduleVersion,
  ScheduleRun,
  ScheduleVersion,
  SessionTrigger,
} from "@eveland/core/contracts";
import { createId } from "@eveland/core/ids";
import { getNextRunAt } from "@eveland/core/schedules";
import type { MemoryState } from "./memory-state.js";
import { createMemoryJob, type MemoryDomain } from "./memory-store-support.js";
import { emptySessionTokenUsage } from "./memory-observer-store.js";
import { summarizeSessionUsage } from "./session-usage.js";
import type { ScheduleStore } from "./store-domains.js";

export function createMemoryScheduleStore(state: MemoryState): MemoryDomain<ScheduleStore> {
  return {
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
      state.jobs.push(createMemoryJob(projectId, "trigger_schedule", { scheduleRunId: run.id }));
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
        state.jobs.push(createMemoryJob(schedule.projectId, "trigger_schedule", { scheduleRunId: run.id }));
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

  };
}
