import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import {
  callerTokenAudience,
  identityAppTokenAudience,
  OPEN_SHARED_REALM_KEY,
  OPEN_SHARED_SUBJECT,
  type ExternalRealmKind,
  type IdentityPrincipal,
  type IdentityProviderConnection,
  type IdentityRealm,
  type IdentityReturnTarget,
  type IdentitySession,
  type IdentitySigningKey,
  type IdentitySigningKeyStatus,
  type ResolvedExternalIdentity,
} from "@evelandhq/core/identity";
import type { Project } from "@evelandhq/core/contracts";
import { decryptSecretValue, encryptSecretValue } from "@evelandhq/core/server/secrets";
import {
  oidcProviderConfig,
  principalClaims,
  stringClaim,
  type IdentityOidcProtocol,
} from "./oidc.js";

export {
  oidcProviderConfig,
  principalClaims,
  stringClaim,
  type IdentityOidcProtocol,
  type IdentityOidcProviderConfig,
  type IdentityOidcTokens,
  type IdentityOidcTransaction,
} from "./oidc.js";

export class IdentityBrokerError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "IdentityBrokerError";
  }
}

export type IdentityBrokerPersistence = {
  getIdentityProviderConnection(id: string): Promise<IdentityProviderConnection | null>;
  listIdentityProviderConnections(): Promise<IdentityProviderConnection[]>;
  getIdentityRealmByExternalId(
    providerConnectionId: string,
    externalRealmId: string,
  ): Promise<IdentityRealm | null>;
  listIdentityRealms(providerConnectionId?: string): Promise<IdentityRealm[]>;
  createIdentityRealm(input: {
    providerConnectionId: string;
    externalRealmId: string;
    externalRealmKind: ExternalRealmKind;
    displayName: string;
    enabled: boolean;
  }): Promise<IdentityRealm>;
  upsertIdentityPrincipal(input: {
    identityRealmId: string;
    externalSubject: string;
    displayName: string | null;
    email: string | null;
    claims: Record<string, string | readonly string[]>;
  }): Promise<IdentityPrincipal>;
  createIdentitySession(input: {
    tokenHash: string;
    identityPrincipalId: string;
    activeIdentityRealmId: string;
    expiresAt: Date;
  }): Promise<IdentitySession>;
  getActiveIdentitySession(tokenHash: string, now?: Date): Promise<IdentitySession | null>;
  getIdentityPrincipal(id: string): Promise<IdentityPrincipal | null>;
  getIdentityRealm(id: string): Promise<IdentityRealm | null>;
  revokeIdentitySession(id: string, now?: Date): Promise<IdentitySession | null>;
  getProject(projectId: string): Promise<Pick<Project, "id" | "deletionStatus"> | null>;
  getIdentityReturnTargetByKey(key: string): Promise<IdentityReturnTarget | null>;
  listIdentitySigningKeys(): Promise<IdentitySigningKey[]>;
  getActiveIdentitySigningKey(now?: Date): Promise<IdentitySigningKey | null>;
  createIdentitySigningKey(input: {
    id?: string;
    algorithm: "ES256";
    publicJwk: Record<string, unknown>;
    privateKeyEncrypted: string;
    status: IdentitySigningKeyStatus;
    notBefore: Date;
    expiresAt: Date;
  }): Promise<IdentitySigningKey>;
  putIdentityOidcCredential(input: {
    identityPrincipalId: string;
    providerConnectionId: string;
    accessTokenEncrypted: string;
    refreshTokenEncrypted: string | null;
    scope: string;
    accessTokenExpiresAt: Date | null;
  }): Promise<unknown>;
};

export type IdentityBrokerOptions = {
  store: IdentityBrokerPersistence;
  issuer: string;
  appSecretKey: string;
  now?: () => Date;
  identitySessionTtlSeconds?: number;
  callerTokenTtlSeconds?: number;
  /**
   * Open access mints longer-lived Caller Tokens than an authenticating
   * Provider does. Its token carries no real identity and has no revocation
   * semantics, so a short lifetime protects nothing; a long one is what lets
   * an Identity outage shorter than one token cycle stay invisible to callers.
   */
  openCallerTokenTtlSeconds?: number;
  appTokenTtlSeconds?: number;
  /**
   * The OIDC wire protocol, injected by the composition root. Absent in
   * deployments that never enable an OIDC provider; the OIDC login entry
   * points fail with identity_provider_unavailable rather than at import
   * time so the rest of the broker stays usable.
   */
  oidcProtocol?: IdentityOidcProtocol;
};

