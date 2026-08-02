import { createHmac, randomBytes } from "node:crypto";
import { getCookie, setCookie } from "hono/cookie";
import {
  normalizeIdentityProviderConnection,
  type IdentityProviderConnection,
} from "@eveland/core/identity";
import { encryptSecretValue } from "@eveland/core/server/secrets";
import {
  IdentityBrokerError,
  createIdentityBroker,
  hashIdentityToken,
} from "@eveland/identity-broker";
import type { Store } from "@eveland/db";
import type { AppOptions, ApiApp } from "./app-types.js";
import { publicGatewayUrl } from "./app-support.js";
import {
  callerTokenRequestSchema,
  createIdentityProviderSchema,
  createIdentityRealmSchema,
  identityAppTokenRequestSchema,
  updateIdentityRealmSchema,
  updateIdentityProviderSchema,
  upsertIdentityReturnTargetSchema,
} from "./app-schemas.js";

export const IDENTITY_SESSION_COOKIE_NAME = "eveland_identity";
const LOGIN_TRANSACTION_TTL_MS = 10 * 60 * 1_000;

type IdentityRoutesContext = {
  app: ApiApp;
  store: Store;
  options: AppOptions;
  appSecretKey: string;
  webOrigin: string;
};

export function createIdentityRouteServices(context: IdentityRoutesContext) {
  const issuer = (
    context.options.identityIssuer ??
    process.env.EVELAND_IDENTITY_ISSUER ??
    "http://localhost:4000"
  ).replace(/\/$/, "");
  const configuredAllowedOrigins =
    context.options.identityAllowedOrigins ??
    splitOrigins(process.env.EVELAND_IDENTITY_ALLOWED_ORIGINS);
  const allowedOrigins = new Set(
    configuredAllowedOrigins.length > 0
      ? configuredAllowedOrigins
      : process.env.NODE_ENV !== "production"
        ? ["http://localhost:3010"]
        : [],
  );
  const broker = createIdentityBroker({
    store: context.store,
    issuer,
    appSecretKey: context.appSecretKey,
  });
  return { broker, issuer, allowedOrigins };
}

