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

type CreateGitCredentialInput = {
  userId: string;
  host: string;
  encryptedToken: string;
  persistAfterImport: boolean;
};

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
  const deploymentRetentionOptions = () => ({
    now: options.sessionBindingNow?.() ?? new Date(),
    playgroundIdleTtlMs:
      options.playgroundSessionIdleTtlMs ??
      Number(
        process.env.EVELAND_PLAYGROUND_SESSION_IDLE_TTL_MS ??
          DEFAULT_PLAYGROUND_SESSION_IDLE_TTL_MS,
      ),
    apiIdleTtlMs:
      options.apiSessionIdleTtlMs ??
      Number(
        process.env.EVELAND_API_SESSION_IDLE_TTL_MS ??
          DEFAULT_API_SESSION_IDLE_TTL_MS,
      ),
  });
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

  app.get("/projects/name-availability", async (c) => {
    const parsed = projectNameSchema.safeParse(c.req.query("name"));
    if (!parsed.success) {
      return c.json(
        { error: "Invalid project name", issues: parsed.error.issues },
        400,
      );
    }
    return c.json({
      available: await store.isProjectSlugAvailable(parsed.data),
    });
  });

  app.get("/git-credentials", async (c) => {
    return c.json({
      credentials: await store.listGitCredentials(currentUserId(c)),
    });
  });

  app.delete("/git-credentials/:credentialId", async (c) => {
    const deleted = await store.deleteGitCredential(
      currentUserId(c),
      c.req.param("credentialId"),
    );
    return deleted
      ? c.body(null, 204)
      : c.json({ error: "Git credential not found" }, 404);
  });

  // Uploads were previously unbounded: c.req.formData() buffers the archive
  // in memory, so a single request could exhaust the API process. Playground
  // and OTLP bodies already have caps; this closes the last unbounded route.
  const uploadBodyLimit = bodyLimit({
    maxSize: Number(process.env.EVELAND_MAX_UPLOAD_BYTES ?? 104_857_600),
    onError: (c) => c.json({ error: "Upload too large" }, 413),
  });

  app.post("/source-preflights", uploadBodyLimit, async (c) => {
    const expiresAt = new Date(Date.now() + sourcePreflightTtlMs);
    if (isMultipartRequest(c)) {
      const form = await c.req.formData();
      const archive = form.get("archive");
      if (!(archive instanceof File) || archive.size === 0) {
        return c.json(
          {
            error: "Invalid zip upload",
            issues: [
              { path: ["archive"], message: "Source archive is required" },
            ],
          },
          400,
        );
      }
      let extracted;
      try {
        extracted = await extractZipUpload(archive, dataDir);
      } catch (error) {
        if (error instanceof InvalidZipUploadError) {
          return c.json(
            { error: "Invalid zip upload", issues: [{ path: ["archive"], message: error.message }] },
            400,
          );
        }
        throw error;
      }
      const { sourcePath, uploadDir } = extracted;
      try {
        const preflight = await store.createSourcePreflight({
          userId: currentUserId(c),
          kind: "zip",
          sourcePath,
          expiresAt,
        });
        return c.json({ preflight }, 202);
      } catch (error) {
        await rm(uploadDir, { recursive: true, force: true });
        throw error;
      }
    }

    const parsed = createGitSourcePreflightSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        {
          error: "Invalid source preflight input",
          issues: parsed.error.issues,
        },
        400,
      );
    const userId = currentUserId(c);
    const host = normalizeGitHttpHost(parsed.data.gitUrl);
    if (parsed.data.gitlabPat && !host) {
      return c.json(
        {
          error:
            "GitLab PAT authentication requires an HTTPS repository URL without embedded credentials.",
        },
        400,
      );
    }
    const stored =
      host && !parsed.data.gitlabPat
        ? await store.getGitCredential(userId, host)
        : null;
    const gitCredential: CreateGitCredentialInput | undefined =
      parsed.data.gitlabPat && host
        ? {
            userId,
            host,
            encryptedToken: JSON.stringify(
              encryptSecretValue(parsed.data.gitlabPat, appSecretKey),
            ),
            persistAfterImport: true,
          }
        : stored
          ? {
              userId,
              host: stored.host,
              encryptedToken: stored.encryptedToken,
              persistAfterImport: false,
            }
          : undefined;
    const preflight = await store.createSourcePreflight({
      userId,
      kind: "git",
      gitUrl: parsed.data.gitUrl,
      expiresAt,
      ...(gitCredential ? { gitCredential } : {}),
    });
    return c.json({ preflight }, 202);
  });

  app.get("/source-preflights/:preflightId", async (c) => {
    const preflight = await store.getSourcePreflight(
      c.req.param("preflightId"),
      currentUserId(c),
    );
    return preflight
      ? c.json({ preflight })
      : c.json({ error: "Source preflight not found" }, 404);
  });

  app.post("/projects", uploadBodyLimit, async (c) => {
    if (isMultipartRequest(c)) {
      return createZipProjectFromUpload(c, store, dataDir);
    }

    const input = await c.req.json().catch(() => null);
    if (typeof input === "object" && input !== null && "preflightId" in input) {
      const parsedPreflight = createProjectFromPreflightSchema.safeParse(input);
      if (!parsedPreflight.success) {
        return c.json(
          {
            error: "Invalid project input",
            issues: parsedPreflight.error.issues,
          },
          400,
        );
      }
      try {
        const { environmentVariables, ...projectInput } = parsedPreflight.data;
        const result = await store.createProjectFromSourcePreflight({
          ...projectInput,
          userId: currentUserId(c),
          secrets: environmentVariables.map((variable) => ({
            key: variable.key,
            kind: variable.kind,
            encryptedValue: JSON.stringify(
              encryptSecretValue(variable.value, appSecretKey),
            ),
          })),
        });
        if (result.outcome === "not_found")
          return c.json({ error: "Source preflight not found" }, 404);
        if (result.outcome === "not_ready")
          return c.json({ error: "Source preflight is not ready" }, 409);
        if (result.outcome === "consumed")
          return c.json(
            { error: "Source preflight has already been used" },
            409,
          );
        return c.json({ project: result.project }, 201);
      } catch (error) {
        if (error instanceof ProjectSlugConflictError)
          return c.json({ error: error.message }, 409);
        throw error;
      }
    }

    const parsed = createProjectSchema.safeParse(input);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid project input", issues: parsed.error.issues },
        400,
      );
    }

    const name =
      parsed.data.importKind === "git"
        ? (parsed.data.name ?? inferProjectSlugFromGitUrl(parsed.data.gitUrl))
        : parsed.data.name;
    if (!name) {
      return c.json({ error: "Invalid project input" }, 400);
    }
    let gitCredential: CreateGitCredentialInput | undefined;
    if (parsed.data.importKind === "git") {
      const host = normalizeGitHttpHost(parsed.data.gitUrl);
      if (parsed.data.gitlabPat && !host) {
        return c.json(
          {
            error:
              "GitLab PAT authentication requires an HTTPS repository URL without embedded credentials.",
          },
          400,
        );
      }
      if (host) {
        const userId = currentUserId(c);
        const stored = parsed.data.gitlabPat
          ? null
          : await store.getGitCredential(userId, host);
        if (parsed.data.gitlabPat) {
          gitCredential = {
            userId,
            host,
            encryptedToken: JSON.stringify(
              encryptSecretValue(parsed.data.gitlabPat, appSecretKey),
            ),
            persistAfterImport: true,
          };
        } else if (stored) {
          gitCredential = {
            userId,
            host,
            encryptedToken: stored.encryptedToken,
            persistAfterImport: false,
          };
        }
      }
    }
    try {
      const project =
        parsed.data.importKind === "git"
          ? await store.createProject({
              name,
              importKind: "git",
              gitUrl: parsed.data.gitUrl,
              requireExactSlug: true,
              deployAfterImport: parsed.data.deployAfterImport,
              ...(gitCredential ? { gitCredential } : {}),
            })
          : await store.createProject({
              ...parsed.data,
              name,
              requireExactSlug: true,
            });
      return c.json({ project }, 201);
    } catch (error) {
      if (error instanceof ProjectSlugConflictError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
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

  app.get("/projects/:projectId/jobs", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);
    const projectJobs =
      c.req.query("include") === "deployment"
        ? await store.listProjectJobs(projectId, { limit: 50 })
        : await store.listProjectJobs(projectId, { type: "import_source" });
    return c.json({
      jobs: projectJobs.map(toPublicJob),
    });
  });

  app.get("/projects/:projectId/endpoints", async (c) => {
    const routes = await store.listProjectRoutes(c.req.param("projectId"));
    if (routes.length === 0)
      return c.json({ error: "Agent endpoints not found" }, 404);
    return c.json({
      stable: routes.find((route) => route.kind === "project")
        ? publicGatewayUrl(
            routes.find((route) => route.kind === "project")!.hostname,
            options,
          )
        : null,
      previews: routes
        .filter((route) => route.kind === "deployment")
        .map((route) => publicGatewayUrl(route.hostname, options))
        .sort(),
    });
  });

  app.get("/projects/:projectId/deployments", async (c) => {
    const projectId = c.req.param("projectId");
    // Build-derived read model: each release's summary projected from eve's
    // discovery manifest (null for releases built before the projection or
    // whose manifest was unreadable). One project-scoped query, not a lookup
    // per (unbounded, archived-included) deployment.
    const [deployments, retention, routes, releaseSummaries] = await Promise.all([
      store.listDeployments(projectId),
      store.getDeploymentRetention(
        projectId,
        undefined,
        deploymentRetentionOptions(),
      ),
      store.listProjectRoutes(projectId),
      store.listReleaseSummaries(projectId),
    ]);
    return c.json({ deployments, retention, routes, releaseSummaries });
  });

  app.get("/projects/:projectId/variant-metrics", async (c) => {
    // Aggregated in SQL: this used to load every Session the Project had ever
    // recorded and fold them on the request path.
    return c.json({ variants: await store.getVariantMetrics(c.req.param("projectId")) });
  });

  app.post(
    "/projects/:projectId/deployments/:deploymentId/promote",
    async (c) => {
      let route;
      try {
        route = await store.promoteDeployment(
          c.req.param("projectId"),
          c.req.param("deploymentId"),
        );
      } catch (error) {
        if (
          error instanceof ProjectRouteNotFoundError ||
          error instanceof DeploymentNotFoundError
        )
          return c.json({ error: error.message }, 404);
        if (error instanceof DeploymentNotPromotableError)
          return c.json({ error: error.message }, 409);
        throw error;
      }
      await invalidateGatewayAfterCommit(options, [route.hostname]);
      return c.json({ route });
    },
  );

  app.post(
    "/projects/:projectId/deployments/:deploymentId/drain",
    async (c) => {
      const deployment = await store.getDeployment(c.req.param("deploymentId"));
      if (!deployment || deployment.projectId !== c.req.param("projectId"))
        return c.json({ error: "Deployment not found" }, 404);
      const routes = await store.listProjectRoutes(deployment.projectId);
      if (
        routes.some(
          (route) =>
            route.kind !== "deployment" &&
            route.targets.some(
              (target) =>
                target.deploymentId === deployment.id && target.weight > 0,
            ),
        )
      ) {
        return c.json(
          {
            error: "Set this deployment route weight to zero before draining.",
          },
          409,
        );
      }
      const updated = await store.updateDeploymentStatus(
        deployment.id,
        "draining",
      );
      return c.json({ deployment: updated });
    },
  );

  app.post(
    "/projects/:projectId/deployments/:deploymentId/archive",
    async (c) => {
      const projectId = c.req.param("projectId");
      const deploymentId = c.req.param("deploymentId");
      const policy = (
        await store.getDeploymentRetention(
          projectId,
          undefined,
          deploymentRetentionOptions(),
        )
      ).find(
        (entry) => entry.deployment.id === deploymentId,
      );
      if (!policy) return c.json({ error: "Deployment not found" }, 404);
      if (policy.protected)
        return c.json(
          {
            error: "Deployment is protected from archive",
            reasons: policy.reasons,
          },
          409,
        );
      const { job } = await store.enqueueDeploymentArchive(
        projectId,
        deploymentId,
      );
      return c.json({ job: toPublicJob(job) }, 202);
    },
  );

  app.put("/projects/:projectId/routes/:routeId/targets", async (c) => {
    const input = routeTargetsSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!input.success)
      return c.json(
        { error: "Invalid route targets", detail: input.error.flatten() },
        400,
      );
    const routes = await store.listProjectRoutes(c.req.param("projectId"));
    const existing = routes.find(
      (route) => route.id === c.req.param("routeId"),
    );
    if (!existing) return c.json({ error: "Route not found" }, 404);
    if (existing.kind === "deployment")
      return c.json({ error: "Deployment preview routes are immutable" }, 409);
    const route = await store.updateRouteTargets(
      c.req.param("routeId"),
      input.data.targets,
    );
    await invalidateGatewayAfterCommit(options, [route.hostname]);
    return c.json({ route });
  });

  app.post("/projects/:projectId/aliases", async (c) => {
    const input = aliasSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      return c.json(
        { error: "Invalid alias route", detail: input.error.flatten() },
        400,
      );
    const baseDomain = (
      process.env.EVELAND_AGENT_BASE_DOMAINS ?? "agent.localhost"
    )
      .split(",")[0]!
      .trim();
    const route = await store.ensureAliasRoute(
      c.req.param("projectId"),
      input.data.alias,
      baseDomain,
      input.data.targets,
    );
    await invalidateGatewayAfterCommit(options, [route.hostname]);
    return c.json({ route }, 201);
  });

  app.delete("/projects/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    const request = await store.requestProjectDeletion(projectId);
    if (request.outcome === "not_found")
      return c.json({ error: "Project not found" }, 404);
    if (request.outcome === "already_deleting")
      return c.json({ error: "Project is being deleted" }, 409);
    return c.json({ job: toPublicJob(request.job) }, 202);
  });

  app.post("/projects/:projectId/build-deploy", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const deployOptions = buildDeploySchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!deployOptions.success) {
      return c.json(
        {
          error: "Invalid deployment options",
          detail: deployOptions.error.flatten(),
        },
        400,
      );
    }
    const job = await store.enqueueJob(projectId, "build_deploy", {
      promoteAfterDeploy: deployOptions.data.promote,
    });
    return c.json({ job: toPublicJob(job) }, 202);
  });

  app.post("/projects/:projectId/sync-source", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    if (project.importKind !== "git" || !project.gitUrl) {
      return c.json(
        { error: "Only git projects can sync source from a repository." },
        400,
      );
    }

    const syncOptions = syncSourceSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!syncOptions.success) {
      return c.json(
        {
          error: "Invalid source sync options",
          detail: syncOptions.error.flatten(),
        },
        400,
      );
    }
    const host = normalizeGitHttpHost(project.gitUrl);
    const storedCredential = host
      ? await store.getGitCredential(currentUserId(c), host)
      : null;
    const job = await store.enqueueJob(projectId, "import_source", {
      importKind: "git",
      gitUrl: project.gitUrl,
      deployAfterImport: syncOptions.data.deploy,
      promoteAfterDeploy: syncOptions.data.promote,
      ...(storedCredential
        ? {
            gitCredential: {
              userId: storedCredential.userId,
              host: storedCredential.host,
              encryptedToken: storedCredential.encryptedToken,
              persistAfterImport: false,
            },
          }
        : {}),
    });
    return c.json({ job: toPublicJob(job) }, 202);
  });

  app.post("/projects/:projectId/restart", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const job = await store.enqueueJob(projectId, "restart_deployment");
    return c.json({ job: toPublicJob(job) }, 202);
  });
}
