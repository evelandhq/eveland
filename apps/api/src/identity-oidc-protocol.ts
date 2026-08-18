import type { OidcAuthorizationCodeConfig } from "@evelandhq/agent-auth";
import { createOpenIdClientProtocol } from "@evelandhq/agent-auth/oidc";
import type { IdentityOidcProtocol, IdentityOidcProviderConfig } from "@evelandhq/identity-broker";

/**
 * Adapts agent-auth's hardened openid-client wrapper (safe fetch, endpoint
 * validation, PKCE, nonce, mandatory ID token) into the Identity Broker's
 * protocol port. The broker's import-boundary pin (core + db only) is why the
 * adapter lives here in the composition root rather than in either package.
 */
export function createIdentityOidcProtocol(
  options: { allowInsecureIssuer?: boolean } = {},
): IdentityOidcProtocol {
  const protocol = createOpenIdClientProtocol(options);
  const toConfig = (config: IdentityOidcProviderConfig): OidcAuthorizationCodeConfig => ({
    issuer: config.issuer,
    clientId: config.clientId,
    scopes: config.scopes,
    tokenEndpointAuthMethod: config.tokenEndpointAuthMethod,
    authorizationParams: config.authorizationParameters,
    // Agent-auth's post-exchange access-token probe; identity logins verify
    // the ID token inside the exchange and never take that code path.
    accessTokenVerification: "userinfo",
  });
  return {
    buildAuthorizationUrl(config, clientSecret, transaction) {
      return protocol.buildAuthorizationUrl(toConfig(config), clientSecret, transaction);
    },
    async exchangeAuthorizationCode(config, clientSecret, transaction, callbackUrl) {
      const tokens = await protocol.exchangeAuthorizationCode(
        toConfig(config),
        clientSecret,
        transaction,
        callbackUrl,
      );
      return {
        claims: tokens.claims ?? {},
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
        accessTokenExpiresAt: tokens.expiresAt,
      };
    },
    async fetchUserinfoClaims(config, clientSecret, accessToken, expectedSubject) {
      const result = await protocol.fetchUserInfo(
        toConfig(config),
        clientSecret,
        accessToken,
        expectedSubject,
      );
      return result.claims ?? { sub: result.subject };
    },
    async discoverMetadata(config, clientSecret) {
      if (!protocol.discoverMetadata) {
        throw new Error("The OIDC protocol implementation exposes no discovery metadata.");
      }
      return protocol.discoverMetadata(toConfig(config), clientSecret);
    },
  };
}