export function registerPublicIdentityRoutes(
  context: IdentityRoutesContext,
  services: ReturnType<typeof createIdentityRouteServices>,
) {
  const { app, store, options, webOrigin } = context;
  const { broker, issuer, allowedOrigins } = services;

  app.get("/identity/session", async (c) => {
    c.header("cache-control", "no-store");
    const sessionToken = getCookie(c, IDENTITY_SESSION_COOKIE_NAME) ?? "";
    try {
      const resolved = await broker.resolveSession(sessionToken);
      return c.json({
        authenticated: true,
        principal: {
          id: resolved.principal.id,
          name: resolved.principal.displayName,
          email: resolved.principal.email,
        },
        activeRealm: {
          id: resolved.realm.id,
          name: resolved.realm.displayName,
        },
      });
    } catch (error) {
      if (error instanceof IdentityBrokerError && error.status === 401) {
        return c.json({ authenticated: false });
      }
      return identityError(c, error);
    }
  });

  app.get("/identity/login", async (c) => {
    c.header("cache-control", "no-store");
    const targetKey = c.req.query("target") ?? "";
    const returnPath = c.req.query("returnPath") ?? "";
    let returnUrl: string;
    try {
      returnUrl = await broker.resolveReturnTarget(targetKey, returnPath);
    } catch (error) {
      return identityError(c, error);
    }

    const existingSession = getCookie(c, IDENTITY_SESSION_COOKIE_NAME);
    const switchRealm = c.req.query("switchRealm") === "1";
    if (existingSession && !switchRealm) {
      try {
        await broker.resolveSession(existingSession);
        return c.redirect(returnUrl, 302);
      } catch {
        clearIdentityCookie(c, issuer);
      }
    }
    if (existingSession && switchRealm) {
      await store.revokeIdentitySessionByTokenHash(
        hashIdentityToken(existingSession),
      );
    }

    const providers = (await store.listIdentityProviderConnections()).filter(
      (provider) => provider.enabled,
    );
    if (providers.length !== 1) {
      return c.json(
        {
          code: "identity_provider_selection_required",
          error:
            providers.length === 0
              ? "No Eveland Identity Provider is enabled."
              : "Eveland Identity Provider selection is required.",
        },
        503,
      );
    }
    const provider = providers[0]!;
    if (provider.type !== "internal") {
      return c.json(
        {
          code: "identity_provider_unavailable",
          error: "The selected Identity Provider is not available in this release.",
        },
        503,
      );
    }

    const target = (await store.listIdentityReturnTargets()).find(
      (candidate) => candidate.key === targetKey && candidate.enabled,
    );
    if (!target) {
      return c.json(
        {
          code: "identity_return_target_invalid",
          error: "The Identity return target is not registered.",
        },
        400,
      );
    }
    const current = new Date();
    await store.deleteExpiredIdentityLoginTransactions(current, 100);
    const state = randomBytes(32).toString("base64url");
    await store.createIdentityLoginTransaction({
      stateHash: hashIdentityToken(state),
      providerConnectionId: provider.id,
      providerSecurityRevision: provider.securityRevision,
      returnTargetId: target.id,
      returnPath,
      nonceHash: null,
      pkceVerifierEncrypted: null,
      expiresAt: new Date(current.getTime() + LOGIN_TRANSACTION_TTL_MS),
    });

    const internalIdentity = await options.auth?.resolveInternalIdentity(c.req.raw);
    if (internalIdentity) {
      return completeInternalLogin(
        c,
        state,
        internalIdentity,
        context,
        services,
      );
    }

    const next = `/identity/internal/continue?state=${encodeURIComponent(state)}`;
    const login = new URL("/login", webOrigin);
    login.searchParams.set("next", next);
    return c.redirect(login.toString(), 302);
  });

  app.get("/identity/internal/continue", async (c) => {
    c.header("cache-control", "no-store");
    const state = c.req.query("state") ?? "";
    const internalIdentity = await options.auth?.resolveInternalIdentity(c.req.raw);
    if (!internalIdentity) {
      const next = `/identity/internal/continue?state=${encodeURIComponent(state)}`;
      const login = new URL("/login", webOrigin);
      login.searchParams.set("next", next);
      return c.redirect(login.toString(), 302);
    }
    return completeInternalLogin(
      c,
      state,
      internalIdentity,
      context,
      services,
    );
  });

  app.post("/identity/caller-tokens", async (c) => {
    c.header("cache-control", "no-store");
    if (!allowedOrigins.has(c.req.header("origin") ?? "")) {
      return c.json(
        {
          code: "identity_origin_forbidden",
          error: "This origin cannot request Eveland Caller Tokens.",
        },
        403,
      );
    }
    const parsed = callerTokenRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { code: "identity_request_invalid", error: "Project ID is required." },
        400,
      );
    }
    try {
      const sessionToken =
        getCookie(c, IDENTITY_SESSION_COOKIE_NAME) ?? "";
      await broker.resolveSession(sessionToken);
      const catalogAgent = (await store.listAgentCatalog()).find(
        (agent) => agent.projectId === parsed.data.projectId,
      );
      return c.json(
        await broker.issueCallerToken({
          sessionToken,
          projectId: parsed.data.projectId,
          ...(catalogAgent
            ? {
                agentUrl: publicGatewayUrl(
                  catalogAgent.hostname,
                  options,
                ),
              }
            : {}),
        }),
      );
    } catch (error) {
      return identityError(c, error);
    }
  });

  app.post("/identity/app-tokens", async (c) => {
    c.header("cache-control", "no-store");
    const origin = c.req.header("origin") ?? "";
    if (!allowedOrigins.has(origin)) {
      return c.json(
        {
          code: "identity_origin_forbidden",
          error: "This origin cannot request Eveland app tokens.",
        },
        403,
      );
    }
    const parsed = identityAppTokenRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          code: "identity_request_invalid",
          error: "Identity return target is required.",
        },
        400,
      );
    }
    try {
      return c.json(
        await broker.issueAppToken({
          sessionToken: getCookie(c, IDENTITY_SESSION_COOKIE_NAME) ?? "",
          targetKey: parsed.data.target,
          origin,
        }),
      );
    } catch (error) {
      return identityError(c, error);
    }
  });

  app.post("/identity/logout", async (c) => {
    c.header("cache-control", "no-store");
    if (!allowedOrigins.has(c.req.header("origin") ?? "")) {
      return c.json(
        {
          code: "identity_origin_forbidden",
          error: "This origin cannot revoke an Eveland Identity Session.",
        },
        403,
      );
    }
    const token = getCookie(c, IDENTITY_SESSION_COOKIE_NAME);
    if (token) {
      await store.revokeIdentitySessionByTokenHash(hashIdentityToken(token));
    }
    clearIdentityCookie(c, issuer);
    return c.body(null, 204);
  });

  app.get("/.well-known/jwks.json", async (c) => {
    c.header("cache-control", "public, max-age=60");
    return c.json(await broker.getJwks());
  });
}

