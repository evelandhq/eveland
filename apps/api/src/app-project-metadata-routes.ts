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

export function registerProjectMetadataRoutes(input: {
  app: ApiApp;
  store: Store;
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
    const parsed = updateProjectMetadataSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid project metadata",
          issues: parsed.error.issues,
        },
        400,
      );
    }
    const project = await store.updateProjectMetadata(
      c.req.param("projectId"),
      parsed.data,
    );
    return project
      ? c.json({ project })
      : c.json({ error: "Project not found" }, 404);
  });

}
