import { toPublicJob } from "@eveland/core/jobs";
import {
  DEFAULT_API_SESSION_IDLE_TTL_MS,
  DEFAULT_PLAYGROUND_SESSION_IDLE_TTL_MS,
} from "@eveland/core/routing";
import { DeploymentNotFoundError, DeploymentNotPromotableError, ProjectRouteNotFoundError, type Store } from "@eveland/db";
import { publicDeployment } from "./app-public-projections.js";
import type { ApiApp, AppOptions } from "./app-types.js";
import { aliasSchema, routeTargetsSchema } from "./app-schemas.js";
import { invalidateGatewayAfterCommit, publicGatewayUrl } from "./app-support.js";

// The narrow persistence and configuration ports this slice actually needs.
export type ProjectDeploymentStore = Pick<
  Store,
  | "enqueueDeploymentArchive"
  | "ensureAliasRoute"
  | "getDeployment"
  | "getDeploymentRetention"
  | "getVariantMetrics"
  | "listDeployments"
  | "listProjectRoutes"
  | "listReleaseSummaries"
  | "promoteDeployment"
  | "updateDeploymentStatus"
  | "updateRouteTargets"
>;

export type ProjectDeploymentOptions = Pick<
  AppOptions,
  | "sessionBindingNow"
  | "playgroundSessionIdleTtlMs"
  | "apiSessionIdleTtlMs"
  | "gatewayPublicScheme"
  | "gatewayPublicPort"
  | "invalidateGatewayRoutes"
>;

export function registerProjectDeploymentRoutes(input: {
  app: ApiApp;
  store: ProjectDeploymentStore;
  options: ProjectDeploymentOptions;
}): void {
  const { app, store, options } = input;
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
        .filter(
          (route) =>
            route.kind === "deployment" &&
            route.enabled &&
            route.targets.some((target) => target.status !== "archived"),
        )
        .sort((a, b) =>
          a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
        )
        .map((route) => publicGatewayUrl(route.hostname, options)),
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
    return c.json({
      deployments: deployments.map(publicDeployment),
      retention: retention.map((entry) => ({
        ...entry,
        deployment: publicDeployment(entry.deployment),
      })),
      routes,
      releaseSummaries,
    });
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
      return c.json({
        deployment: updated ? publicDeployment(updated) : null,
      });
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

}
