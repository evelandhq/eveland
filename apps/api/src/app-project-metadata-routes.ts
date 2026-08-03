import { type Store } from "@eveland/db";
import type { ApiApp } from "./app-types.js";
import { updateProjectMetadataSchema } from "./app-schemas.js";
import { resolveProjectEveVersion, type EveVersionStore } from "./app-support.js";

// The narrow persistence port this slice actually needs.
export type ProjectMetadataStore = Pick<
  Store,
  "getProject" | "listProjects" | "updateProjectMetadata"
> &
  EveVersionStore;

export function registerProjectMetadataRoutes(input: {
  app: ApiApp;
  store: ProjectMetadataStore;
}): void {
  const { app, store } = input;
  app.get("/projects", async (c) => {
    const projects = await store.listProjects();
    return c.json({
      projects: await Promise.all(
        projects.map(async (project) => ({
          ...project,
          eveVersion: await resolveProjectEveVersion(store, project.id),
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
