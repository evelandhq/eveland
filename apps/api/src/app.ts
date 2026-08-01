import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AuthPrincipal } from "@eveland/core/contracts";
import { createBuildInfoFromEnv } from "@eveland/core/server/build-info";
import { assertValidSecretKey } from "@eveland/core/server/secrets";
import type { Store } from "@eveland/db";
import {
  proxyGatewayPlayground,
  runGatewayPlayground,
} from "./gateway-playground.js";
import { registerLegacyPlaygroundRoute } from "./app-legacy-playground-route.js";
import { registerInternalRoutes } from "./app-internal-routes.js";
import {
  createIdentityRouteServices,
  registerPublicIdentityRoutes,
  registerSystemIdentityRoutes,
} from "./app-identity-routes.js";
import { registerAgentCatalogRoutes } from "./app-agent-catalog-routes.js";
import { registerProjectRoutes } from "./app-project-routes.js";
import { registerQueryRoutes } from "./app-query-routes.js";
import { registerSecretRoutes } from "./app-secret-routes.js";
import type { AppOptions } from "./app-types.js";
import { collectInstanceHealth, probeGatewayHealth } from "./instance-health.js";
import { registerObservabilityRoutes } from "./app-observability-routes.js";
import { createAgentAuthService } from "./agent-auth-service.js";
import { registerAgentAuthRoutes } from "./app-agent-auth-routes.js";
import { registerCanonicalPlaygroundRoute } from "./app-canonical-playground-route.js";
export type { AppOptions } from "./app-types.js";
import {
  authErrorResponse,
  getSetCookies,
  positiveDuration,
  publicInvitation,
} from "./app-support.js";
import {
  acceptInvitationSchema,
  invitationSchema,
  memberRoleSchema,
  passwordChangeSchema,
  profileSchema,
} from "./app-schemas.js";

const devSecretKey = "eveland-dev-secret-key-000000000";
const identityBrowserCorsPaths = new Set([
  "/agent-catalog",
  "/identity/app-tokens",
  "/identity/session",
  "/identity/caller-tokens",
  "/identity/logout",
]);

