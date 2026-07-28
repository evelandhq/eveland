import { Hono } from "hono";
import { cors } from "hono/cors";
import { encodeAgentAuthEnvelope, type AgentAuthSecretReference } from "@eveland/core/agent-auth";
import {
  agentAuthConfigsEqual,
  createAgentAuthRegistry,
  type AgentCredentialContext,
  type AgentAuthProviderRegistration,
} from "@eveland/agent-auth";
import { openAgentAuthConfig, sealAgentAuthConfig } from "@eveland/agent-auth/sealed-config";
import {
  createOidcAgentAuthProvider,
} from "@eveland/agent-auth/oidc";
import type { AuthPrincipal } from "@eveland/core/contracts";
import {
  getEveString,
  isEveRecord,
  PLAYGROUND_MAX_TRANSPORT_BYTES,
  validatePlaygroundTurn,
} from "@eveland/core/eve";
import {
  unsupportedEveVersionMessage,
} from "@eveland/core/source";
import { createBuildInfoFromEnv } from "@eveland/core/server/build-info";
import {
  assertValidSecretKey,
  decryptSecretValue,
  type EncryptedSecret,
} from "@eveland/core/server/secrets";
import { createId } from "@eveland/core/ids";
import type { Store } from "@eveland/db";
import {
  proxyGatewayPlayground,
  runGatewayPlayground,
  type PlaygroundRunEvent,
} from "./gateway-playground.js";
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
export type { AppOptions } from "./app-types.js";
import {
  agentAuthFailureStatus,
  authErrorResponse,
  currentUserId,
  getSetCookies,
  monitorPlaygroundStream,
  parsePlaygroundBody,
  parsePlaygroundResponse,
  playgroundSessionIdFromPath,
  positiveDuration,
  publicInvitation,
  readLimitedPlaygroundBody,
  resolveProjectEveVersion,
} from "./app-support.js";
import {
  acceptInvitationSchema,
  agentAuthCallbackSchema,
  invitationSchema,
  memberRoleSchema,
  passwordChangeSchema,
  playgroundMessageSchema,
  profileSchema,
  updateAgentConnectionSchema,
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
  const ensureProjectAgentConnection = async (projectId: string) => {
    const existing = await store.getProjectAgentConnection(projectId);
    if (existing) return existing;
    const id = createId("acon");
    return store.createAgentConnection({
      id,
      target: { kind: "managed-project", projectId },
      method: "local-dev",
      configEncrypted: sealAgentAuthConfig({}, appSecretKey, {
        agentConnectionId: id,
        method: "local-dev",
        securityRevision: 1,
      }),
    });
  };
  const readConnectionConfig = (connection: Awaited<ReturnType<typeof ensureProjectAgentConnection>>): unknown =>
    openAgentAuthConfig(connection.configEncrypted, appSecretKey, {
      agentConnectionId: connection.id,
      method: connection.method,
      securityRevision: connection.securityRevision,
    });
  const resolveAgentAuthSecret = async (
    projectId: string,
    reference: AgentAuthSecretReference,
  ): Promise<string> => {
    const encryptedValue = (await store.listSecretRecords(projectId))
      .find((secret) => secret.key === reference.key)?.encryptedValue;
    if (!encryptedValue) throw new Error("The configured Agent Auth secret reference is unavailable.");
    try {
      return decryptSecretValue(JSON.parse(encryptedValue) as EncryptedSecret, appSecretKey);
    } catch {
      throw new Error("The configured Agent Auth secret reference cannot be decrypted.");
    }
  };
  const oidcRegistration = createOidcAgentAuthProvider({
    store,
    appSecretKey,
    callbackUrl: options.oidcCallbackUrl ?? `${webOrigin.replace(/\/$/, "")}/agent-auth/oidc/callback`,
    resolveClientSecret: async (config, connection) => {
      if (!config.clientSecretRef) return undefined;
      return resolveAgentAuthSecret(connection.target.projectId, config.clientSecretRef);
    },
    ...(options.oidcProtocol ? { protocol: options.oidcProtocol } : {}),
    ...(options.oidcVerifyAccessToken ? { verifyAccessToken: options.oidcVerifyAccessToken } : {}),
    ...(options.agentAuthNow ? { now: options.agentAuthNow } : {}),
    getConnection: async (connectionId) => {
      const connection = await store.getAgentConnection(connectionId);
      return connection ? { ...connection, config: readConnectionConfig(connection) } : null;
    },
  });
  const agentAuthRegistry = createAgentAuthRegistry([oidcRegistration, ...(options.agentAuthProviders ?? [])]);
  const credentialContext = (
    connection: Awaited<ReturnType<typeof ensureProjectAgentConnection>>,
    callerPrincipalId: string,
    returnPath?: string,
  ): AgentCredentialContext => ({
    connection: { ...connection, config: readConnectionConfig(connection) },
    callerPrincipalId,
    ...(returnPath ? { returnPath } : {}),
    resolveSecret: (reference) => resolveAgentAuthSecret(connection.target.projectId, reference),
  });
  const publicConnection = async (
    connection: Awaited<ReturnType<typeof ensureProjectAgentConnection>>,
    callerPrincipalId?: string,
  ) => {
    const provider = agentAuthRegistry.get(connection.method);
    if (!provider) {
      return {
        connection: { ...connection, configEncrypted: undefined, config: {} },
        status: { state: "misconfigured" as const, message: `Unsupported Agent Auth Method: ${connection.method}.` },
      };
    }
    try {
      const context = credentialContext(
        connection,
        callerPrincipalId ?? "",
        `/projects/${connection.target.projectId}/playground`,
      );
      const config = context.connection.config;
      const { configEncrypted: _configEncrypted, ...safe } = connection;
      if (provider.descriptor.interactive && callerPrincipalId) {
        const resolved = await provider.getCredential(context);
        return {
          connection: { ...safe, config: provider.redactConfig(config) },
          status: "failure" in resolved
            ? resolved.failure.code === "interaction_required"
              ? {
                  state: "interaction_required" as const,
                  ...(resolved.failure.interaction ? { interaction: resolved.failure.interaction } : {}),
                }
              : { state: "misconfigured" as const, message: resolved.failure.message }
            : { state: "credential_available" as const },
        };
      }
      return {
        connection: { ...safe, config: provider.redactConfig(config) },
        status: {
          state: provider.descriptor.interactive
            ? "interaction_required" as const
            : provider.method === "local-dev" || provider.method === "none"
              ? "not_required" as const
              : "credential_available" as const,
        },
      };
    } catch {
      const { configEncrypted: _configEncrypted, ...safe } = connection;
      return {
        connection: { ...safe, config: provider.redactConfig({}) },
        status: { state: "misconfigured" as const, message: "The stored Agent Auth configuration cannot be decrypted." },
      };
    }
  };
  const resolveProjectAgentAuthCredential = async (projectId: string, callerPrincipalId: string) => {
    const connection = await ensureProjectAgentConnection(projectId);
    const provider = agentAuthRegistry.get(connection.method);
    if (!provider) throw new Error(`Unsupported Agent Auth Method: ${connection.method}.`);
    const context = credentialContext(connection, callerPrincipalId, `/projects/${projectId}/playground`);
    return { connection, provider, context, resolution: await provider.getCredential(context) };
  };
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
    app.on(["GET", "POST"], "/api/auth/*", (c) => {
      const path = new URL(c.req.url).pathname;
      if (
        path.startsWith("/api/auth/sign-up/") ||
        path.startsWith("/api/auth/admin/") ||
        path.startsWith("/api/auth/organization/") ||
        path === "/api/auth/update-user"
      ) {
        return c.notFound();
      }
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

  app.get("/agent-auth/methods", (c) => c.json({ methods: agentAuthRegistry.listDescriptors() }));

  app.get("/agent-connections/:connectionId/auth/interactions/:method/start", async (c) => {
    c.header("cache-control", "no-store");
    const connection = await store.getAgentConnection(c.req.param("connectionId"));
    const provider = agentAuthRegistry.get(c.req.param("method"));
    if (!connection || !provider || connection.method !== provider.method || !provider.interaction) {
      return c.json({ error: "Agent Auth interaction not found" }, 404);
    }
    const returnPath = c.req.query("returnPath");
    if (!returnPath) return c.json({ error: "Agent Auth return path is required" }, 400);
    try {
      const interaction = await provider.interaction.start(
        credentialContext(connection, currentUserId(c), returnPath) as AgentCredentialContext & { returnPath: string },
      );
      return c.redirect(interaction.authorizationUrl, 302);
    } catch (error) {
      return c.json({
        error: "Agent authorization could not be started",
        detail: error instanceof Error ? error.message : "Invalid Agent Auth configuration.",
      }, 400);
    }
  });

  app.post("/agent-auth/callback/:method", async (c) => {
    c.header("cache-control", "no-store");
    const parsed = agentAuthCallbackSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid Agent Auth callback" }, 400);
    const provider = agentAuthRegistry.get(c.req.param("method"));
    if (!provider?.interaction) return c.json({ error: "Agent Auth interaction not found" }, 404);
    try {
      return c.json(await provider.interaction.callback({
        search: parsed.data.search,
        callerPrincipalId: currentUserId(c),
      }));
    } catch (error) {
      return c.json({ error: "Agent authorization could not be completed" }, 400);
    }
  });

  app.get("/projects/:projectId/agent-auth/secret-references", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);
    const references = (await store.listSecrets(projectId))
      .filter((secret) => secret.kind === "secret")
      .map((secret) => ({
        kind: "project-secret" as const,
        key: secret.key,
        label: `Project Secret · ${secret.key}`,
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
    return c.json({ references });
  });

  app.get("/projects/:projectId/playground/connection", async (c) => {
    const project = await store.getProject(c.req.param("projectId"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    return c.json(await publicConnection(await ensureProjectAgentConnection(project.id), currentUserId(c)));
  });

  app.put("/agent-connections/:connectionId", async (c) => {
    const parsed = updateAgentConnectionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid Agent Connection", issues: parsed.error.issues }, 400);
    const connection = await store.getAgentConnection(c.req.param("connectionId"));
    if (!connection) return c.json({ error: "Agent Connection not found" }, 404);
    if (connection.securityRevision !== parsed.data.expectedSecurityRevision) {
      return c.json({ error: "Agent Connection was updated by another request" }, 409);
    }
    const provider = agentAuthRegistry.get(parsed.data.method);
    if (!provider) return c.json({ error: `Unsupported Agent Auth Method: ${parsed.data.method}.` }, 422);
    let previous: unknown;
    if (connection.method === parsed.data.method) {
      try {
        previous = readConnectionConfig(connection);
      } catch {
        previous = undefined;
      }
    }
    let normalized: unknown;
    try {
      normalized = provider.normalizeConfig(parsed.data.config, previous);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid Agent Auth configuration." }, 422);
    }
    const securityChanged = connection.method !== parsed.data.method || !agentAuthConfigsEqual(previous, normalized);
    const securityRevision = connection.securityRevision + (securityChanged ? 1 : 0);
    if (provider.preflight && securityChanged) {
      try {
        await provider.preflight({
          connection: {
            ...connection,
            method: parsed.data.method,
            securityRevision,
            config: normalized,
          },
          callerPrincipalId: currentUserId(c),
          resolveSecret: (reference) => resolveAgentAuthSecret(connection.target.projectId, reference),
        });
      } catch (error) {
        return c.json({
          error: "Agent Auth provider preflight failed",
          detail: error instanceof Error ? error.message : "Invalid Agent Auth provider configuration.",
        }, 422);
      }
    }
    const updated = await store.updateAgentConnection({
      id: connection.id,
      expectedSecurityRevision: connection.securityRevision,
      method: parsed.data.method,
      configEncrypted: sealAgentAuthConfig(normalized, appSecretKey, {
        agentConnectionId: connection.id,
        method: parsed.data.method,
        securityRevision,
      }),
      securityChanged,
    });
    if (!updated) return c.json({ error: "Agent Connection was updated by another request" }, 409);
    if (securityChanged) await store.deleteStaleAgentAuthCredentials(updated.id, updated.securityRevision);
    return c.json(await publicConnection(updated, currentUserId(c)));
  });


  registerProjectRoutes({ app, store, options, dataDir, appSecretKey, sourcePreflightTtlMs });

  app.all("/projects/:projectId/playground/eve/*", async (c) => {
    const projectId = c.req.param("projectId");
    const requestUrl = new URL(c.req.url);
    const playgroundMarker = "/playground";
    const markerIndex = requestUrl.pathname.indexOf(playgroundMarker);
    const evePath = markerIndex >= 0 ? requestUrl.pathname.slice(markerIndex + playgroundMarker.length) : "";
    const isReset = c.req.method === "POST" && evePath === "/eve/v1/session/reset";
    const pathSessionId = playgroundSessionIdFromPath(evePath);
    const isInitial = c.req.method === "POST" && evePath === "/eve/v1/session";
    const isContinuation = !isReset && c.req.method === "POST" && /^\/eve\/v1\/session\/[^/]+$/.test(evePath);
    const isCancel = c.req.method === "POST" && /^\/eve\/v1\/session\/[^/]+\/cancel$/.test(evePath);
    const isStream = c.req.method === "GET" && /^\/eve\/v1\/session\/[^/]+\/stream$/.test(evePath);
    if (!isInitial && !isContinuation && !isCancel && !isStream && !isReset) {
      return c.json({ error: "Playground route not found" }, 404);
    }

    const project = await store.getProject(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);
    let agentAuthEnvelope: string;
    let activeProvider: AgentAuthProviderRegistration;
    let activeContext: AgentCredentialContext;
    let credentialVersion: unknown;
    try {
      const resolved = await resolveProjectAgentAuthCredential(projectId, currentUserId(c));
      if ("failure" in resolved.resolution) {
        return c.json(resolved.resolution.failure, agentAuthFailureStatus(resolved.resolution.failure));
      }
      activeProvider = resolved.provider;
      activeContext = resolved.context;
      credentialVersion = resolved.resolution.version;
      agentAuthEnvelope = encodeAgentAuthEnvelope(resolved.resolution.envelope);
    } catch (error) {
      return c.json({
        error: "Agent Connection is not ready",
        detail: error instanceof Error ? error.message : "Invalid Agent Auth configuration.",
      }, 409);
    }
    let body: Uint8Array | null = null;
    let resetContinuationToken: string | null = null;
    if (isInitial || isContinuation || isCancel || isReset) {
      try {
        body = await readLimitedPlaygroundBody(c.req.raw, PLAYGROUND_MAX_TRANSPORT_BYTES);
        if (isReset) {
          const resetBody = parsePlaygroundBody(body);
          resetContinuationToken = isEveRecord(resetBody)
            ? getEveString(resetBody, "continuationToken")
            : null;
          if (!resetContinuationToken) {
            throw new Error("Playground reset requires a continuationToken.");
          }
        } else if (!isCancel) {
          validatePlaygroundTurn(parsePlaygroundBody(body));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid Playground request";
        const status = message === "Playground request body is too large." ? 413 : 400;
        return c.json({ error: message }, status);
      }
    }

    const resetBinding = resetContinuationToken
      ? await store.findSessionBindingByContinuationToken(projectId, resetContinuationToken)
      : null;
    let platformSession = pathSessionId
      ? await store.getSessionByEveSessionId(projectId, pathSessionId)
      : resetBinding
        ? await store.getSessionByEveSessionId(projectId, resetBinding.eveSessionId)
        : null;
    if (pathSessionId && !platformSession) return c.json({ error: "Playground session not found" }, 404);
    const eveVersion = platformSession?.deploymentId
      ? await resolveProjectEveVersion(store, projectId, platformSession.deploymentId)
      : null;
    if (eveVersion && !eveVersion.supported) {
      return c.json({
        error: "Unsupported Eve version",
        detail: unsupportedEveVersionMessage(eveVersion.version),
        eveVersion,
      }, 409);
    }

    if (isInitial) {
      platformSession = await store.createSession({ projectId, deploymentId: null, trigger: "playground" });
    }

    let upstream: Response;
    try {
      const proxy = (envelope: string) => playgroundProxy({
        projectId,
        path: `${evePath}${requestUrl.search}`,
        method: c.req.method,
        headers: c.req.raw.headers,
        body,
        signal: c.req.raw.signal,
        agentAuthEnvelope: envelope,
      });
      upstream = await proxy(agentAuthEnvelope);
      if (upstream.status === 401 && activeProvider.recoverUnauthorized && credentialVersion !== undefined) {
        await upstream.body?.cancel().catch(() => undefined);
        const recovery = await activeProvider.recoverUnauthorized({
          ...activeContext,
          rejectedVersion: credentialVersion,
          attempt: 0,
        });
        if (recovery.action === "give_up") return c.json(recovery.failure, agentAuthFailureStatus(recovery.failure));
        const currentConnection = await store.getAgentConnection(activeContext.connection.id);
        if (!currentConnection || currentConnection.method !== activeProvider.method) {
          return c.json({ error: "Agent Connection changed; retry the request." }, 409);
        }
        const retryContext = credentialContext(currentConnection, currentUserId(c), `/projects/${projectId}/playground`);
        const retryCredential = await activeProvider.getCredential(retryContext);
        if ("failure" in retryCredential) return c.json(retryCredential.failure, agentAuthFailureStatus(retryCredential.failure));
        upstream = await proxy(encodeAgentAuthEnvelope(retryCredential.envelope));
        if (upstream.status === 401) {
          await upstream.body?.cancel().catch(() => undefined);
          const terminal = await activeProvider.recoverUnauthorized({
            ...retryContext,
            rejectedVersion: retryCredential.version,
            attempt: 1,
          });
          const failure = terminal.action === "give_up"
            ? terminal.failure
            : {
                code: "retry_required" as const,
                method: activeProvider.method,
                message: "The Agent credential was rejected twice; retry the request.",
              };
          return c.json(failure, agentAuthFailureStatus(failure));
        }
      }
    } catch (error) {
      if (platformSession && (isInitial || isContinuation)) {
        await store.completeSession(platformSession.id, { status: "failed", eveSessionId: pathSessionId });
      }
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "Playground request failed", detail: message }, 502);
    }

    if (!upstream.ok && platformSession && (isInitial || isContinuation)) {
      await store.completeSession(platformSession.id, { status: "failed", eveSessionId: pathSessionId });
    }

    if ((isInitial || isContinuation) && upstream.ok && platformSession) {
      const parsed = await parsePlaygroundResponse(upstream.clone());
      const eveSessionId = upstream.headers.get("x-eve-session-id") ?? getEveString(parsed, "sessionId") ?? pathSessionId;
      await store.completeSession(platformSession.id, {
        status: "running",
        eveSessionId,
        continuationToken: getEveString(parsed, "continuationToken"),
      });
    }
    if (isReset && upstream.ok && platformSession) {
      const parsed = await parsePlaygroundResponse(upstream.clone());
      if (
        getEveString(parsed, "status") === "reset" &&
        getEveString(parsed, "previousSessionId") === platformSession.eveSessionId
      ) {
        await store.completeSession(platformSession.id, {
          status: "completed",
          eveSessionId: platformSession.eveSessionId,
          continuationToken: null,
        });
      }
    }

    const responseBody = isStream && upstream.ok && upstream.body && platformSession && pathSessionId
      ? monitorPlaygroundStream(upstream.body, store, platformSession.id, pathSessionId)
      : upstream.body;
    return new Response(responseBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  });

  app.post("/projects/:projectId/playground", async (c) => {
    const projectId = c.req.param("projectId");
    const parsed = playgroundMessageSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid playground message", issues: parsed.error.issues }, 400);
    }

    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const deployment = await store.getCurrentDeployment(projectId);
    if (!deployment || (deployment.status !== "running" && deployment.status !== "stopped")) {
      return c.json({ error: "No running deployment" }, 409);
    }
    const eveVersion = await resolveProjectEveVersion(store, projectId, deployment.id);
    if (!eveVersion.supported) {
      return c.json({
        error: "Unsupported Eve version",
        detail: unsupportedEveVersionMessage(eveVersion.version),
        eveVersion,
      }, 409);
    }

    const session = await store.createSession({
      projectId,
      deploymentId: deployment.id,
      trigger: "playground",
      scheduleId: null,
    });
    await store.appendSessionEvent(session.id, "message", { role: "user", content: parsed.data.message });

    try {
      let eventPersistence = Promise.resolve();
      const persistEvent = (event: PlaygroundRunEvent) => {
        const queued = eventPersistence.then(async () => {
          await store.appendSessionEvent(session.id, event.type, event.payload);
        });
        eventPersistence = queued.catch(() => undefined);
        return queued;
      };
      const result = await playgroundRunner({ project, deployment, message: parsed.data.message, onEvent: persistEvent });
      for (const event of result.events ?? [{ type: "model_response", payload: { content: result.response } }]) {
        await persistEvent(event);
      }
      const completed = await store.completeSession(session.id, {
        status: result.status ?? "waiting",
        eveSessionId: result.eveSessionId ?? null,
        continuationToken: result.continuationToken ?? null,
      });
      return c.json({ session: completed, events: await store.listSessionEvents(session.id) }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.appendSessionEvent(session.id, "error", { message });
      const failed = await store.completeSession(session.id, { status: "failed" });
      return c.json({ error: "Playground request failed", detail: message, session: failed, events: await store.listSessionEvents(session.id) }, 502);
    }
  });


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
