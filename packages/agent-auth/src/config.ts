import { isReservedCredentialHeader } from "@eveland/core/agent-auth";
import { openAgentAuthValue, sealAgentAuthValue } from "./sealed-value.js";

export type AgentAuthConfigBinding = {
  agentConnectionId: string;
  method: string;
  securityRevision: number;
};

export type OidcAuthorizationCodeConfig = {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /**
   * Identifier of the target Agent, minted into the access token's `aud`.
   * Absent means the identity provider does no audience binding (opaque
   * access tokens): no RFC 8707 `resource` parameter is sent and the access
   * token is verified against the UserInfo endpoint instead of as a JWT.
   */
  audience?: string;
  audienceMode?: "resource" | "audience" | "both";
  scopes: string[];
  promptConsent: boolean;
  /** @internal Read compatibility for Connections saved before client auth became derived. */
  legacyTokenEndpointAuthMethod?: "client_secret_post" | "none";
};

export const JINSHUJU_OIDC_METHOD = "jinshuju-oidc";

type JinshujuOidcEnvironment = Partial<Record<
  | "JINSHUJU_OIDC_ISSUER"
  | "JINSHUJU_OIDC_CLIENT_ID"
  | "JINSHUJU_OIDC_CLIENT_SECRET"
  | "JINSHUJU_OIDC_SCOPES",
  string | undefined
>>;

export function sealAgentAuthConfig(config: unknown, appSecretKey: string, binding: AgentAuthConfigBinding): string {
  return sealAgentAuthValue(config, appSecretKey, "config", configAad(binding));
}

export function openAgentAuthConfig(value: string, appSecretKey: string, binding: AgentAuthConfigBinding): unknown {
  return openAgentAuthValue<unknown>(value, appSecretKey, "config", configAad(binding));
}

function configAad(binding: AgentAuthConfigBinding): readonly unknown[] {
  return [binding.agentConnectionId, binding.method, binding.securityRevision];
}

export function normalizeAgentAuthConfig(method: string, value: unknown): Record<string, unknown> {
  const config = record(value, "Agent Auth config must be an object.");
  if (method === "local-dev" || method === "none" || method === JINSHUJU_OIDC_METHOD) return {};
  if (method === "bearer") return { token: requiredString(config.token, "Bearer token is required.") };
  if (method === "basic") {
    const username = requiredString(config.username, "Basic username is required.");
    if (username.includes(":")) throw new Error("Basic username must not contain a colon.");
    return { username, password: requiredString(config.password, "Basic password is required.") };
  }
  if (method === "headers") {
    const headers = record(config.headers, "Custom credential headers must be an object.");
    return {
      headers: Object.fromEntries(
        Object.entries(headers).map(([name, headerValue]) => {
          assertAllowedAgentCredentialHeader(name);
          return [name, requiredString(headerValue, `Header ${name} must be a string.`)];
        }),
      ),
    };
  }
  if (method === "oidc") return normalizeOidcAuthorizationCodeConfig(config);
  throw new Error(`Unsupported Agent Auth Method: ${method}.`);
}

export function redactAgentAuthConfig(method: string, config: Record<string, unknown>): Record<string, unknown> {
  if (method === "local-dev" || method === "none" || method === JINSHUJU_OIDC_METHOD) return {};
  if (method === "bearer") return { tokenConfigured: typeof config.token === "string" && config.token.length > 0 };
  if (method === "basic") {
    return {
      username: typeof config.username === "string" ? config.username : "",
      passwordConfigured: typeof config.password === "string" && config.password.length > 0,
    };
  }
  if (method === "headers") {
    const headers = config.headers;
    if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return { headerNames: [] };
    return { headerNames: Object.keys(headers).map((name) => name.toLowerCase()).sort() };
  }
  if (method === "oidc") {
    const oidc = config as unknown as OidcAuthorizationCodeConfig;
    return {
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      clientSecretConfigured: typeof oidc.clientSecret === "string" && oidc.clientSecret.length > 0,
      ...(oidc.audience === undefined ? {} : { audience: oidc.audience, audienceMode: oidc.audienceMode }),
      scopes: oidc.scopes,
      promptConsent: oidc.promptConsent,
    };
  }
  return {};
}

export function normalizeOidcAuthorizationCodeConfig(config: Record<string, unknown>): OidcAuthorizationCodeConfig {
  const issuer = requiredString(config.issuer, "OIDC issuer is required.").replace(/\/$/, "");
  const clientId = requiredString(config.clientId, "OIDC client ID is required.");
  const clientSecret = config.clientSecret === undefined ? undefined : requiredString(config.clientSecret, "OIDC client secret must not be empty.");
  let audienceConfig: Pick<OidcAuthorizationCodeConfig, "audience" | "audienceMode"> = {};
  if (config.audience !== undefined) {
    const audience = requiredString(config.audience, "OIDC audience must be a non-empty string.");
    const audienceMode = config.audienceMode ?? "resource";
    if (audienceMode !== "resource" && audienceMode !== "audience" && audienceMode !== "both") {
      throw new Error("Unsupported OIDC audience mode.");
    }
    audienceConfig = { audience, audienceMode };
  } else if (config.audienceMode !== undefined) {
    throw new Error("OIDC audience mode requires an audience.");
  }
  const configuredScopes = config.scopes ?? ["openid", "offline_access"];
  if (!Array.isArray(configuredScopes) || configuredScopes.some((scope) => typeof scope !== "string" || !scope.trim())) {
    throw new Error("OIDC scopes must be a list of non-empty strings.");
  }
  const scopes = [...new Set(configuredScopes.map((scope) => scope.trim()))];
  if (!scopes.includes("openid")) scopes.unshift("openid");
  return {
    issuer,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    ...audienceConfig,
    scopes,
    promptConsent: config.promptConsent === undefined ? true : config.promptConsent === true,
  };
}

export function normalizeStoredOidcAuthorizationCodeConfig(config: Record<string, unknown>): OidcAuthorizationCodeConfig {
  const normalized = normalizeOidcAuthorizationCodeConfig(config);
  const legacyMethod = config.tokenEndpointAuthMethod;
  if (legacyMethod !== "client_secret_post" && legacyMethod !== "none") return normalized;
  if (legacyMethod === "client_secret_post" && !normalized.clientSecret) {
    throw new Error("OIDC client secret is required for legacy client_secret_post authentication.");
  }
  return { ...normalized, legacyTokenEndpointAuthMethod: legacyMethod };
}

export function resolveJinshujuOidcConfig(env: JinshujuOidcEnvironment): OidcAuthorizationCodeConfig {
  const scopes = requiredString(
    env.JINSHUJU_OIDC_SCOPES,
    "JINSHUJU_OIDC_SCOPES is required.",
  ).trim().split(/\s+/);
  const clientSecret = env.JINSHUJU_OIDC_CLIENT_SECRET;
  return normalizeOidcAuthorizationCodeConfig({
    issuer: requiredString(env.JINSHUJU_OIDC_ISSUER, "JINSHUJU_OIDC_ISSUER is required."),
    clientId: requiredString(env.JINSHUJU_OIDC_CLIENT_ID, "JINSHUJU_OIDC_CLIENT_ID is required."),
    ...(clientSecret ? { clientSecret } : {}),
    scopes,
  });
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(message);
  return value;
}

export function assertAllowedAgentCredentialHeader(name: string): void {
  const normalized = name.toLowerCase();
  if (isReservedCredentialHeader(name) || normalized === "authorization" || normalized === "cookie") {
    throw new Error(`Agent credential header ${normalized} is not allowed.`);
  }
}
