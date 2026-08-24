import { type Store } from "@evelandhq/db";
import type { ApiApp } from "./app-types.js";
import { updateProjectMetadataSchema } from "./app-schemas.js";
import { resolveProjectEveVersion, type EveVersionStore } from "./app-support.js";

// The narrow persistence port this slice actually needs.
export type ProjectMetadataStore = Pick<
  Store,
  | "getProject"
  | "listProjects"
  | "listProjectActivity"
  | "listScheduleAttention"
  | "updateProjectMetadata"
> &
  EveVersionStore;

/** The run-history strip on the projects list covers a rolling month. */
const ACTIVITY_WINDOW_DAYS = 30;

export function registerProjectMetadataRoutes(input: {
  app: ApiApp;
  store: ProjectMetadataStore;
}): void {
  const { app, store } = input;
  app.get("/projects", async (c) => {
    const [projects, activity, attention] = await Promise.all([
      store.listProjects(),
      store.listProjectActivity({ days: ACTIVITY_WINDOW_DAYS }),
      store.listScheduleAttention(),
    ]);
    const activityByProject = new Map(activity.map(({ projectId, ...rest }) => [projectId, rest]));
    const attentionByProject = new Map(
      attention.map((entry) => [entry.projectId, entry.unacknowledgedFailedRuns]),
    );
    const quietProject = {
      days: Array.from({ length: ACTIVITY_WINDOW_DAYS }, () => "none" as const),
      sessions: 0,
      succeeded: 0,
      failed: 0,
      awaiting: 0,
      successRate: null,
      p95DurationMs: null,
    };
    return c.json({
      projects: await Promise.all(
        projects.map(async (project) => ({
          ...project,
          eveVersion: await resolveProjectEveVersion(store, project.id),
          activity: activityByProject.get(project.id) ?? quietProject,
          unacknowledgedFailedRuns: attentionByProject.get(project.id) ?? 0,
        })),
      ),
    });
  });

  app.get("/projects/:projectId", async (c) => {
    const project = await store.getProject(c.req.param("projectId"));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    return c.json({ project });
  });

  app.patch("/projects/:projectId", async (c) => {
    const parsed = updateProjectMetadataSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid project metadata",
          issues: parsed.error.issues,
        },
        400,
      );
    }
    const project = await store.updateProjectMetadata(c.req.param("projectId"), parsed.data);
    return project ? c.json({ project }) : c.json({ error: "Project not found" }, 404);
  });
}
