import type { LogRecord } from "@eveland/core/contracts";
import type { Store } from "@eveland/db";
import type { ApiApp } from "./app-types.js";
import {
  scheduleRunListQuerySchema,
  sessionListQuerySchema,
  usageAnalyticsQuerySchema,
} from "./app-schemas.js";
import { resolveProjectEveVersion } from "./app-support.js";

export function registerQueryRoutes(app: ApiApp, store: Store): void {
  app.get("/usage", async (c) => {
    const parsed = usageAnalyticsQuerySchema.safeParse(c.req.query());
    if (!parsed.success)
      return c.json(
        { error: "Invalid usage filters", issues: parsed.error.issues },
        400,
      );
    return c.json({ usage: await store.getUsageAnalytics(parsed.data) });
  });

  app.get("/projects/:projectId/usage", async (c) => {
    const projectId = c.req.param("projectId");
    if (!(await store.getProject(projectId)))
      return c.json({ error: "Project not found" }, 404);
    const parsed = usageAnalyticsQuerySchema.safeParse(c.req.query());
    if (!parsed.success)
      return c.json(
        { error: "Invalid usage filters", issues: parsed.error.issues },
        400,
      );
    return c.json({
      usage: await store.getUsageAnalytics({ ...parsed.data, projectId }),
    });
  });

  app.get("/projects/:projectId/schedules", async (c) => {
    return c.json({
      schedules: await store.listProjectScheduleSummaries(
        c.req.param("projectId"),
      ),
    });
  });

  app.post("/projects/:projectId/schedules/:scheduleId/runs", async (c) => {
    try {
      const run = await store.createManualScheduleRun(
        c.req.param("projectId"),
        c.req.param("scheduleId"),
      );
      return c.json({ run }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json(
        { error: message },
        message === "Project schedule not found." ? 404 : 409,
      );
    }
  });

  app.get("/projects/:projectId/schedule-runs", async (c) => {
    const parsed = scheduleRunListQuerySchema.safeParse(c.req.query());
    if (!parsed.success)
      return c.json(
        { error: "Invalid schedule-run filters", issues: parsed.error.issues },
        400,
      );
    const page = await store.listScheduleRuns(
      c.req.param("projectId"),
      parsed.data,
    );
    return c.json({ runs: page.items, nextCursor: page.nextCursor });
  });

  app.get("/schedule-runs/:scheduleRunId", async (c) => {
    const run = await store.getScheduleRunDetail(c.req.param("scheduleRunId"));
    return run
      ? c.json({ run })
      : c.json({ error: "ScheduleRun not found" }, 404);
  });

  app.get("/projects/:projectId/source/revision", async (c) => {
    return c.json({
      revision: await store.getCurrentSourceRevision(c.req.param("projectId")),
    });
  });

  app.get("/projects/:projectId/eve-version", async (c) => {
    const projectId = c.req.param("projectId");
    if (!(await store.getProject(projectId)))
      return c.json({ error: "Project not found" }, 404);
    return c.json({
      eveVersion: await resolveProjectEveVersion(store, projectId),
    });
  });

  app.get("/projects/:projectId/source/files", async (c) => {
    return c.json({
      files: await store.listSourceFiles(c.req.param("projectId")),
    });
  });

  app.get("/projects/:projectId/source/file", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) {
      return c.json({ error: "Missing source file path" }, 400);
    }

    return c.json({
      file: await store.getSourceFile(c.req.param("projectId"), filePath),
    });
  });

  app.get("/projects/:projectId/sessions", async (c) => {
    const parsed = sessionListQuerySchema.safeParse(c.req.query());
    if (!parsed.success)
      return c.json(
        { error: "Invalid Session filters", issues: parsed.error.issues },
        400,
      );
    const page = await store.listSessionsPage(
      c.req.param("projectId"),
      parsed.data,
    );
    return c.json({ sessions: page.items, nextCursor: page.nextCursor });
  });

  app.get("/sessions/:sessionId/events", async (c) => {
    return c.json({
      events: await store.listSessionEvents(c.req.param("sessionId")),
    });
  });

  app.get("/sessions/:sessionId", async (c) => {
    const session = await store.getSession(c.req.param("sessionId"));
    return session
      ? c.json({ session })
      : c.json({ error: "Session not found" }, 404);
  });

  app.get("/sessions/:sessionId/usage", async (c) => {
    return c.json({
      usage: await store.listModelUsageEvents(c.req.param("sessionId")),
    });
  });

  app.get("/sessions/:sessionId/nodes", async (c) => {
    return c.json({
      nodes: await store.listSessionNodes(c.req.param("sessionId")),
    });
  });

  app.get("/sessions/:sessionId/telemetry", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = await store.getSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const nodes = await store.listSessionNodes(sessionId);
    const eveSessionIds = uniqueStrings([
      session.eveSessionId,
      ...nodes.map((node) => node.eveSessionId),
    ]);
    const spans =
      eveSessionIds.length === 0
        ? []
        : await store.listOtlpSpans({
            domain: "agent",
            projectId: session.projectId,
            eveSessionIds,
            limit: 2_000,
          });
    const traceIds = uniqueStrings(
      spans.map((span) => span.traceId),
    );
    const [sessionLogs, traceLogs] = await Promise.all([
      eveSessionIds.length === 0
        ? []
        : store.listOtlpLogRecords({
            domain: "agent",
            projectId: session.projectId,
            eveSessionIds,
            limit: 2_000,
          }),
      traceIds.length === 0
        ? []
        : store.listOtlpLogRecords({
            projectId: session.projectId,
            traceIds,
            limit: 2_000,
          }),
    ]);
    return c.json({
      telemetry: {
        sessionId,
        eveSessionIds,
        traceIds,
        spans,
        logs: uniqueById([...sessionLogs, ...traceLogs]),
      },
    });
  });

  app.get("/projects/:projectId/logs", async (c) => {
    const type = c.req.query("type") as LogRecord["type"] | undefined;
    return c.json({
      logs: await store.listLogs(c.req.param("projectId"), type),
    });
  });
}

function uniqueStrings(
  values: Array<string | null | undefined>,
): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}
