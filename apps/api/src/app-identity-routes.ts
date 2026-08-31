import { createHmac, randomBytes } from "node:crypto";
import { PUBLIC_ORIGIN_FALLBACK } from "@evelandhq/core/ports";
import { getCookie, setCookie } from "hono/cookie";
import {
  normalizeIdentityProviderConnection,
  type IdentityProviderConnection,
} from "@evelandhq/core/identity";
import { decryptSecretValue, encryptSecretValue } from "@evelandhq/core/server/secrets";
import {
  IdentityBrokerError,
  createIdentityBroker,
  hashIdentityToken,
  oidcProviderConfig,
  openIdentityProviderSecret,
  sealIdentityProviderSecret,
} from "@evelandhq/identity-broker";
import type { Store } from "@evelandhq/db";
import type { AppOptions, ApiApp } from "./app-types.js";
import { isServiceRequest, publicGatewayUrl } from "./app-support.js";
import { createIdentityOidcProtocol } from "./identity-oidc-protocol.js";
import {
  callerTokenRequestSchema,
  createIdentityProviderSchema,
  createIdentityRealmSchema,
  identityAppTokenRequestSchema,
  openCallerTokenRequestSchema,
  updateIdentityRealmSchema,
  updateIdentityProviderSchema,
  upsertIdentityReturnTargetSchema,
} from "./app-schemas.js";

export const IDENTITY_SESSION_COOKIE_NAME = "eveland_identity";
const LOGIN_TRANSACTION_TTL_MS = 10 * 60 * 1_000;
const ONE_ENABLED_PROVIDER_ERROR =
  "Only one Identity Provider can be enabled. Disable the current one first.";

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
    process.env.EVELAND_PUBLIC_ORIGIN ??
    PUBLIC_ORIGIN_FALLBACK
  ).replace(/\/$/, "");
  const configuredAllowedOrigins =
    context.options.identityAllowedOrigins ??
    splitOrigins(process.env.EVELAND_IDENTITY_ALLOWED_ORIGINS);
  // Deliberately no development fallback: the Identity origin allowlist is
  // always an explicit operator decision (empty means no browser origin may
  // use the Identity API).
  const allowedOrigins = new Set(configuredAllowedOrigins);
  const oidcProtocol =
    context.options.identityOidcProtocol ??
    createIdentityOidcProtocol({
      allowInsecureIssuer: process.env.EVELAND_IDENTITY_OIDC_ALLOW_INSECURE === "1",
    });
  const broker = createIdentityBroker({
    store: context.store,
    issuer,
    appSecretKey: context.appSecretKey,
    oidcProtocol,
  });
  return {
    broker,
    issuer,
    allowedOrigins,
    oidcProtocol,
    oidcRedirectUri: `${issuer}/api/identity/oidc/callback`,
  };
}

