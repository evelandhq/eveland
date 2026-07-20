import type {
  AgentModelUsageBreakdown,
  ModelUsageBreakdown,
  ProjectUsageBreakdown,
  SessionStatus,
  UsageAnalytics,
  UsageRange,
  UsageSeriesPoint,
  UsageTotals,
} from "@eveland/core/contracts";
import { and, eq, gte, lt } from "drizzle-orm";
import { sessionRowToSession } from "./mappers.js";
import {
  modelUsageEvents,
  projects,
  sessionNodes,
  sessions,
} from "./schema.js";
import type {
  PostgresDomain,
  PostgresStoreContext,
} from "./postgres-store-support.js";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

type UsageWindow = {
  from: Date;
  to: Date;
  previousFrom: Date;
  bucket: "hour" | "day";
  bucketMs: number;
  bucketCount: number;
};

type TotalsWithSessions<T> = T & { sessionIds: Set<string> };

function emptyTotals(): UsageTotals {
  return {
    sessions: 0,
    runningSessions: 0,
    waitingSessions: 0,
    completedSessions: 0,
    failedSessions: 0,
    modelSteps: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    reportedSteps: 0,
    missingSteps: 0,
    costReportedSteps: 0,
  };
}

function addSession(totals: UsageTotals, status: SessionStatus): void {
  totals.sessions += 1;
  if (status === "running") totals.runningSessions += 1;
  if (status === "waiting" || status === "waiting_approval")
    totals.waitingSessions += 1;
  if (status === "completed") totals.completedSessions += 1;
  if (status === "failed") totals.failedSessions += 1;
}

function addUsage(
  totals: UsageTotals,
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    costUsd: number | null;
    usageReported: boolean;
  },
): void {
  totals.modelSteps += 1;
  totals.inputTokens += usage.inputTokens ?? 0;
  totals.outputTokens += usage.outputTokens ?? 0;
  totals.cacheReadTokens += usage.cacheReadTokens ?? 0;
  totals.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  if (usage.costUsd !== null) {
    totals.costUsd = (totals.costUsd ?? 0) + usage.costUsd;
    totals.costReportedSteps += 1;
  }
  if (usage.usageReported) totals.reportedSteps += 1;
  else totals.missingSteps += 1;
}

function usageWindow(range: UsageRange, now: Date): UsageWindow {
  const bucket = range === "24h" ? "hour" : "day";
  const bucketMs = bucket === "hour" ? HOUR_MS : DAY_MS;
  const bucketCount = range === "24h" ? 24 : range === "7d" ? 7 : 30;
  const nowMs = now.getTime();
  const remainder = nowMs % bucketMs;
  const toMs = remainder === 0 ? nowMs : nowMs + bucketMs - remainder;
  const fromMs = toMs - bucketCount * bucketMs;
  return {
    from: new Date(fromMs),
    to: new Date(toMs),
    previousFrom: new Date(fromMs - bucketCount * bucketMs),
    bucket,
    bucketMs,
    bucketCount,
  };
}

function inWindow(value: Date, from: Date, to: Date): boolean {
  return value >= from && value < to;
}

function bucketIndex(value: Date, window: UsageWindow): number {
  return Math.floor((value.getTime() - window.from.getTime()) / window.bucketMs);
}

function sortedBreakdown<T extends UsageTotals>(rows: T[]): T[] {
  return rows.sort(
    (left, right) =>
      right.inputTokens +
        right.outputTokens -
        (left.inputTokens + left.outputTokens) ||
      right.modelSteps - left.modelSteps ||
      right.sessions - left.sessions,
  );
}