export function registerSystemIdentityRoutes(
  context: IdentityRoutesContext,
) {
  const { app, store, appSecretKey } = context;
  const requireAdmin = (role: string) => role === "admin";

  app.get("/system/identity/providers", async (c) => {
    if (!requireAdmin(c.get("principal").role)) {
      return c.json({ error: "Admin access required" }, 403);
    }
    return c.json({
      providers: (await store.listIdentityProviderConnections()).map(publicProvider),
    });
  });

  app.post("/system/identity/providers", async (c) => {
    if (!requireAdmin(c.get("principal").role)) {
      return c.json({ error: "Admin access required" }, 403);
    }
    const parsed = createIdentityProviderSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid Identity Provider", issues: parsed.error.issues },
        400,
      );
    }
    let normalized;
    try {
      normalized = normalizeIdentityProviderConnection({
        ...parsed.data,
        clientSecretConfigured:
          parsed.data.type === "oidc" && Boolean(parsed.data.clientSecret),
      });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Invalid Identity Provider." },
        422,
      );
    }
    if (
      normalized.type === "internal" &&
      normalized.enabled &&
      (await store.listIdentityProviderConnections()).some(
        (provider) => provider.type === "internal" && provider.enabled,
      )
    ) {
      return c.json({ error: "Only one Internal Identity Provider can be enabled." }, 409);
    }
    const provider = await store.createIdentityProviderConnection(
      normalized.type === "internal"
        ? normalized
        : {
            ...normalized,
            clientSecretEncrypted:
              parsed.data.type === "oidc" && parsed.data.clientSecret
                ? sealProviderSecret(parsed.data.clientSecret, appSecretKey)
                : null,
          },
    );
    return c.json({ provider: publicProvider(provider) }, 201);
  });

  app.post("/system/identity/providers/:providerId/preflight", async (c) => {
    if (!requireAdmin(c.get("principal").role)) {
      return c.json({ error: "Admin access required" }, 403);
    }
    const provider = await store.getIdentityProviderConnection(
      c.req.param("providerId"),
    );
    if (!provider) return c.json({ error: "Identity Provider not found" }, 404);
    if (provider.type === "internal") {
      return c.json({
        ok: Boolean(context.options.auth),
        checks: {
          betterAuthVerifier: Boolean(context.options.auth),
          internalRealmKey: Boolean(provider.internalRealmKey),
          separateIdentityCookie:
            String(IDENTITY_SESSION_COOKIE_NAME) !== String("eveland_session"),
        },
      });
    }
    return c.json({ ok: false, error: "OIDC preflight is not implemented." }, 503);
  });

  app.patch("/system/identity/providers/:providerId", async (c) => {
    if (!requireAdmin(c.get("principal").role)) {
      return c.json({ error: "Admin access required" }, 403);
    }
    const parsed = updateIdentityProviderSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: "Invalid Identity Provider update" }, 400);
    }
    const current = await store.getIdentityProviderConnection(
      c.req.param("providerId"),
    );
    if (!current) return c.json({ error: "Identity Provider not found" }, 404);
    if (
      current.type === "internal" &&
      parsed.data.internalRealmKey !== undefined &&
      parsed.data.internalRealmKey !== current.internalRealmKey
    ) {
      return c.json({ error: "Internal Realm key is immutable." }, 409);
    }
    if (
      current.type === "internal" &&
      (parsed.data.enabled ?? current.enabled) &&
      (await store.listIdentityProviderConnections()).some(
        (provider) =>
          provider.id !== current.id &&
          provider.type === "internal" &&
          provider.enabled,
      )
    ) {
      return c.json(
        { error: "Only one Internal Identity Provider can be enabled." },
        409,
      );
    }
    const nextSecret =
      parsed.data.clientSecret === undefined
        ? current.clientSecretEncrypted
        : parsed.data.clientSecret === null
          ? null
          : sealProviderSecret(parsed.data.clientSecret, appSecretKey);
    const securityChanged =
      current.type === "internal"
        ? false
        : parsed.data.issuer !== undefined && parsed.data.issuer !== current.issuer ||
          parsed.data.clientId !== undefined && parsed.data.clientId !== current.clientId ||
          parsed.data.clientSecret !== undefined ||
          parsed.data.tokenEndpointAuthMethod !== undefined &&
            parsed.data.tokenEndpointAuthMethod !== current.tokenEndpointAuthMethod ||
          parsed.data.externalRealmResolution !== undefined &&
            parsed.data.externalRealmResolution !== current.externalRealmResolution ||
          parsed.data.externalRealmClaim !== undefined &&
            parsed.data.externalRealmClaim !== current.externalRealmClaim ||
          parsed.data.scopes !== undefined &&
            JSON.stringify(parsed.data.scopes) !== JSON.stringify(current.scopes) ||
          parsed.data.authorizationParameters !== undefined &&
            JSON.stringify(parsed.data.authorizationParameters) !==
              JSON.stringify(current.authorizationParameters);
    try {
      const updated = await store.updateIdentityProviderConnection({
        id: current.id,
        expectedSecurityRevision: parsed.data.expectedSecurityRevision,
        displayName: parsed.data.displayName,
        internalRealmKey: parsed.data.internalRealmKey,
        issuer: parsed.data.issuer,
        clientId: parsed.data.clientId,
        clientSecretEncrypted: nextSecret,
        scopes: parsed.data.scopes,
        authorizationParameters: parsed.data.authorizationParameters,
        tokenEndpointAuthMethod: parsed.data.tokenEndpointAuthMethod,
        externalRealmResolution: parsed.data.externalRealmResolution,
        externalRealmClaim: parsed.data.externalRealmClaim,
        enabled: parsed.data.enabled,
        securityChanged,
      });
      return updated
        ? c.json({ provider: publicProvider(updated) })
        : c.json({ error: "Identity Provider was updated by another request." }, 409);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Identity Provider update failed." },
        409,
      );
    }
  });

  app.get("/system/identity/realms", async (c) => {
    if (!requireAdmin(c.get("principal").role)) {
      return c.json({ error: "Admin access required" }, 403);
    }
    return c.json({
      realms: await store.listIdentityRealms(c.req.query("providerConnectionId")),
    });
  });

  app.post("/system/identity/realms", async (c) => {
    if (!requireAdmin(c.get("principal").role)) {
      return c.json({ error: "Admin access required" }, 403);
    }
    const parsed = createIdentityRealmSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: "Invalid Identity Realm" }, 400);
    const provider = await store.getIdentityProviderConnection(
      parsed.data.providerConnectionId,
    );
    if (!provider) return c.json({ error: "Identity Provider not found" }, 404);
    if (
      provider.type === "internal" &&
      (parsed.data.externalRealmKind !== "internal" ||
        parsed.data.externalRealmId !== provider.internalRealmKey)
    ) {
      return c.json(
        { error: "Internal Realm must exactly match the Provider Realm key." },
        422,
      );
    }
    const existing = await store.getIdentityRealmByExternalId(
      provider.id,
      parsed.data.externalRealmId,
    );
    if (existing) return c.json({ error: "Identity Realm already exists." }, 409);
    return c.json(
      { realm: await store.createIdentityRealm(parsed.data) },
      201,
    );
  });

  app.patch("/system/identity/realms/:realmId", async (c) => {
    if (!requireAdmin(c.get("principal").role)) {
      return c.json({ error: "Admin access required" }, 403);
    }
    const parsed = updateIdentityRealmSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: "Invalid Identity Realm update" }, 400);
    const realm = await store.updateIdentityRealm(
      c.req.param("realmId"),
      parsed.data,
    );
    return realm
      ? c.json({ realm })
      : c.json({ error: "Identity Realm not found" }, 404);
  });

  app.get("/system/identity/return-targets", async (c) => {
    if (!requireAdmin(c.get("principal").role)) {
      return c.json({ error: "Admin access required" }, 403);
    }
    return c.json({ targets: await store.listIdentityReturnTargets() });
  });

  app.put("/system/identity/return-targets/:targetKey", async (c) => {
    if (!requireAdmin(c.get("principal").role)) {
      return c.json({ error: "Admin access required" }, 403);
    }
    const key = c.req.param("targetKey");
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(key)) {
      return c.json({ error: "Invalid Identity return target key." }, 400);
    }
    const parsed = upsertIdentityReturnTargetSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: "Invalid Identity return target." }, 400);
    }
    const origin = new URL(parsed.data.origin).origin;
    return c.json({
      target: await store.upsertIdentityReturnTarget({
        key,
        origin,
        enabled: parsed.data.enabled,
      }),
    });
  });
}

