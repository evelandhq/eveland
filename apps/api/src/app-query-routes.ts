import type { LogRecord } from "@evelandhq/core/contracts";
import type { Store } from "@evelandhq/db";
import type { ApiApp } from "./app-types.js";
import { publicDeployment, publicRelease, publicSourceRevision } from "./app-public-projections.js";
import {
  acknowledgeScheduleRunsSchema,
  scheduleRunListQuerySchema,
  sessionListQuerySchema,
  usageAnalyticsQuerySchema,
} from "./app-schemas.js";
import { resolveProjectEveVersion } from "./app-support.js";

export function registerQueryRoutes(app: ApiApp, store: Store): void {
  app.get("/usage", async (c) => {
    const parsed = usageAnalyticsQuerySchema.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: "Invalid usage filters", issues: parsed.error.issues }, 400);
    return c.json({
      usage: await store.getUsageAnalytics(parsed.data),
    });
  });

  app.get("/projects/:projectId/usage", async (c) => {
    const projectId = c.req.param("projectId");
    if (!(await store.getProject(projectId))) return c.json({ error: "Project not found" }, 404);
    const parsed = usageAnalyticsQuerySchema.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: "Invalid usage filters", issues: parsed.error.issues }, 400);
    return c.json({
      usage: await store.getUsageAnalytics({ ...parsed.data, projectId }),
    });
  });

  app.get("/projects/:projectId/schedules", async (c) => {
    return c.json({
      schedules: await store.listProjectScheduleSummaries(c.req.param("projectId")),
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
      return c.json({ error: message }, message === "Project schedule not found." ? 404 : 409);
    }
  });

  app.post("/projects/:projectId/schedule-runs/acknowledge", async (c) => {
    const parsed = acknowledgeScheduleRunsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return c.json({ error: "Invalid acknowledgement", issues: parsed.error.issues }, 400);
    const projectId = c.req.param("projectId");
    if (!(await store.getProject(projectId))) return c.json({ error: "Project not found" }, 404);
    return c.json({
      acknowledged: await store.acknowledgeScheduleRuns(projectId, parsed.data),
    });
  });

  app.get("/projects/:projectId/schedule-attention", async (c) => {
    const projectId = c.req.param("projectId");
    const attention = (await store.listScheduleAttention()).find(
      (entry) => entry.projectId === projectId,
    );
    return c.json({
      unacknowledgedFailedRuns: attention?.unacknowledgedFailedRuns ?? 0,
    });
  });

  app.get("/projects/:projectId/schedule-runs", async (c) => {
    const parsed = scheduleRunListQuerySchema.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: "Invalid schedule-run filters", issues: parsed.error.issues }, 400);
    const page = await store.listScheduleRuns(c.req.param("projectId"), parsed.data);
    return c.json({
      runs: page.items,
      nextCursor: page.nextCursor,
    });
  });

  app.get("/schedule-runs/:scheduleRunId", async (c) => {
    const run = await store.getScheduleRunDetail(c.req.param("scheduleRunId"));
    return run
      ? c.json({
          run: {
            ...run,
            deployment: publicDeployment(run.deployment),
            release: publicRelease(run.release),
          },
        })
      : c.json({ error: "ScheduleRun not found" }, 404);
  });

  app.get("/projects/:projectId/source/revision", async (c) => {
    const revision = await store.getCurrentSourceRevision(c.req.param("projectId"));
    return c.json({
      revision: revision ? publicSourceRevision(revision) : null,
    });
  });

  app.get("/projects/:projectId/eve-version", async (c) => {
    const projectId = c.req.param("projectId");
    if (!(await store.getProject(projectId))) return c.json({ error: "Project not found" }, 404);
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
      return c.json({ error: "Invalid Session filters", issues: parsed.error.issues }, 400);
    const page = await store.listSessionsPage(c.req.param("projectId"), parsed.data);
    return c.json({
      sessions: page.items,
      nextCursor: page.nextCursor,
    });
  });

  app.get("/sessions/:sessionId/events", async (c) => {
    return c.json({
      events: await store.listSessionEvents(c.req.param("sessionId")),
    });
  });

  app.get("/sessions/:sessionId", async (c) => {
    const session = await store.getSession(c.req.param("sessionId"));
    return session ? c.json({ session }) : c.json({ error: "Session not found" }, 404);
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

  app.get("/projects/:projectId/logs", async (c) => {
    const type = c.req.query("type") as LogRecord["type"] | undefined;
    return c.json({
      logs: await store.listLogs(c.req.param("projectId"), type),
    });
  });
}