export function createPostgresUsageStore({
  db,
}: PostgresStoreContext): PostgresDomain {
  return {
    async getUsageAnalytics(input): Promise<UsageAnalytics> {
      const range = input.range;
      const window = usageWindow(range, input.now ?? new Date());
      const projectCondition = input.projectId
        ? eq(sessions.projectId, input.projectId)
        : undefined;

      const sessionRows = await db
        .select({ session: sessions, projectName: projects.name })
        .from(sessions)
        .innerJoin(projects, eq(projects.id, sessions.projectId))
        .where(
          and(
            projectCondition,
            gte(sessions.startedAt, window.previousFrom),
            lt(sessions.startedAt, window.to),
          ),
        );

      const usageRows = await db
        .select({
          usage: modelUsageEvents,
          session: sessions,
          projectName: projects.name,
          modelId: sessionNodes.modelId,
        })
        .from(modelUsageEvents)
        .innerJoin(sessions, eq(sessions.id, modelUsageEvents.sessionId))
        .innerJoin(projects, eq(projects.id, sessions.projectId))
        .leftJoin(sessionNodes, eq(sessionNodes.id, modelUsageEvents.sessionNodeId))
        .where(
          and(
            projectCondition,
            gte(modelUsageEvents.createdAt, window.previousFrom),
            lt(modelUsageEvents.createdAt, window.to),
          ),
        );

      const currentSessionRows = sessionRows.filter((row) =>
        inWindow(row.session.startedAt, window.from, window.to),
      );
      const previousSessionRows = sessionRows.filter((row) =>
        inWindow(row.session.startedAt, window.previousFrom, window.from),
      );
      const currentScopeUsageRows = usageRows.filter((row) =>
        inWindow(row.usage.createdAt, window.from, window.to),
      );
      const previousScopeUsageRows = usageRows.filter((row) =>
        inWindow(row.usage.createdAt, window.previousFrom, window.from),
      );
      const currentUsageRows = input.modelId
        ? currentScopeUsageRows.filter((row) => row.modelId === input.modelId)
        : currentScopeUsageRows;
      const previousUsageRows = input.modelId
        ? previousScopeUsageRows.filter((row) => row.modelId === input.modelId)
        : previousScopeUsageRows;

      const currentUsageSessions = new Map(
        currentUsageRows.map((row) => [row.session.id, row] as const),
      );
      const previousUsageSessions = new Map(
        previousUsageRows.map((row) => [row.session.id, row] as const),
      );
      const selectedCurrentSessions = input.modelId
        ? [...currentUsageSessions.values()].map((row) => ({
            session: row.session,
            projectName: row.projectName,
          }))
        : currentSessionRows;
      const selectedPreviousSessions = input.modelId
        ? [...previousUsageSessions.values()].map((row) => ({
            session: row.session,
            projectName: row.projectName,
          }))
        : previousSessionRows;

      const summary = emptyTotals();
      const previousSummary = emptyTotals();
      selectedCurrentSessions.forEach((row) =>
        addSession(summary, row.session.status as SessionStatus),
      );
      selectedPreviousSessions.forEach((row) =>
        addSession(previousSummary, row.session.status as SessionStatus),
      );
      currentUsageRows.forEach((row) => addUsage(summary, row.usage));
      previousUsageRows.forEach((row) => addUsage(previousSummary, row.usage));

      const series: UsageSeriesPoint[] = Array.from(
        { length: window.bucketCount },
        (_, index) => ({
          bucketStart: new Date(
            window.from.getTime() + index * window.bucketMs,
          ).toISOString(),
          ...emptyTotals(),
        }),
      );
      const firstUsageBySession = new Map<string, (typeof currentUsageRows)[number]>();
      currentUsageRows.forEach((row) => {
        const current = firstUsageBySession.get(row.session.id);
        if (!current || row.usage.createdAt < current.usage.createdAt)
          firstUsageBySession.set(row.session.id, row);
        const index = bucketIndex(row.usage.createdAt, window);
        if (series[index]) addUsage(series[index], row.usage);
      });
      if (input.modelId) {
        firstUsageBySession.forEach((row) => {
          const index = bucketIndex(row.usage.createdAt, window);
          if (series[index])
            addSession(series[index], row.session.status as SessionStatus);
        });
      } else {
        currentSessionRows.forEach((row) => {
          const index = bucketIndex(row.session.startedAt, window);
          if (series[index])
            addSession(series[index], row.session.status as SessionStatus);
        });
      }

      const projectMap = new Map<
        string,
        TotalsWithSessions<ProjectUsageBreakdown>
      >();
      const ensureProject = (projectId: string, projectName: string) => {
        const existing = projectMap.get(projectId);
        if (existing) return existing;
        const created = {
          projectId,
          projectName,
          ...emptyTotals(),
          sessionIds: new Set<string>(),
        };
        projectMap.set(projectId, created);
        return created;
      };
      selectedCurrentSessions.forEach((row) => {
        const project = ensureProject(row.session.projectId, row.projectName);
        if (!project.sessionIds.has(row.session.id)) {
          project.sessionIds.add(row.session.id);
          addSession(project, row.session.status as SessionStatus);
        }
      });
      currentUsageRows.forEach((row) => {
        addUsage(
          ensureProject(row.session.projectId, row.projectName),
          row.usage,
        );
      });

      const modelMap = new Map<
        string,
        TotalsWithSessions<ModelUsageBreakdown>
      >();
      const agentModelMap = new Map<
        string,
        TotalsWithSessions<AgentModelUsageBreakdown>
      >();
      currentScopeUsageRows.forEach((row) => {
        const modelKey = row.modelId ?? "__unknown_model__";
        const model = modelMap.get(modelKey) ?? {
          modelId: row.modelId,
          ...emptyTotals(),
          sessionIds: new Set<string>(),
        };
        addUsage(model, row.usage);
        model.sessionIds.add(row.session.id);
        modelMap.set(modelKey, model);

        if (input.modelId && row.modelId !== input.modelId) return;

        const agentKey = row.usage.agentId ?? row.usage.eveSessionId;
        const agentModelKey = `${row.session.projectId}\u0000${agentKey}\u0000${modelKey}`;
        const agentModel = agentModelMap.get(agentModelKey) ?? {
          projectId: row.session.projectId,
          projectName: row.projectName,
          agentId: row.usage.agentId,
          agentName: row.usage.agentName,
          modelId: row.modelId,
          ...emptyTotals(),
          sessionIds: new Set<string>(),
        };
        addUsage(agentModel, row.usage);
        agentModel.sessionIds.add(row.session.id);
        agentModelMap.set(agentModelKey, agentModel);
      });

      const currentSessionStatus = new Map(
        currentScopeUsageRows.map((row) => [
          row.session.id,
          row.session.status as SessionStatus,
        ]),
      );
      modelMap.forEach((model) => {
        model.sessionIds.forEach((sessionId) => {
          const status = currentSessionStatus.get(sessionId);
          if (status) addSession(model, status);
        });
      });
      agentModelMap.forEach((agentModel) => {
        agentModel.sessionIds.forEach((sessionId) => {
          const status = currentSessionStatus.get(sessionId);
          if (status) addSession(agentModel, status);
        });
      });

      const projectsResult = sortedBreakdown(
        [...projectMap.values()].map(({ sessionIds: _sessionIds, ...row }) =>
          row,
        ),
      );
      const models = sortedBreakdown(
        [...modelMap.values()].map(({ sessionIds: _sessionIds, ...row }) =>
          row,
        ),
      );
      const agentModels = sortedBreakdown(
        [...agentModelMap.values()].map(
          ({ sessionIds: _sessionIds, ...row }) => row,
        ),
      );

      const recentSessions = selectedCurrentSessions
        .map((row) => ({
          ...sessionRowToSession(row.session),
          projectName: row.projectName,
        }))
        .sort(
          (left, right) =>
            Date.parse(right.startedAt) - Date.parse(left.startedAt),
        )
        .slice(0, 20);

      return {
        range,
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        bucket: window.bucket,
        modelId: input.modelId ?? null,
        summary,
        previousSummary,
        series,
        projects: projectsResult,
        models,
        agentModels,
        recentSessions,
      };
    },
  };
}