export function registerPublicIdentityRoutes(
  context: IdentityRoutesContext,
  services: ReturnType<typeof createIdentityRouteServices>,
) {
  const { app, store, options, webOrigin } = context;
  const { broker, issuer, allowedOrigins } = services;

  app.get("/api/identity/session", async (c) => {
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

  app.get("/api/identity/login", async (c) => {
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
      await store.revokeIdentitySessionByTokenHash(hashIdentityToken(existingSession));
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
    // Open access never redirects a caller into a login: non-browser callers
    // cannot follow one, and there is no identity to establish.
    if (provider.type === "open") {
      return c.json(
        {
          code: "identity_login_not_required",
          error: "This Eveland instance is open to all callers; no identity login is used.",
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

    if (provider.type === "oidc") {
      try {
        const begun = await broker.beginOidcLogin({
          providerConnectionId: provider.id,
          redirectUri: services.oidcRedirectUri,
        });
        await store.createIdentityLoginTransaction({
          stateHash: hashIdentityToken(begun.state),
          providerConnectionId: provider.id,
          providerSecurityRevision: begun.providerSecurityRevision,
          returnTargetId: target.id,
          returnPath,
          nonceHash: hashIdentityToken(begun.nonce),
          pkceVerifierEncrypted: sealOidcLoginSecrets(
            { state: begun.state, nonce: begun.nonce, codeVerifier: begun.codeVerifier },
            context.appSecretKey,
          ),
          expiresAt: new Date(current.getTime() + LOGIN_TRANSACTION_TTL_MS),
        });
        return c.redirect(begun.authorizationUrl, 302);
      } catch (error) {
        return identityError(c, error);
      }
    }
    if (provider.type !== "internal") {
      return c.json(
        {
          code: "identity_provider_unavailable",
          error: "The selected Identity Provider is not available in this release.",
        },
        503,
      );
    }

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
      return completeInternalLogin(c, state, internalIdentity, context, services);
    }

    const next = `/api/identity/continue?state=${encodeURIComponent(state)}`;
    const login = new URL("/login", webOrigin);
    login.searchParams.set("next", next);
    return c.redirect(login.toString(), 302);
  });

  // Continuation after the Dashboard's Better Auth login: `next` is a path on
  // the public origin, where the front door routes it straight back here — the
  // Better Auth session cookie rides along because both live on that origin.
  app.get("/api/identity/continue", async (c) => {
    c.header("cache-control", "no-store");
    const state = c.req.query("state") ?? "";
    const internalIdentity = await options.auth?.resolveInternalIdentity(c.req.raw);
    if (!internalIdentity) {
      const next = `/api/identity/continue?state=${encodeURIComponent(state)}`;
      const login = new URL("/login", webOrigin);
      login.searchParams.set("next", next);
      return c.redirect(login.toString(), 302);
    }
    return completeInternalLogin(c, state, internalIdentity, context, services);
  });

  app.get("/api/identity/oidc/callback", async (c) => {
    c.header("cache-control", "no-store");
    const state = c.req.query("state") ?? "";
    // Consume before anything else, including the IdP-error path: whatever
    // happens next, this state must never complete a second login.
    const transaction = state
      ? await store.consumeIdentityLoginTransaction(hashIdentityToken(state))
      : null;
    if (c.req.query("error")) {
      return c.json(
        {
          code: "identity_oidc_denied",
          error: "The OIDC Identity Provider did not authorize this login.",
        },
        401,
      );
    }
    if (!transaction) {
      return c.json(
        {
          code: "identity_login_transaction_invalid",
          error: "The Identity login transaction is invalid or expired.",
        },
        400,
      );
    }
    const target = (await store.listIdentityReturnTargets()).find(
      (candidate) => candidate.id === transaction.returnTargetId && candidate.enabled,
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
    const secrets = openOidcLoginSecrets(transaction.pkceVerifierEncrypted, context.appSecretKey);
    if (
      !secrets ||
      secrets.state !== state ||
      transaction.nonceHash !== hashIdentityToken(secrets.nonce)
    ) {
      return c.json(
        {
          code: "identity_login_transaction_invalid",
          error: "The Identity login transaction is invalid or expired.",
        },
        400,
      );
    }
    try {
      const callbackUrl = new URL(services.oidcRedirectUri);
      callbackUrl.search = new URL(c.req.url).search;
      const finalized = await broker.completeOidcLogin({
        providerConnectionId: transaction.providerConnectionId,
        providerSecurityRevision: transaction.providerSecurityRevision,
        transaction: {
          redirectUri: services.oidcRedirectUri,
          state,
          nonce: secrets.nonce,
          codeVerifier: secrets.codeVerifier,
        },
        callbackUrl,
      });
      setIdentityCookie(c, finalized.sessionToken, issuer, finalized.session.expiresAt);
      return c.redirect(await broker.resolveReturnTarget(target.key, transaction.returnPath), 302);
    } catch (error) {
      return identityError(c, error);
    }
  });

  app.post("/api/identity/caller-tokens", async (c) => {
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
    const parsed = callerTokenRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ code: "identity_request_invalid", error: "Project ID is required." }, 400);
    }
    try {
      const sessionToken = getCookie(c, IDENTITY_SESSION_COOKIE_NAME) ?? "";
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
                agentUrl: publicGatewayUrl(catalogAgent.hostname, options),
              }
            : {}),
        }),
      );
    } catch (error) {
      return identityError(c, error);
    }
  });

  app.post("/api/identity/app-tokens", async (c) => {
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
    const parsed = identityAppTokenRequestSchema.safeParse(await c.req.json().catch(() => null));
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

  app.post("/api/identity/logout", async (c) => {
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

/**
 * Session-less Caller Token minting for the Gateway.
 *
 * Sits behind the same service token as `/internal/runtime/activations`; the
 * Gateway is the only caller and already holds it. The route deliberately
 * exposes only the open-access mint, which derives its Principal from the
 * enabled Provider rather than from anything the caller supplies -- the service
 * token proves "this is the Gateway", not "this is user X", so it must never
 * reach a code path that would take a subject from the request.
 */
export function registerInternalIdentityRoutes(
  context: IdentityRoutesContext,
  services: ReturnType<typeof createIdentityRouteServices>,
) {
  const { app, options } = context;
  const { broker } = services;

  app.post("/internal/identity/open-caller-tokens", async (c) => {
    c.header("cache-control", "no-store");
    const serviceToken = options.gatewayServiceToken ?? process.env.EVELAND_GATEWAY_SERVICE_TOKEN;
    if (!isServiceRequest(c.req.header("authorization"), serviceToken)) {
      return c.json({ error: "Not found" }, 404);
    }
    const parsed = openCallerTokenRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ code: "identity_request_invalid", error: "Project ID is required." }, 400);
    }
    try {
      return c.json(await broker.issueOpenModeCallerToken({ projectId: parsed.data.projectId }));
    } catch (error) {
      return identityError(c, error);
    }
  });
}

export function registerSystemIdentityRoutes(
  context: IdentityRoutesContext,
  services: ReturnType<typeof createIdentityRouteServices>,
) {
  const { app, store, appSecretKey } = context;
  app.get("/api/system/identity/providers", async (c) => {
    return c.json({
      providers: (await store.listIdentityProviderConnections()).map(publicProvider),
      // What an admin registers at their IdP; surfaced so the settings UI
      // never has to guess the API origin.
      oidcRedirectUri: services.oidcRedirectUri,
    });
  });

  app.post("/api/system/identity/providers", async (c) => {
    const parsed = createIdentityProviderSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Invalid Identity Provider", issues: parsed.error.issues }, 400);
    }
    let normalized;
    try {
      normalized = normalizeIdentityProviderConnection({
        ...parsed.data,
        clientSecretConfigured: parsed.data.type === "oidc" && Boolean(parsed.data.clientSecret),
      });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Invalid Identity Provider." },
        422,
      );
    }
    // The Identity Provider is platform-wide and exclusive, whatever its type:
    // the caller disables the current one before enabling a replacement.
    if (
      normalized.enabled &&
      (await store.listIdentityProviderConnections()).some((provider) => provider.enabled)
    ) {
      return c.json({ error: ONE_ENABLED_PROVIDER_ERROR }, 409);
    }
    try {
      const provider = await store.createIdentityProviderConnection(
        normalized.type === "oidc"
          ? {
              ...normalized,
              clientSecretEncrypted:
                parsed.data.type === "oidc" && parsed.data.clientSecret
                  ? sealIdentityProviderSecret(parsed.data.clientSecret, appSecretKey)
                  : null,
            }
          : normalized,
      );
      return c.json({ provider: publicProvider(provider) }, 201);
    } catch (error) {
      // The exclusivity pre-check above races; the unique index is what
      // actually holds. Without this the violation escapes as an unhandled 500,
      // because the app registers no onError handler.
      return c.json(
        {
          error: error instanceof Error ? error.message : "Identity Provider could not be created.",
        },
        409,
      );
    }
  });

  app.post("/api/system/identity/providers/:providerId/preflight", async (c) => {
    const provider = await store.getIdentityProviderConnection(c.req.param("providerId"));
    if (!provider) return c.json({ error: "Identity Provider not found" }, 404);
    if (provider.type === "open") {
      return c.json({ ok: true, checks: { noIdentityCheckPerformed: true } });
    }
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
    let metadata: Record<string, unknown>;
    try {
      metadata = await services.oidcProtocol.discoverMetadata(
        oidcProviderConfig(provider),
        provider.clientSecretEncrypted
          ? openIdentityProviderSecret(provider.clientSecretEncrypted, appSecretKey)
          : undefined,
      );
    } catch {
      return c.json({
        ok: false,
        error: "OIDC discovery failed: the issuer is unreachable or its metadata is invalid.",
        checks: { discovery: false },
      });
    }
    const advertised = (key: string): string[] | null => {
      const value = metadata[key];
      return Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? (value as string[])
        : null;
    };
    const responseTypes = advertised("response_types_supported");
    const authMethods = advertised("token_endpoint_auth_methods_supported");
    const pkceMethods = advertised("code_challenge_methods_supported");
    const scopes = advertised("scopes_supported");
    const claims = advertised("claims_supported");
    const checks = {
      discovery: true,
      authorizationCodeFlow: responseTypes === null || responseTypes.includes("code"),
      tokenEndpointAuthMethod:
        authMethods === null || authMethods.includes(provider.tokenEndpointAuthMethod ?? ""),
      pkceS256: pkceMethods === null || pkceMethods.includes("S256"),
    };
    // Absent or incomplete advertisement lists are common (Auth0 does not
    // list org_id), so these inform the admin without failing the preflight.
    const advisories = {
      scopesAdvertised: scopes === null || provider.scopes.every((scope) => scopes.includes(scope)),
      realmClaimAdvertised:
        !provider.externalRealmClaim ||
        claims === null ||
        claims.includes(provider.externalRealmClaim),
    };
    return c.json({
      ok: Object.values(checks).every(Boolean),
      checks,
      advisories,
    });
  });

  app.patch("/api/system/identity/providers/:providerId", async (c) => {
    const parsed = updateIdentityProviderSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Invalid Identity Provider update" }, 400);
    }
    const current = await store.getIdentityProviderConnection(c.req.param("providerId"));
    if (!current) return c.json({ error: "Identity Provider not found" }, 404);
    if (
      current.type === "internal" &&
      parsed.data.internalRealmKey !== undefined &&
      parsed.data.internalRealmKey !== current.internalRealmKey
    ) {
      return c.json({ error: "Internal Realm key is immutable." }, 409);
    }
    if (
      (parsed.data.enabled ?? current.enabled) &&
      (await store.listIdentityProviderConnections()).some(
        (provider) => provider.id !== current.id && provider.enabled,
      )
    ) {
      return c.json({ error: ONE_ENABLED_PROVIDER_ERROR }, 409);
    }
    const nextSecret =
      parsed.data.clientSecret === undefined
        ? current.clientSecretEncrypted
        : parsed.data.clientSecret === null
          ? null
          : sealIdentityProviderSecret(parsed.data.clientSecret, appSecretKey);
    const securityChanged =
      current.type === "internal"
        ? false
        : (parsed.data.issuer !== undefined && parsed.data.issuer !== current.issuer) ||
          (parsed.data.clientId !== undefined && parsed.data.clientId !== current.clientId) ||
          parsed.data.clientSecret !== undefined ||
          (parsed.data.tokenEndpointAuthMethod !== undefined &&
            parsed.data.tokenEndpointAuthMethod !== current.tokenEndpointAuthMethod) ||
          (parsed.data.externalRealmResolution !== undefined &&
            parsed.data.externalRealmResolution !== current.externalRealmResolution) ||
          (parsed.data.externalRealmClaim !== undefined &&
            parsed.data.externalRealmClaim !== current.externalRealmClaim) ||
          (parsed.data.scopes !== undefined &&
            JSON.stringify(parsed.data.scopes) !== JSON.stringify(current.scopes)) ||
          (parsed.data.authorizationParameters !== undefined &&
            JSON.stringify(parsed.data.authorizationParameters) !==
              JSON.stringify(current.authorizationParameters));
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

  app.get("/api/system/identity/realms", async (c) => {
    return c.json({
      realms: await store.listIdentityRealms(c.req.query("providerConnectionId")),
    });
  });

  app.post("/api/system/identity/realms", async (c) => {
    const parsed = createIdentityRealmSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid Identity Realm" }, 400);
    const provider = await store.getIdentityProviderConnection(parsed.data.providerConnectionId);
    if (!provider) return c.json({ error: "Identity Provider not found" }, 404);
    if (
      provider.type === "internal" &&
      (parsed.data.externalRealmKind !== "internal" ||
        parsed.data.externalRealmId !== provider.internalRealmKey)
    ) {
      return c.json({ error: "Internal Realm must exactly match the Provider Realm key." }, 422);
    }
    const existing = await store.getIdentityRealmByExternalId(
      provider.id,
      parsed.data.externalRealmId,
    );
    if (existing) return c.json({ error: "Identity Realm already exists." }, 409);
    return c.json({ realm: await store.createIdentityRealm(parsed.data) }, 201);
  });

  app.patch("/api/system/identity/realms/:realmId", async (c) => {
    const parsed = updateIdentityRealmSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid Identity Realm update" }, 400);
    const realm = await store.updateIdentityRealm(c.req.param("realmId"), parsed.data);
    return realm ? c.json({ realm }) : c.json({ error: "Identity Realm not found" }, 404);
  });

  app.get("/api/system/identity/return-targets", async (c) => {
    return c.json({ targets: await store.listIdentityReturnTargets() });
  });

  app.put("/api/system/identity/return-targets/:targetKey", async (c) => {
    const key = c.req.param("targetKey");
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(key)) {
      return c.json({ error: "Invalid Identity return target key." }, 400);
    }
    const parsed = upsertIdentityReturnTargetSchema.safeParse(await c.req.json().catch(() => null));
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
  const transaction = await context.store.consumeIdentityLoginTransaction(hashIdentityToken(state));
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
    (candidate) => candidate.id === transaction.returnTargetId && candidate.enabled,
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
        ...(internalIdentity.displayName ? { displayName: internalIdentity.displayName } : {}),
        email: internalIdentity.email,
      },
    });
    setIdentityCookie(c, finalized.sessionToken, services.issuer, finalized.session.expiresAt);
    return c.redirect(
      await services.broker.resolveReturnTarget(target.key, transaction.returnPath),
      302,
    );
  } catch (error) {
    return identityError(c, error);
  }
}

