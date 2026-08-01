import { rm } from "node:fs/promises";
import {
  inferProjectSlugFromGitUrl,
  normalizeGitHttpHost,
} from "@eveland/core/ids";
import { toPublicJob } from "@eveland/core/jobs";
import { encryptSecretValue } from "@eveland/core/server/secrets";
import {
  DEFAULT_API_SESSION_IDLE_TTL_MS,
  DEFAULT_PLAYGROUND_SESSION_IDLE_TTL_MS,
} from "@eveland/core/routing";
import {
  DeploymentNotFoundError,
  DeploymentNotPromotableError,
  ProjectRouteNotFoundError,
  ProjectSlugConflictError,
  type Store,
} from "@eveland/db";
import type { MiddlewareHandler } from "hono";
import { publicDeployment } from "./app-public-projections.js";
import type { ApiApp, AppOptions } from "./app-types.js";
import {
  aliasSchema,
  buildDeploySchema,
  createGitSourcePreflightSchema,
  createProjectFromPreflightSchema,
  createProjectSchema,
  projectNameSchema,
  routeTargetsSchema,
  syncSourceSchema,
  updateProjectMetadataSchema,
} from "./app-schemas.js";
import { bodyLimit } from "hono/body-limit";
import {
  createZipProjectFromUpload,
  currentUserId,
  extractZipUpload,
  InvalidZipUploadError,
  invalidateGateway,
  invalidateGatewayAfterCommit,
  isMultipartRequest,
  publicGatewayUrl,
  resolveProjectEveVersion,
} from "./app-support.js";

// Composer only: the Project protocol is four vertical slices, each owning
// its route family. Cross-cutting deletion guarding stays here so every
// slice registers behind it.
import { registerProjectDeploymentRoutes } from "./app-project-deployment-routes.js";
import { registerProjectLifecycleRoutes } from "./app-project-lifecycle-routes.js";
import { registerProjectMetadataRoutes } from "./app-project-metadata-routes.js";
import { registerProjectSourceRoutes } from "./app-project-source-routes.js";

export function registerProjectRoutes(input: {
  app: ApiApp;
  store: Store;
  options: AppOptions;
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