async function completeInternalLogin(
  c: Parameters<ApiApp["request"]>[0] extends never ? never : any,
  state: string,
  internalIdentity: {
    externalSubject: string;
    displayName: string | null;
    email: string;
  },
  context: IdentityRoutesContext,
  services: ReturnType<typeof createIdentityRouteServices>,
) {
  const transaction = await context.store.consumeIdentityLoginTransaction(
    hashIdentityToken(state),
  );
  if (!transaction) {
    return c.json(
      {
        code: "identity_login_transaction_invalid",
        error: "The Identity login transaction is invalid or expired.",
      },
      400,
    );
  }
  const provider = await context.store.getIdentityProviderConnection(
    transaction.providerConnectionId,
  );
  if (
    !provider ||
    provider.type !== "internal" ||
    !provider.internalRealmKey ||
    provider.securityRevision !== transaction.providerSecurityRevision
  ) {
    return c.json(
      {
        code: "identity_provider_invalid",
        error: "The Identity Provider Connection changed during login.",
      },
      401,
    );
  }
  const target = (await context.store.listIdentityReturnTargets()).find(
    (candidate) =>
      candidate.id === transaction.returnTargetId && candidate.enabled,
  );
  if (!target) {
    return c.json(
      {
        code: "identity_return_target_invalid",
        error: "The Identity return target is no longer available.",
      },
      400,
    );
  }
  try {
    const finalized = await services.broker.finalizeIdentity({
      providerConnectionId: provider.id,
      providerSecurityRevision: transaction.providerSecurityRevision,
      identity: {
        externalRealmId: provider.internalRealmKey,
        externalRealmKind: "internal",
        externalSubject: internalIdentity.externalSubject,
        ...(internalIdentity.displayName
          ? { displayName: internalIdentity.displayName }
          : {}),
        email: internalIdentity.email,
      },
    });
    setIdentityCookie(
      c,
      finalized.sessionToken,
      services.issuer,
      finalized.session.expiresAt,
    );
    return c.redirect(
      await services.broker.resolveReturnTarget(
        target.key,
        transaction.returnPath,
      ),
      302,
    );
  } catch (error) {
    return identityError(c, error);
  }
}

