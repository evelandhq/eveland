import type { MiddlewareHandler } from "hono";
import type { ApiApp } from "./app-types.js";

// Composer only: the Project protocol is four vertical slices, each owning
// its route family. Cross-cutting deletion guarding stays here so every
// slice registers behind it. The composer's store is the union of the slice
// ports, so this file never sees more of the Store than its slices declare.
import {
  registerProjectDeploymentRoutes,
  type ProjectDeploymentOptions,
  type ProjectDeploymentStore,
} from "./app-project-deployment-routes.js";
import {
  registerProjectLifecycleRoutes,
  type ProjectLifecycleStore,
} from "./app-project-lifecycle-routes.js";
import {
  registerProjectMetadataRoutes,
  type ProjectMetadataStore,
} from "./app-project-metadata-routes.js";
import {
  registerProjectSourceRoutes,
  type ProjectSourceStore,
} from "./app-project-source-routes.js";

export type ProjectRoutesStore = ProjectLifecycleStore &
  ProjectMetadataStore &
  ProjectDeploymentStore &
  ProjectSourceStore;

export function registerProjectRoutes(input: {
  app: ApiApp;
  store: ProjectRoutesStore;
  options: ProjectDeploymentOptions;
  dataDir: string;
  appSecretKey: string;
  sourcePreflightTtlMs: number;
}): void {
  const { app, store, options, dataDir, appSecretKey, sourcePreflightTtlMs } =
    input;
  const rejectProjectMutationsWhileDeleting: MiddlewareHandler = async (
    c,
    next,
  ) => {
    const method = c.req.method;
    const projectDelete =
      method === "DELETE" &&
      /^\/projects\/[^/]+\/?$/.test(new URL(c.req.url).pathname);
    if (
      method === "GET" ||
      method === "HEAD" ||
      method === "OPTIONS" ||
      projectDelete
    ) {
      await next();
      return;
    }

    const projectId = c.req.param("projectId");
    if (!projectId) {
      await next();
      return;
    }
    const project = await store.getProject(projectId);
    if (project?.deletionStatus === "deleting") {
      return c.json({ error: "Project is being deleted" }, 409);
    }
    await next();
  };
  app.use("/projects/:projectId", rejectProjectMutationsWhileDeleting);
  app.use("/projects/:projectId/*", rejectProjectMutationsWhileDeleting);


  registerProjectSourceRoutes({ app, store, dataDir, appSecretKey, sourcePreflightTtlMs });
  registerProjectMetadataRoutes({ app, store });
  registerProjectDeploymentRoutes({ app, store, options });
  registerProjectLifecycleRoutes({ app, store });
}