function setIdentityCookie(c: any, token: string, issuer: string, expiresAt: string) {
  setCookie(c, IDENTITY_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: new URL(issuer).protocol === "https:",
    sameSite: "Lax",
    path: "/api/identity",
    expires: new Date(expiresAt),
  });
}

function clearIdentityCookie(c: any, issuer: string) {
  setCookie(c, IDENTITY_SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: new URL(issuer).protocol === "https:",
    sameSite: "Lax",
    path: "/api/identity",
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

type OidcLoginSecrets = { state: string; nonce: string; codeVerifier: string };

/**
 * The raw per-login OIDC secrets, sealed into the transaction row. The nonce
 * and PKCE verifier must come back verbatim at the callback (the exchange
 * compares them against the ID token and the token endpoint), so a hash
 * cannot carry them; the state rides along so an opened blob is provably the
 * one minted for this transaction.
 */
function sealOidcLoginSecrets(secrets: OidcLoginSecrets, appSecretKey: string): string {
  return JSON.stringify(
    encryptSecretValue(JSON.stringify(secrets), loginTransactionKey(appSecretKey)),
  );
}

function openOidcLoginSecrets(
  sealed: string | null,
  appSecretKey: string,
): OidcLoginSecrets | null {
  if (!sealed) return null;
  try {
    const opened: unknown = JSON.parse(
      decryptSecretValue(
        JSON.parse(sealed) as Parameters<typeof decryptSecretValue>[0],
        loginTransactionKey(appSecretKey),
      ),
    );
    if (
      typeof opened === "object" &&
      opened !== null &&
      typeof (opened as OidcLoginSecrets).state === "string" &&
      typeof (opened as OidcLoginSecrets).nonce === "string" &&
      typeof (opened as OidcLoginSecrets).codeVerifier === "string"
    ) {
      return opened as OidcLoginSecrets;
    }
    return null;
  } catch {
    return null;
  }
}

function loginTransactionKey(appSecretKey: string): string {
  return createHmac("sha256", appSecretKey)
    .update("eveland:identity:login-transaction:v1")
    .digest("base64");
}

function splitOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