function setIdentityCookie(
  c: any,
  token: string,
  issuer: string,
  expiresAt: string,
) {
  setCookie(c, IDENTITY_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: new URL(issuer).protocol === "https:",
    sameSite: "Lax",
    path: "/identity",
    expires: new Date(expiresAt),
  });
}

function clearIdentityCookie(c: any, issuer: string) {
  setCookie(c, IDENTITY_SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: new URL(issuer).protocol === "https:",
    sameSite: "Lax",
    path: "/identity",
    maxAge: 0,
  });
}

function identityError(c: any, error: unknown) {
  c.header("cache-control", "no-store");
  if (error instanceof IdentityBrokerError) {
    return c.json({ code: error.code, error: error.message }, error.status);
  }
  return c.json(
    {
      code: "identity_service_unavailable",
      error: "Eveland Identity is temporarily unavailable.",
    },
    503,
  );
}

function publicProvider(provider: IdentityProviderConnection) {
  const { clientSecretEncrypted: _secret, ...safe } = provider;
  return {
    ...safe,
    clientSecretConfigured: Boolean(provider.clientSecretEncrypted),
  };
}

function sealProviderSecret(value: string, appSecretKey: string): string {
  const contextKey = createHmac("sha256", appSecretKey)
    .update("eveland:identity:provider-secret:v1")
    .digest("base64");
  return JSON.stringify(encryptSecretValue(value, contextKey));
}

function splitOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
