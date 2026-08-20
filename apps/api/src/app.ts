import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AuthPrincipal } from "@evelandhq/core/contracts";
import { createBuildInfoFromEnv } from "@evelandhq/core/server/build-info";
import { assertValidSecretKey } from "@evelandhq/core/server/secrets";
import type { Store } from "@evelandhq/db";
import { proxyGatewayPlayground } from "./gateway-playground.js";
import { registerInternalRoutes } from "./app-internal-routes.js";
import {
  createIdentityRouteServices,
  registerInternalIdentityRoutes,
  registerPublicIdentityRoutes,
  registerSystemIdentityRoutes,
} from "./app-identity-routes.js";
import { registerAgentCatalogRoutes } from "./app-agent-catalog-routes.js";
import { registerProjectRoutes } from "./app-project-routes.js";
import { registerQueryRoutes } from "./app-query-routes.js";
import { registerSecretRoutes } from "./app-secret-routes.js";
import type { AppOptions } from "./app-types.js";
import { registerObservabilityRoutes } from "./app-observability-routes.js";
import { createAgentAuthService } from "./agent-auth-service.js";
import { createEvelandIdentityAgentAuthProvider } from "./agent-auth-eveland-identity.js";
import { registerAgentAuthRoutes } from "./app-agent-auth-routes.js";
import { registerCanonicalPlaygroundRoute } from "./app-canonical-playground-route.js";
import {
  registerAdminOnlyBoundary,
  registerControlPlaneAuthBoundary,
} from "./app-control-plane-auth-boundary.js";
import { registerMemberRoutes } from "./app-member-routes.js";
import { registerSystemDiagnosticsRoutes } from "./app-system-diagnostics-routes.js";
export type { AppOptions } from "./app-types.js";
import { isServiceRequest, positiveDuration } from "./app-support.js";

const devSecretKey = "eveland-dev-secret-key-000000000";
const identityBrowserCorsPaths = new Set([
  "/agent-catalog",
  "/identity/app-tokens",
  "/identity/session",
  "/identity/caller-tokens",
  "/identity/logout",
]);

