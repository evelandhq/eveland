import type { IdentityProviderConnection } from "@evelandhq/core/identity";

/**
 * The configuration slice of an OIDC Identity Provider Connection that the
 * protocol layer needs. The broker never hands the protocol a client secret
 * inside this object; the secret travels as a separate argument so a logged
 * or serialized config can never leak it.
 */
export type IdentityOidcProviderConfig = {
  issuer: string;
  clientId: string;
  scopes: string[];
  tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post" | "none";
  authorizationParameters: Record<string, string>;
};

/** The per-login secrets minted at `/identity/login` and replayed at the callback. */
export type IdentityOidcTransaction = {
  redirectUri: string;
  state: string;
  nonce: string;
  codeVerifier: string;
};

/**
 * What a completed authorization code exchange yields. `claims` are the
 * verified ID token claims -- the protocol implementation is responsible for
 * signature, issuer, audience, and nonce validation before returning them.
 */
export type IdentityOidcTokens = {
  claims: Record<string, unknown>;
  accessToken: string;
  refreshToken?: string;
  scope?: string;
  accessTokenExpiresAt: Date | null;
};

/**
 * The OIDC wire protocol as the Identity Broker consumes it. The broker owns
 * none of the HTTP: apps/api injects an implementation adapted from the
 * hardened openid-client wrapper in @evelandhq/agent-auth, and tests inject
 * fakes. Keeping the port here keeps openid-client out of this package's
 * dependency graph and the import boundary map unchanged.
 */
export type IdentityOidcProtocol = {
  buildAuthorizationUrl(
    config: IdentityOidcProviderConfig,
    clientSecret: string | undefined,
    transaction: IdentityOidcTransaction,
  ): Promise<URL>;
  exchangeAuthorizationCode(
    config: IdentityOidcProviderConfig,
    clientSecret: string | undefined,
    transaction: IdentityOidcTransaction,
    callbackUrl: URL,
  ): Promise<IdentityOidcTokens>;
  fetchUserinfoClaims(
    config: IdentityOidcProviderConfig,
    clientSecret: string | undefined,
    accessToken: string,
    expectedSubject: string,
  ): Promise<Record<string, unknown>>;
  discoverMetadata(
    config: IdentityOidcProviderConfig,
    clientSecret: string | undefined,
  ): Promise<Record<string, unknown>>;
};

export function oidcProviderConfig(
  connection: IdentityProviderConnection,
): IdentityOidcProviderConfig {
  if (
    connection.type !== "oidc" ||
    !connection.issuer ||
    !connection.clientId ||
    !connection.tokenEndpointAuthMethod
  ) {
    throw new Error("The Identity Provider Connection is not a configured OIDC provider.");
  }
  return {
    issuer: connection.issuer,
    clientId: connection.clientId,
    scopes: connection.scopes,
    tokenEndpointAuthMethod: connection.tokenEndpointAuthMethod,
    authorizationParameters: connection.authorizationParameters,
  };
}

/**
 * JWT and OIDC protocol plumbing that would only restate the login mechanics
 * on every Principal row. Everything else the IdP asserts about the person
 * (name, email, picture, a provider's account_role, ...) is worth keeping.
 */
const PROTOCOL_CLAIMS = new Set([
  "iss",
  "aud",
  "exp",
  "iat",
  "nbf",
  "auth_time",
  "nonce",
  "azp",
  "at_hash",
  "c_hash",
  "s_hash",
  "sid",
  "jti",
]);

const MAX_STORED_CLAIM_LENGTH = 2_048;

/**
 * The subset of verified claims a Principal row stores: string or
 * string-array values, minus protocol plumbing and anything so long it reads
 * as a payload rather than an attribute.
 */
export function principalClaims(
  claims: Record<string, unknown>,
): Record<string, string | readonly string[]> {
  const kept: Record<string, string | readonly string[]> = {};
  for (const [key, value] of Object.entries(claims)) {
    if (PROTOCOL_CLAIMS.has(key)) continue;
    if (typeof value === "string" && value.length <= MAX_STORED_CLAIM_LENGTH) {
      kept[key] = value;
    } else if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((entry) => typeof entry === "string" && entry.length <= MAX_STORED_CLAIM_LENGTH)
    ) {
      kept[key] = value as string[];
    }
  }
  return kept;
}

export function stringClaim(claims: Record<string, unknown>, key: string): string | undefined {
  const value = claims[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