export function createApp(store: Store, options: AppOptions = {}): Hono<{ Variables: { principal: AuthPrincipal } }> {
  const app = new Hono<{ Variables: { principal: AuthPrincipal } }>();
  const buildInfo = options.buildInfo ?? createBuildInfoFromEnv("api", process.env);
  const runtimeActivationLeaseTtlMs = positiveDuration(
    options.runtimeActivationLeaseTtlMs ?? Number(process.env.EVELAND_ACTIVATION_LEASE_TTL_MS ?? 180_000),
    "runtime activation lease TTL",
  );
  const runtimeActivationWaitTimeoutMs = positiveDuration(
    options.runtimeActivationWaitTimeoutMs ?? Number(process.env.EVELAND_COLD_START_TIMEOUT_MS ?? 30_000),
    "runtime activation wait timeout",
  );
  const sourcePreflightTtlMs = positiveDuration(
    options.sourcePreflightTtlMs ?? Number(process.env.EVELAND_SOURCE_PREFLIGHT_TTL_MS ?? 3_600_000),
    "source preflight TTL",
  );
  if (!options.auth && process.env.NODE_ENV !== "test") {
    throw new Error("Control-plane authentication is required outside tests.");
  }
  const appSecretKey = options.appSecretKey ?? process.env.APP_SECRET_KEY ?? devSecretKey;
  assertValidSecretKey(appSecretKey);
  const playgroundRunner = options.playgroundRunner ?? runGatewayPlayground;
  const playgroundProxy = options.playgroundProxy ?? proxyGatewayPlayground;
  const dataDir = options.dataDir ?? process.env.EVELAND_DATA_DIR ?? ".eveland-data";
  const webOrigin = options.webOrigin ?? process.env.WEB_ORIGIN ?? "http://localhost:3000";
  const identityRouteContext = { app, store, options, appSecretKey, webOrigin };
  const identityRouteServices = createIdentityRouteServices(identityRouteContext);
  const agentAuth = createAgentAuthService({
    store,
    appSecretKey,
    oidcCallbackUrl:
      options.oidcCallbackUrl ??
      `${webOrigin.replace(/\/$/, "")}/agent-auth/oidc/callback`,
    ...(options.agentAuthProviders
      ? { agentAuthProviders: options.agentAuthProviders }
      : {}),
    ...(options.oidcProtocol
      ? { oidcProtocol: options.oidcProtocol }
      : {}),
    ...(options.oidcVerifyAccessToken
      ? { oidcVerifyAccessToken: options.oidcVerifyAccessToken }
      : {}),
    ...(options.agentAuthNow
      ? { agentAuthNow: options.agentAuthNow }
      : {}),
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


  registerInternalRoutes({
    app,
    store,
    options,
    buildInfo,
    runtimeActivationLeaseTtlMs,
    runtimeActivationWaitTimeoutMs,
    appSecretKey,
  });
  registerPublicIdentityRoutes(identityRouteContext, identityRouteServices);
  registerAgentCatalogRoutes({
    app,
    store,
    options,
  });

  if (options.auth) {
    // Allowlist, not denylist: every Better Auth endpoint outside this set is
    // unroutable. A denylist silently widened the public surface on every
    // Better Auth upgrade, and left concrete gaps -- e.g. the raw
    // /change-password endpoint lets the CLIENT decide whether other sessions
    // are revoked, while Eveland's own /profile/password wrapper forces
    // revocation. Everything else (invitations, membership, roles, password
    // change) goes through Eveland-owned endpoints that call the Better Auth
    // server API directly.
    const allowedAuthPaths = new Set([
      "/api/auth/sign-in/email",
      "/api/auth/sign-out",
      "/api/auth/get-session",
    ]);
    app.on(["GET", "POST"], "/api/auth/*", (c) => {
      const path = new URL(c.req.url).pathname;
      if (!allowedAuthPaths.has(path)) return c.notFound();
      return options.auth!.handler(c.req.raw);
    });

    app.post("/invitations/accept", async (c) => {
      const parsed = acceptInvitationSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "Invalid invitation acceptance", issues: parsed.error.issues }, 400);
      try {
        const session = await options.auth!.acceptInvitation(parsed.data);
        for (const cookie of getSetCookies(session.headers)) c.header("set-cookie", cookie, { append: true });
        return c.json({ member: session.principal });
      } catch (error) {
        return authErrorResponse(c, error);
      }
    });

    app.use("*", async (c, next) => {
      const principal = await options.auth!.authenticate(c.req.raw);
      if (!principal) return c.json({ error: "Authentication required" }, 401);
      c.set("principal", principal);
      await next();
    });
    registerSystemIdentityRoutes(identityRouteContext);

    app.get("/auth/session", (c) => c.json({ member: c.get("principal") }));

    app.get("/system/configuration", async (c) => {
      if (c.get("principal").role !== "admin") return c.json({ error: "Admin access required" }, 403);
      if (!options.configurationDiagnostics) return c.json({ error: "Configuration diagnostics unavailable" }, 503);
      try {
        return c.json(await options.configurationDiagnostics());
      } catch {
        return c.json({ error: "Configuration diagnostics unavailable" }, 503);
      }
    });

    app.get("/system/health", async (c) => {
      if (c.get("principal").role !== "admin") return c.json({ error: "Admin access required" }, 403);
      const requestedHours = Number(c.req.query("hours") ?? 24);
      const historyHours = Number.isFinite(requestedHours)
        ? Math.max(1, Math.min(168, Math.round(requestedHours)))
        : 24;
      try {
        return c.json(await collectInstanceHealth(store, {
          historyHours,
          gatewayHealth: options.gatewayHealth ?? (() => probeGatewayHealth(process.env)),
        }));
      } catch {
        return c.json({ error: "Instance health diagnostics unavailable" }, 503);
      }
    });

    app.patch("/profile", async (c) => {
      const parsed = profileSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "Invalid profile", issues: parsed.error.issues }, 400);
      try {
        const updated = await options.auth!.updateProfile(c.req.raw, parsed.data);
        for (const cookie of getSetCookies(updated.headers)) c.header("set-cookie", cookie, { append: true });
        return c.json({ member: updated.principal });
      } catch (error) {
        return authErrorResponse(c, error);
      }
    });

    app.post("/profile/password", async (c) => {
      const parsed = passwordChangeSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "Invalid password change", issues: parsed.error.issues }, 400);
      try {
        const headers = await options.auth!.changePassword(c.req.raw, parsed.data);
        for (const cookie of getSetCookies(headers)) c.header("set-cookie", cookie, { append: true });
        return c.body(null, 204);
      } catch (error) {
        return authErrorResponse(c, error);
      }
    });

    app.get("/members", async (c) => c.json({ members: await options.auth!.listMembers(c.req.raw) }));

    app.get("/invitations", async (c) => {
      try {
        const invitations = await options.auth!.listInvitations(c.req.raw);
        return c.json({ invitations: invitations.map(publicInvitation) });
      } catch (error) {
        return authErrorResponse(c, error);
      }
    });

    app.post("/invitations", async (c) => {
      const parsed = invitationSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "Invalid invitation input", issues: parsed.error.issues }, 400);
      try {
        const issued = await options.auth!.invite(c.req.raw, parsed.data.email);
        return c.json(
          {
            invitation: publicInvitation(issued.invitation),
            inviteUrl: `${webOrigin}/accept-invite?token=${encodeURIComponent(issued.token)}`,
          },
          201,
        );
      } catch (error) {
        return authErrorResponse(c, error);
      }
    });

    app.post("/invitations/:invitationId/resend", async (c) => {
      try {
        const issued = await options.auth!.reissueInvitation(c.req.raw, c.req.param("invitationId"));
        return c.json({
          invitation: publicInvitation(issued.invitation),
          inviteUrl: `${webOrigin}/accept-invite?token=${encodeURIComponent(issued.token)}`,
        });
      } catch (error) {
        return authErrorResponse(c, error);
      }
    });

    app.delete("/invitations/:invitationId", async (c) => {
      try {
        const revoked = await options.auth!.revokeInvitation(c.req.raw, c.req.param("invitationId"));
        return revoked ? c.body(null, 204) : c.json({ error: "Invitation not found" }, 404);
      } catch (error) {
        return authErrorResponse(c, error);
      }
    });

    app.patch("/members/:userId", async (c) => {
      const parsed = memberRoleSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "Invalid member role" }, 400);
      try {
        const member = await options.auth!.updateMemberRole(c.req.raw, c.req.param("userId"), parsed.data.role);
        return c.json({ member });
      } catch (error) {
        return authErrorResponse(c, error);
      }
    });

    app.delete("/members/:userId", async (c) => {
      try {
        const removed = await options.auth!.removeMember(c.req.raw, c.req.param("userId"));
        return removed ? c.body(null, 204) : c.json({ error: "Member not found" }, 404);
      } catch (error) {
        return authErrorResponse(c, error);
      }
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

  registerLegacyPlaygroundRoute({ app, store, playgroundRunner });


  registerSecretRoutes({
    app,
    store,
    options,
    appSecretKey,
    enqueueLiveDeploymentRestarts,
  });
  registerObservabilityRoutes({ app, store, options, appSecretKey });
  registerQueryRoutes(app, store);

  return app;
}