export function createIdentityBroker(options: IdentityBrokerOptions) {
  assertStrongAppSecretKey(options.appSecretKey);
  const now = options.now ?? (() => new Date());
  const identitySessionTtlSeconds = options.identitySessionTtlSeconds ?? 30 * 24 * 60 * 60;
  const callerTokenTtlSeconds = options.callerTokenTtlSeconds ?? 60;
  const openCallerTokenTtlSeconds = options.openCallerTokenTtlSeconds ?? 20 * 60;
  const appTokenTtlSeconds = options.appTokenTtlSeconds ?? 5 * 60;
  const issuer = options.issuer.replace(/\/$/, "");

  async function finalizeIdentity(input: {
    providerConnectionId: string;
    providerSecurityRevision: number;
    identity: ResolvedExternalIdentity;
    claims?: Record<string, string | readonly string[]>;
  }) {
    const connection = await options.store.getIdentityProviderConnection(
      input.providerConnectionId,
    );
    if (
      !connection ||
      !connection.enabled ||
      connection.securityRevision !== input.providerSecurityRevision
    ) {
      throw new IdentityBrokerError(
        "identity_provider_invalid",
        401,
        "The Identity Provider Connection is no longer valid.",
      );
    }
    const realm = await options.store.getIdentityRealmByExternalId(
      connection.id,
      input.identity.externalRealmId,
    );
    if (!realm || !realm.enabled || realm.externalRealmKind !== input.identity.externalRealmKind) {
      throw new IdentityBrokerError(
        "identity_realm_not_allowed",
        403,
        "This identity scope is not allowed.",
      );
    }

    const principal = await options.store.upsertIdentityPrincipal({
      identityRealmId: realm.id,
      externalSubject: requiredIdentityValue(input.identity.externalSubject, "External subject"),
      displayName: optionalIdentityValue(input.identity.displayName),
      email: optionalIdentityValue(input.identity.email),
      claims: input.claims ?? {},
    });
    const sessionToken = randomBytes(32).toString("base64url");
    const current = now();
    const session = await options.store.createIdentitySession({
      tokenHash: hashIdentityToken(sessionToken),
      identityPrincipalId: principal.id,
      activeIdentityRealmId: realm.id,
      expiresAt: new Date(current.getTime() + identitySessionTtlSeconds * 1_000),
    });
    return { sessionToken, session, principal, realm };
  }

  function requireOidcProtocol(): IdentityOidcProtocol {
    if (!options.oidcProtocol) {
      throw new IdentityBrokerError(
        "identity_provider_unavailable",
        503,
        "This deployment has no OIDC protocol configured.",
      );
    }
    return options.oidcProtocol;
  }

  async function loadOidcConnection(
    providerConnectionId: string,
    expectedSecurityRevision?: number,
  ): Promise<IdentityProviderConnection> {
    const connection = await options.store.getIdentityProviderConnection(providerConnectionId);
    if (
      !connection ||
      !connection.enabled ||
      connection.type !== "oidc" ||
      (expectedSecurityRevision !== undefined &&
        connection.securityRevision !== expectedSecurityRevision)
    ) {
      throw new IdentityBrokerError(
        "identity_provider_invalid",
        401,
        "The Identity Provider Connection is no longer valid.",
      );
    }
    return connection;
  }

  function oidcClientSecret(connection: IdentityProviderConnection): string | undefined {
    return connection.clientSecretEncrypted
      ? openIdentityProviderSecret(connection.clientSecretEncrypted, options.appSecretKey)
      : undefined;
  }

  async function beginOidcLogin(input: { providerConnectionId: string; redirectUri: string }) {
    const protocol = requireOidcProtocol();
    const connection = await loadOidcConnection(input.providerConnectionId);
    const transaction = {
      redirectUri: input.redirectUri,
      state: randomBytes(32).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"),
      codeVerifier: randomBytes(48).toString("base64url"),
    };
    let authorizationUrl: URL;
    try {
      authorizationUrl = await protocol.buildAuthorizationUrl(
        oidcProviderConfig(connection),
        oidcClientSecret(connection),
        transaction,
      );
    } catch {
      throw new IdentityBrokerError(
        "identity_provider_unavailable",
        503,
        "The OIDC Identity Provider could not be reached.",
      );
    }
    return {
      authorizationUrl: authorizationUrl.toString(),
      state: transaction.state,
      nonce: transaction.nonce,
      codeVerifier: transaction.codeVerifier,
      providerConnectionId: connection.id,
      providerSecurityRevision: connection.securityRevision,
    };
  }

  async function completeOidcLogin(input: {
    providerConnectionId: string;
    providerSecurityRevision: number;
    transaction: { redirectUri: string; state: string; nonce: string; codeVerifier: string };
    callbackUrl: URL;
  }) {
    const protocol = requireOidcProtocol();
    const connection = await loadOidcConnection(
      input.providerConnectionId,
      input.providerSecurityRevision,
    );
    const config = oidcProviderConfig(connection);
    const clientSecret = oidcClientSecret(connection);
    let tokens;
    try {
      tokens = await protocol.exchangeAuthorizationCode(
        config,
        clientSecret,
        input.transaction,
        input.callbackUrl,
      );
    } catch {
      // The concrete failure (bad code, nonce mismatch, unreachable token
      // endpoint, signature rejection) is the IdP conversation's business;
      // to the caller every variant means this login attempt is dead.
      throw new IdentityBrokerError(
        "identity_oidc_exchange_failed",
        401,
        "The OIDC authorization could not be completed.",
      );
    }
    const subject = stringClaim(tokens.claims, "sub");
    if (!subject) {
      throw new IdentityBrokerError(
        "identity_oidc_claims_invalid",
        401,
        "The OIDC ID token carries no subject.",
      );
    }
    const externalRealmId = await resolveOidcExternalRealmId({
      connection,
      config,
      clientSecret,
      protocol,
      tokens,
      subject,
    });
    const realm = await options.store.getIdentityRealmByExternalId(connection.id, externalRealmId);
    if (!realm || !realm.enabled) {
      throw new IdentityBrokerError(
        "identity_realm_not_allowed",
        403,
        "This identity scope is not allowed.",
      );
    }
    const finalized = await finalizeIdentity({
      providerConnectionId: connection.id,
      providerSecurityRevision: connection.securityRevision,
      identity: {
        externalRealmId,
        externalRealmKind: realm.externalRealmKind,
        externalSubject: subject,
        ...(stringClaim(tokens.claims, "name")
          ? { displayName: stringClaim(tokens.claims, "name") }
          : {}),
        ...(stringClaim(tokens.claims, "email")
          ? { email: stringClaim(tokens.claims, "email") }
          : {}),
      },
      claims: principalClaims(tokens.claims),
    });
    await options.store.putIdentityOidcCredential({
      identityPrincipalId: finalized.principal.id,
      providerConnectionId: connection.id,
      accessTokenEncrypted: sealOidcCredentialValue(tokens.accessToken, options.appSecretKey),
      refreshTokenEncrypted: tokens.refreshToken
        ? sealOidcCredentialValue(tokens.refreshToken, options.appSecretKey)
        : null,
      scope: tokens.scope ?? connection.scopes.join(" "),
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    });
    return finalized;
  }

  async function resolveOidcExternalRealmId(input: {
    connection: IdentityProviderConnection;
    config: ReturnType<typeof oidcProviderConfig>;
    clientSecret: string | undefined;
    protocol: IdentityOidcProtocol;
    tokens: { claims: Record<string, unknown>; accessToken: string };
    subject: string;
  }): Promise<string> {
    const { connection } = input;
    if (connection.externalRealmResolution === "connection") {
      const realms = (await options.store.listIdentityRealms(connection.id)).filter(
        (realm) => realm.enabled,
      );
      if (realms.length !== 1) {
        throw new IdentityBrokerError(
          "identity_realm_not_allowed",
          403,
          "Connection-wide Realm resolution needs exactly one enabled Realm.",
        );
      }
      return realms[0]!.externalRealmId;
    }
    if (
      (connection.externalRealmResolution !== "id_token_claim" &&
        connection.externalRealmResolution !== "userinfo_claim") ||
      !connection.externalRealmClaim
    ) {
      throw new IdentityBrokerError(
        "identity_provider_invalid",
        401,
        "The OIDC Realm resolution configuration is invalid.",
      );
    }
    let source = input.tokens.claims;
    if (connection.externalRealmResolution === "userinfo_claim") {
      try {
        source = await input.protocol.fetchUserinfoClaims(
          input.config,
          input.clientSecret,
          input.tokens.accessToken,
          input.subject,
        );
      } catch {
        throw new IdentityBrokerError(
          "identity_oidc_exchange_failed",
          401,
          "The OIDC UserInfo endpoint rejected the login.",
        );
      }
    }
    const value = source[connection.externalRealmClaim];
    const realmId =
      typeof value === "string"
        ? value.trim()
        : typeof value === "number" && Number.isFinite(value)
          ? String(value)
          : "";
    if (!realmId) {
      throw new IdentityBrokerError(
        "identity_oidc_claims_invalid",
        401,
        `The OIDC claim ${connection.externalRealmClaim} names no Realm for this login.`,
      );
    }
    return realmId;
  }

  async function resolveSession(sessionToken: string) {
    if (!sessionToken) {
      throw new IdentityBrokerError(
        "identity_session_invalid",
        401,
        "An Eveland Identity Session is required.",
      );
    }
    const session = await options.store.getActiveIdentitySession(
      hashIdentityToken(sessionToken),
      now(),
    );
    if (!session) {
      throw new IdentityBrokerError(
        "identity_session_invalid",
        401,
        "The Eveland Identity Session is missing, expired, or revoked.",
      );
    }
    const principal = await options.store.getIdentityPrincipal(session.identityPrincipalId);
    const realm = await options.store.getIdentityRealm(session.activeIdentityRealmId);
    const connection = realm
      ? await options.store.getIdentityProviderConnection(realm.providerConnectionId)
      : null;
    if (
      !principal ||
      !realm ||
      !realm.enabled ||
      principal.identityRealmId !== realm.id ||
      !connection ||
      !connection.enabled
    ) {
      await options.store.revokeIdentitySession(session.id, now());
      throw new IdentityBrokerError(
        "identity_session_invalid",
        401,
        "The Eveland Identity Session is no longer active.",
      );
    }
    return { session, principal, realm };
  }

  async function issueCallerToken(input: {
    sessionToken: string;
    projectId: string;
    agentUrl?: string;
  }) {
    const resolved = await resolveSession(input.sessionToken);
    const project = await options.store.getProject(input.projectId);
    if (!project || project.deletionStatus) {
      throw new IdentityBrokerError(
        "identity_project_not_found",
        404,
        "The requested Project does not exist.",
      );
    }
    const current = now();
    const issuedAt = Math.floor(current.getTime() / 1_000);
    const expiresAt = new Date(current.getTime() + callerTokenTtlSeconds * 1_000);
    const payload = {
      iss: issuer,
      sub: resolved.principal.id,
      aud: callerTokenAudience(project.id),
      principal_type: "user",
      realm_id: resolved.realm.id,
      ...(resolved.principal.displayName ? { name: resolved.principal.displayName } : {}),
      ...(resolved.principal.email ? { email: resolved.principal.email } : {}),
      ...(input.agentUrl ? { agent_url: input.agentUrl } : {}),
      iat: issuedAt,
      nbf: issuedAt,
      exp: Math.floor(expiresAt.getTime() / 1_000),
      jti: randomBytes(16).toString("base64url"),
    };

    return {
      token: await signIdentityJwt(options, now, payload),
      expiresAt: expiresAt.toISOString(),
      principal: {
        id: resolved.principal.id,
        name: resolved.principal.displayName,
      },
    };
  }

  /**
   * Mints a Caller Token under whichever Provider the platform currently runs,
   * without an Identity Session.
   *
   * Deliberately not a wrapper around issueCallerToken: that function starts by
   * resolving a session and derives `sub` from the Principal behind it, which
   * is exactly the authorization step these callers do not have. Keeping the
   * two apart means a caller of this function can never be handed a token for
   * somebody else's Principal, and this path cannot drift into accepting a
   * session token it should ignore. Each caller instead states which identity
   * it has already established by other means, and the Provider decides
   * whether that is enough.
   */
  async function mintPlatformCallerToken(input: {
    projectId: string;
    /**
     * The control-plane user behind the request, where one exists. The
     * Playground has an authenticated platform user; the Gateway, forwarding
     * anonymous public traffic, has nobody.
     */
    controlPlaneUser: {
      externalSubject: string;
      displayName: string | null;
      email: string | null;
    } | null;
  }) {
    const provider = (await options.store.listIdentityProviderConnections()).find(
      (candidate) => candidate.enabled,
    );
    if (!provider) {
      throw new IdentityBrokerError(
        "identity_provider_selection_required",
        503,
        "No Eveland Identity Provider is enabled.",
      );
    }
    // Settled before the Project is looked up: anonymous public traffic has no
    // identity an authenticating Provider would vouch for, whatever Project it
    // was addressed to. Reported as "open access is inactive" because that is
    // the state the Gateway acts on -- stop injecting, and stop asking. Leaving
    // it until after the Project lookup would make that signal depend on the
    // Project existing.
    if (!input.controlPlaneUser && provider.type !== "open") {
      throw new IdentityBrokerError(
        "identity_open_access_inactive",
        409,
        "Open access is not the enabled Identity Provider.",
      );
    }
    const project = await options.store.getProject(input.projectId);
    if (!project || project.deletionStatus) {
      throw new IdentityBrokerError(
        "identity_project_not_found",
        404,
        "The requested Project does not exist.",
      );
    }

    let realm: IdentityRealm;
    let principal: IdentityPrincipal;
    let ttlSeconds: number;
    if (provider.type === "open") {
      ({ realm, principal } = await ensureOpenSharedIdentity(options, provider));
      ttlSeconds = openCallerTokenTtlSeconds;
    } else if (provider.type === "internal" && input.controlPlaneUser) {
      ({ realm, principal } = await resolveInternalIdentityPrincipal(
        options,
        provider,
        input.controlPlaneUser,
      ));
      ttlSeconds = callerTokenTtlSeconds;
    } else {
      throw new IdentityBrokerError(
        "identity_provider_unavailable",
        503,
        "The enabled Identity Provider cannot mint Caller Tokens in this release.",
      );
    }

    const current = now();
    const issuedAt = Math.floor(current.getTime() / 1_000);
    const expiresAt = new Date(current.getTime() + ttlSeconds * 1_000);
    const payload = {
      iss: issuer,
      sub: principal.id,
      aud: callerTokenAudience(project.id),
      principal_type: "user",
      realm_id: realm.id,
      ...(principal.displayName ? { name: principal.displayName } : {}),
      ...(principal.email ? { email: principal.email } : {}),
      iat: issuedAt,
      nbf: issuedAt,
      exp: Math.floor(expiresAt.getTime() / 1_000),
      jti: randomBytes(16).toString("base64url"),
    };
    return {
      token: await signIdentityJwt(options, now, payload),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** The Gateway's entry point: anonymous public traffic, open access only. */
  async function issueOpenModeCallerToken(input: { projectId: string }) {
    return mintPlatformCallerToken({ projectId: input.projectId, controlPlaneUser: null });
  }

  async function issueAppToken(input: { sessionToken: string; targetKey: string; origin: string }) {
    const resolved = await resolveSession(input.sessionToken);
    const target = await options.store.getIdentityReturnTargetByKey(input.targetKey);
    if (!target?.enabled || target.origin !== input.origin) {
      throw new IdentityBrokerError(
        "identity_return_target_invalid",
        403,
        "This origin cannot receive an Eveland app token.",
      );
    }
    const current = now();
    const issuedAt = Math.floor(current.getTime() / 1_000);
    const expiresAt = new Date(current.getTime() + appTokenTtlSeconds * 1_000);
    const payload = {
      iss: issuer,
      sub: resolved.principal.id,
      aud: identityAppTokenAudience(target.key),
      principal_type: "user",
      realm_id: resolved.realm.id,
      iat: issuedAt,
      nbf: issuedAt,
      exp: Math.floor(expiresAt.getTime() / 1_000),
      jti: randomBytes(16).toString("base64url"),
    };
    return {
      token: await signIdentityJwt(options, now, payload),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async function getJwks() {
    const current = now().getTime();
    const keys = (await options.store.listIdentitySigningKeys())
      .filter(
        (key) =>
          (key.status === "active" || key.status === "retiring") &&
          new Date(key.expiresAt).getTime() > current,
      )
      .map((key) => ({
        ...key.publicJwk,
        kid: key.id,
        alg: key.algorithm,
        use: "sig",
      }));
    return { keys };
  }

  async function resolveReturnTarget(targetKey: string, returnPath: string) {
    assertRelativeReturnPath(returnPath);
    const target = await options.store.getIdentityReturnTargetByKey(targetKey);
    if (!target?.enabled) {
      throw new IdentityBrokerError(
        "identity_return_target_invalid",
        400,
        "The Identity return target is not registered.",
      );
    }
    let origin: URL;
    try {
      origin = new URL(target.origin);
    } catch {
      throw new IdentityBrokerError(
        "identity_return_target_invalid",
        400,
        "The Identity return target is invalid.",
      );
    }
    return new URL(returnPath, `${origin.origin}/`).toString();
  }

  return {
    finalizeIdentity,
    beginOidcLogin,
    completeOidcLogin,
    resolveSession,
    issueCallerToken,
    issueOpenModeCallerToken,
    mintPlatformCallerToken,
    issueAppToken,
    getJwks,
    resolveReturnTarget,
  };
}

/**
 * Sealing for the OIDC client secret at rest. The API's admin routes seal on
 * write and the broker opens on use, so the derivation lives here once; the
 * context string keeps the key separate from every other APP_SECRET_KEY use.
 */
export function sealIdentityProviderSecret(value: string, appSecretKey: string): string {
  return JSON.stringify(
    encryptSecretValue(value, identityContextKey(appSecretKey, "provider-secret")),
  );
}

export function openIdentityProviderSecret(sealed: string, appSecretKey: string): string {
  return decryptSecretValue(
    JSON.parse(sealed) as Parameters<typeof decryptSecretValue>[0],
    identityContextKey(appSecretKey, "provider-secret"),
  );
}

export function sealOidcCredentialValue(value: string, appSecretKey: string): string {
  return JSON.stringify(
    encryptSecretValue(value, identityContextKey(appSecretKey, "oidc-credential")),
  );
}

export function openOidcCredentialValue(sealed: string, appSecretKey: string): string {
  return decryptSecretValue(
    JSON.parse(sealed) as Parameters<typeof decryptSecretValue>[0],
    identityContextKey(appSecretKey, "oidc-credential"),
  );
}

function identityContextKey(appSecretKey: string, context: string): string {
  return createHmac("sha256", appSecretKey)
    .update(`eveland:identity:${context}:v1`)
    .digest("base64");
}

/**
 * Materializes open access's shared Realm and Principal on first use. A fresh
 * install gets the Realm from the migration seed, but an instance that switched
 * to open access through the UI has only the Provider row -- and both must end
 * up with the same Realm key so a later switch back and forth does not fork the
 * shared identity into two `iprn_`s.
 */
async function ensureOpenSharedIdentity(
  options: IdentityBrokerOptions,
  provider: IdentityProviderConnection,
) {
  const realm =
    (await options.store.getIdentityRealmByExternalId(provider.id, OPEN_SHARED_REALM_KEY)) ??
    (await options.store.createIdentityRealm({
      providerConnectionId: provider.id,
      externalRealmId: OPEN_SHARED_REALM_KEY,
      externalRealmKind: "internal",
      displayName: "Open access",
      enabled: true,
    }));
  if (!realm.enabled) {
    throw new IdentityBrokerError(
      "identity_realm_not_allowed",
      403,
      "The open access Realm is disabled.",
    );
  }
  const principal = await options.store.upsertIdentityPrincipal({
    identityRealmId: realm.id,
    externalSubject: OPEN_SHARED_SUBJECT,
    displayName: null,
    email: null,
    claims: {},
  });
  return { realm, principal };
}

/**
 * Resolves the Eveland Internal Principal for a control-plane user. Mirrors
 * finalizeIdentity's Realm and Principal resolution but creates no Identity
 * Session: the Playground already has the user authenticated to the control
 * plane, so a second long-lived session row would be state nobody reads.
 */
async function resolveInternalIdentityPrincipal(
  options: IdentityBrokerOptions,
  provider: IdentityProviderConnection,
  user: { externalSubject: string; displayName: string | null; email: string | null },
) {
  if (!provider.internalRealmKey) {
    throw new IdentityBrokerError(
      "identity_provider_invalid",
      503,
      "The Eveland Internal Provider has no Realm key.",
    );
  }
  const realm = await options.store.getIdentityRealmByExternalId(
    provider.id,
    provider.internalRealmKey,
  );
  if (!realm?.enabled || realm.externalRealmKind !== "internal") {
    throw new IdentityBrokerError(
      "identity_realm_not_allowed",
      403,
      "This identity scope is not allowed.",
    );
  }
  const principal = await options.store.upsertIdentityPrincipal({
    identityRealmId: realm.id,
    externalSubject: requiredIdentityValue(user.externalSubject, "External subject"),
    displayName: optionalIdentityValue(user.displayName),
    email: optionalIdentityValue(user.email),
    claims: {},
  });
  return { realm, principal };
}

async function signIdentityJwt(
  options: IdentityBrokerOptions,
  now: () => Date,
  payload: Record<string, unknown>,
): Promise<string> {
  const key = await ensureActiveSigningKey(options, now());
  const encodedHeader = encodeJson({
    alg: "ES256",
    typ: "JWT",
    kid: key.id,
  });
  const encodedPayload = encodeJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const privateKey = openPrivateKey(key.privateKeyEncrypted, options.appSecretKey, key.id);
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${signingInput}.${signature}`;
}

export function hashIdentityToken(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}`;
}

function assertRelativeReturnPath(value: string): void {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new IdentityBrokerError(
      "identity_return_target_invalid",
      400,
      "Identity return path must be a safe relative path.",
    );
  }
}

async function ensureActiveSigningKey(options: IdentityBrokerOptions, current: Date) {
  const existing = await options.store.getActiveIdentitySigningKey(current);
  if (existing) return existing;
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const id = `isky_${randomBytes(10).toString("base64url")}`;
  const publicJwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return options.store.createIdentitySigningKey({
    id,
    algorithm: "ES256",
    publicJwk: { ...publicJwk, kid: id, alg: "ES256", use: "sig" },
    privateKeyEncrypted: sealPrivateKey(privatePem, options.appSecretKey, id),
    status: "active",
    notBefore: new Date(current.getTime() - 1_000),
    expiresAt: new Date(current.getTime() + 90 * 24 * 60 * 60 * 1_000),
  });
}

function sealPrivateKey(value: string, appSecretKey: string, keyId: string): string {
  const key = identitySigningEncryptionKey(appSecretKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`eveland:identity:signing-key:v1:${keyId}`));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return JSON.stringify({
    version: 1,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  });
}

function openPrivateKey(value: string, appSecretKey: string, keyId: string): string {
  const parsed = JSON.parse(value) as {
    version: number;
    iv: string;
    authTag: string;
    ciphertext: string;
  };
  if (parsed.version !== 1) throw new Error("Unsupported Identity signing key.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    identitySigningEncryptionKey(appSecretKey),
    Buffer.from(parsed.iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(`eveland:identity:signing-key:v1:${keyId}`));
  decipher.setAuthTag(Buffer.from(parsed.authTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

// Same strength rule as every other APP_SECRET_KEY consumer (core/server
// secrets, agent-auth sealed credential/config/transaction): 32 utf8 bytes,
// or base64 of a 32-byte value.
function assertStrongAppSecretKey(appSecretKey: string): void {
  const utf8 = Buffer.from(appSecretKey, "utf8");
  if (utf8.length === 32) return;
  const decoded = Buffer.from(appSecretKey, "base64");
  if (decoded.length === 32) return;
  throw new Error("APP_SECRET_KEY must be 32 bytes or a base64 encoded 32-byte value.");
}

function identitySigningEncryptionKey(appSecretKey: string): Buffer {
  // Deliberately derives from the raw string (not the base64-decoded bytes
  // like the other envelope homes): v1 signing-key envelopes were sealed this
  // way, and changing the derivation input would orphan every persisted
  // Identity signing key. Normalize only alongside a versioned envelope
  // migration when the sealed-envelope implementations are unified.
  return createHmac("sha256", appSecretKey).update("eveland:identity:signing-key:v1").digest();
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function requiredIdentityValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new IdentityBrokerError(
      "identity_provider_response_invalid",
      401,
      `${label} is missing from the verified provider identity.`,
    );
  }
  return normalized;
}

function optionalIdentityValue(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