export function createApp(
  store: Store,
  options: AppOptions = {},
): Hono<{ Variables: { principal: AuthPrincipal } }> {
  const app = new Hono<{ Variables: { principal: AuthPrincipal } }>();
  const buildInfo = options.buildInfo ?? createBuildInfoFromEnv("api", process.env);
  const runtimeActivationLeaseTtlMs = positiveDuration(
    options.runtimeActivationLeaseTtlMs ??
      Number(process.env.EVELAND_ACTIVATION_LEASE_TTL_MS ?? 180_000),
    "runtime activation lease TTL",
  );
  const runtimeActivationWaitTimeoutMs = positiveDuration(
    options.runtimeActivationWaitTimeoutMs ??
      Number(process.env.EVELAND_COLD_START_TIMEOUT_MS ?? 30_000),
    "runtime activation wait timeout",
  );
  const sourcePreflightTtlMs = positiveDuration(
    options.sourcePreflightTtlMs ??
      Number(process.env.EVELAND_SOURCE_PREFLIGHT_TTL_MS ?? 3_600_000),
    "source preflight TTL",
  );
  if (!options.auth && process.env.NODE_ENV !== "test") {
    throw new Error("Platform authentication is required outside tests.");
  }
  const appSecretKey = options.appSecretKey ?? process.env.APP_SECRET_KEY ?? devSecretKey;
  assertValidSecretKey(appSecretKey);
  const playgroundProxy = options.playgroundProxy ?? proxyGatewayPlayground;
  const dataDir = options.dataDir ?? process.env.EVELAND_DATA_DIR ?? ".eveland-data";
  const webOrigin = options.webOrigin ?? process.env.WEB_ORIGIN ?? "http://localhost:3000";
  const identityRouteContext = { app, store, options, appSecretKey, webOrigin };
  const identityRouteServices = createIdentityRouteServices(identityRouteContext);
  const agentAuth = createAgentAuthService({
    store,
    appSecretKey,
    oidcCallbackUrl:
      options.oidcCallbackUrl ?? `${webOrigin.replace(/\/$/, "")}/agent-auth/oidc/callback`,
    agentAuthProviders: [
      createEvelandIdentityAgentAuthProvider({
        mintCallerToken: (request) => identityRouteServices.broker.mintPlatformCallerToken(request),
      }),
      ...(options.agentAuthProviders ?? []),
    ],
    ...(options.oidcProtocol ? { oidcProtocol: options.oidcProtocol } : {}),
    ...(options.oidcVerifyAccessToken
      ? { oidcVerifyAccessToken: options.oidcVerifyAccessToken }
      : {}),
    ...(options.agentAuthNow ? { agentAuthNow: options.agentAuthNow } : {}),
  });
  const enqueueLiveDeploymentRestarts = async (projectId: string) => {
    const deployments = (await store.listDeployments(projectId)).filter(
      (deployment) => deployment.status === "running" || deployment.status === "draining",
    );
    return Promise.all(
      deployments.map((deployment) =>
        store.enqueueJob(projectId, "restart_deployment", {
          deploymentId: deployment.id,
          reason: "secret_changed",
        }),
      ),
    );
  };
  app.use(
    "*",
    cors({
      origin: (origin, c) =>
        origin === webOrigin ||
        (identityRouteServices.allowedOrigins.has(origin) &&
          identityBrowserCorsPaths.has(c.req.path))
          ? origin
          : null,
      credentials: true,
    }),
  );

  // Maintenance-downtime cutover mode: the API serves only the authenticated
  // dispatcher registration/heartbeat/resume surface, exact runtime
  // activation, operation status, and health. Public Sessions, deploys,
  // schedule mutations and every ordinary control-plane write are refused with
  // a stable managed error — this process is not a degraded normal API, it is
  // a different one.
  const cutoverOperationId =
    options.cutoverOperationId ??
    (process.env.EVELAND_PROCESS_MODE === "workflow-cutover"
      ? process.env.EVELAND_WORKFLOW_CUTOVER_OPERATION_ID
      : undefined);
  if (process.env.EVELAND_PROCESS_MODE === "workflow-cutover" && !cutoverOperationId) {
    throw new Error(
      "EVELAND_PROCESS_MODE=workflow-cutover requires EVELAND_WORKFLOW_CUTOVER_OPERATION_ID; a cutover API must know which operation it serves.",
    );
  }
  if (cutoverOperationId) {
    const allowedCutoverPaths = [
      /^\/health$/,
      /^\/internal\/workflow\/dispatcher\//,
      /^\/internal\/workflow\/cutover\//,
      /^\/internal\/runtime\/activations/,
    ];
    app.use("*", async (c, next) => {
      if (allowedCutoverPaths.some((pattern) => pattern.test(c.req.path))) return next();
      return c.json(
        {
          error: `workflow_unavailable: the platform is in a workflow maintenance window (operation ${cutoverOperationId}).`,
        },
        503,
      );
    });
    app.get("/internal/workflow/cutover/status", async (c) => {
      const serviceToken = options.gatewayServiceToken ?? process.env.EVELAND_GATEWAY_SERVICE_TOKEN;
      if (!isServiceRequest(c.req.header("authorization"), serviceToken))
        return c.json({ error: "Not found" }, 404);
      const operation = await store.getWorkflowCutoverOperation(cutoverOperationId);
      return c.json({ operation });
    });
  }

  registerInternalRoutes({
    app,
    store,
    options,
    buildInfo,
    runtimeActivationLeaseTtlMs,
    runtimeActivationWaitTimeoutMs,
    appSecretKey,
  });
  // Before the control-plane auth boundary: the Gateway authenticates with the
  // service token, not a member session.
  registerInternalIdentityRoutes(identityRouteContext, identityRouteServices);
  registerPublicIdentityRoutes(identityRouteContext, identityRouteServices);
  registerAgentCatalogRoutes({
    app,
    store,
    options,
  });

  if (options.auth) {
    registerControlPlaneAuthBoundary({ app, auth: options.auth });
    registerAdminOnlyBoundary(app);
    registerSystemIdentityRoutes(identityRouteContext, identityRouteServices);
    registerMemberRoutes({ app, auth: options.auth, webOrigin });
    registerSystemDiagnosticsRoutes({
      app,
      store,
      configurationDiagnostics: options.configurationDiagnostics,
      gatewayHealth: options.gatewayHealth,
    });
  }

  registerAgentAuthRoutes({ app, store, agentAuth });

  registerProjectRoutes({ app, store, options, dataDir, appSecretKey, sourcePreflightTtlMs });

  registerCanonicalPlaygroundRoute({
    app,
    store,
    agentAuth,
    playgroundProxy,
  });

  registerSecretRoutes({
    app,
    store,
    appSecretKey,
    enqueueLiveDeploymentRestarts,
  });
  registerObservabilityRoutes({ app, store, options, appSecretKey });
  registerQueryRoutes(app, store);

  return app;
}
