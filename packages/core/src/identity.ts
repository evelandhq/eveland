export type IdentityProviderType = "internal" | "oidc";

export type ExternalRealmKind =
  | "internal"
  | "account"
  | "corp"
  | "workspace"
  | "enterprise"
  | "tenant"
  | "organization";

export type ResolvedExternalIdentity = {
  externalRealmId: string;
  externalRealmKind: ExternalRealmKind;
  externalSubject: string;
  displayName?: string;
  email?: string;
};

export type InternalIdentityProviderConfig = {
  type: "internal";
  displayName: string;
  internalRealmKey: string;
  enabled: boolean;
};

/** How an OIDC provider resolves a caller's external Realm. */
export type OidcExternalRealmResolution =
  | "connection"
  | "id_token_claim"
  | "userinfo_claim"
  | "provider_api";

/**
 * Every resolution mode a persisted Identity Provider Connection can carry.
 * Wider than OidcExternalRealmResolution by `internal_member`, which only the
 * internal provider uses. Persistence contracts reference this name rather
 * than re-spelling the union, so a new mode cannot be added to the record
 * type while a store's input type silently rejects it.
 */
export type ExternalRealmResolution = OidcExternalRealmResolution | "internal_member";

export type OidcIdentityProviderConfig = {
  type: "oidc";
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecretConfigured: boolean;
  scopes: string[];
  authorizationParameters: Record<string, string>;
  tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post" | "none";
  externalRealmResolution: OidcExternalRealmResolution;
  externalRealmClaim?: string;
  enabled: boolean;
};

export type IdentityProviderConfig = InternalIdentityProviderConfig | OidcIdentityProviderConfig;

export type IdentityProviderConnection = {
  id: string;
  type: IdentityProviderType;
  displayName: string;
  internalRealmKey: string | null;
  issuer: string | null;
  clientId: string | null;
  clientSecretEncrypted: string | null;
  scopes: string[];
  authorizationParameters: Record<string, string>;
  tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post" | "none" | null;
  externalRealmResolution: ExternalRealmResolution;
  externalRealmClaim: string | null;
  enabled: boolean;
  securityRevision: number;
  createdAt: string;
  updatedAt: string;
};

export type IdentityRealm = {
  id: string;
  providerConnectionId: string;
  externalRealmId: string;
  externalRealmKind: ExternalRealmKind;
  displayName: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type IdentityPrincipal = {
  id: string;
  identityRealmId: string;
  externalSubject: string;
  displayName: string | null;
  email: string | null;
  claims: Record<string, string | readonly string[]>;
  createdAt: string;
  updatedAt: string;
};

export type IdentitySession = {
  id: string;
  tokenHash: string;
  identityPrincipalId: string;
  activeIdentityRealmId: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  createdAt: string;
};

export type IdentityLoginTransaction = {
  stateHash: string;
  providerConnectionId: string;
  providerSecurityRevision: number;
  returnTargetId: string;
  returnPath: string;
  nonceHash: string | null;
  pkceVerifierEncrypted: string | null;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
};

export type IdentityReturnTarget = {
  id: string;
  key: string;
  origin: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type IdentityOidcCredential = {
  identityPrincipalId: string;
  providerConnectionId: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
  scope: string;
  accessTokenExpiresAt: string | null;
  rotationSeq: number;
  updatedAt: string;
};

export type IdentitySigningKeyStatus = "active" | "retiring" | "retired";

export type IdentitySigningKey = {
  id: string;
  algorithm: "ES256";
  publicJwk: Record<string, unknown>;
  privateKeyEncrypted: string;
  status: IdentitySigningKeyStatus;
  notBefore: string;
  expiresAt: string;
  createdAt: string;
};

export function normalizeIdentityProviderConnection(
  input: Record<string, unknown>,
): IdentityProviderConfig {
  const type = input.type;
  const displayName = requiredString(input.displayName, "Display name is required.");
  const enabled = input.enabled === true;

  if (type === "internal") {
    return {
      type,
      displayName,
      internalRealmKey: requiredString(input.internalRealmKey, "Internal Realm key is required."),
      enabled,
    };
  }
  if (type !== "oidc") throw new Error("Identity provider type must be internal or oidc.");

  const issuer = normalizeHttpsIssuer(input.issuer);
  const clientId = requiredString(input.clientId, "OIDC Client ID is required.");
  const scopes = uniqueStrings(input.scopes, "OIDC scopes are required.");
  if (!scopes.includes("openid")) throw new Error("OIDC scopes must include openid.");
  const tokenEndpointAuthMethod = oneOf(
    input.tokenEndpointAuthMethod,
    ["client_secret_basic", "client_secret_post", "none"] as const,
    "OIDC token endpoint authentication method is invalid.",
  );
  const externalRealmResolution = oneOf(
    input.externalRealmResolution,
    ["connection", "id_token_claim", "userinfo_claim", "provider_api"] as const,
    "OIDC external Realm resolution is invalid.",
  );
  const externalRealmClaim =
    externalRealmResolution === "id_token_claim" || externalRealmResolution === "userinfo_claim"
      ? requiredString(
          input.externalRealmClaim,
          "OIDC external Realm claim is required for claim resolution.",
        )
      : undefined;

  return {
    type,
    displayName,
    issuer,
    clientId,
    clientSecretConfigured: input.clientSecretConfigured === true,
    scopes,
    authorizationParameters: stringRecord(input.authorizationParameters),
    tokenEndpointAuthMethod,
    externalRealmResolution,
    ...(externalRealmClaim ? { externalRealmClaim } : {}),
    enabled,
  };
}

export function callerTokenAudience(projectId: string): string {
  const normalized = requiredString(projectId, "Project ID is required.");
  return `eveland:project:${normalized}`;
}

export function identityAppTokenAudience(targetKey: string): string {
  const normalized = requiredString(targetKey, "Identity return target key is required.");
  return `eveland:app:${normalized}`;
}

export function parseCallerTokenAudience(audience: string): string | null {
  const prefix = "eveland:project:";
  if (!audience.startsWith(prefix)) return null;
  const projectId = audience.slice(prefix.length);
  return projectId.length > 0 ? projectId : null;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(message);
  return value.trim();
}

function normalizeHttpsIssuer(value: unknown): string {
  const raw = requiredString(value, "OIDC issuer is required.");
  let issuer: URL;
  try {
    issuer = new URL(raw);
  } catch {
    throw new Error("OIDC issuer must be a valid HTTPS URL.");
  }
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash
  ) {
    throw new Error("OIDC issuer must be a valid HTTPS URL.");
  }
  return issuer.toString().replace(/\/$/, "");
}

function uniqueStrings(value: unknown, message: string): string[] {
  if (!Array.isArray(value)) throw new Error(message);
  const strings = value.map((candidate) => requiredString(candidate, message));
  const unique = [...new Set(strings)];
  if (unique.length === 0) throw new Error(message);
  return unique;
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OIDC authorization parameters must be an object.");
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, candidate]) => [
        requiredString(key, "OIDC authorization parameter name is required."),
        requiredString(candidate, `OIDC authorization parameter ${key} must be a string.`),
      ]),
  );
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  message: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(message);
  return value as T[number];
}
