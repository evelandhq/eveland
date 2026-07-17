import {
  parseAgentCredentialHeaders,
  type AgentAuthEnvelope,
  type AgentAuthMethodDescriptor,
} from "@eveland/core/agent-auth";

export type AgentAuthProviderRegistration = {
  method: string;
  descriptor: AgentAuthMethodDescriptor;
  credentialScope: "connection" | "principal";
  authority: "loopback" | "canonical";
  normalizeConfig(input: unknown, existing?: unknown): unknown;
  redactConfig(config: unknown): Record<string, unknown>;
  getCredential(context: { config: unknown; callerPrincipalId: string }): Promise<AgentAuthEnvelope>;
};

export type OidcAuthorizationCodeConfig = {
  issuer: string;
  clientId: string;
  clientSecretRef?: { kind: "project-secret"; key: string };
  scopes: string[];
  audience?: string;
  audienceMode?: "resource" | "audience" | "both";
  tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post" | "none";
  authorizationParams?: Record<string, string>;
  accessTokenVerification: "eve-jwt" | "userinfo";
};

export type AgentAuthRegistry = {
  get(method: string): AgentAuthProviderRegistration | null;
  listDescriptors(): AgentAuthMethodDescriptor[];
};

export function createAgentAuthRegistry(extensions: AgentAuthProviderRegistration[] = []): AgentAuthRegistry {
  const providers = new Map<string, AgentAuthProviderRegistration>();
  for (const provider of [...builtinProviders, ...extensions]) {
    validateProvider(provider, providers);
    providers.set(provider.method, provider);
  }
  return {
    get(method) {
      return providers.get(method) ?? null;
    },
    listDescriptors() {
      return [...providers.values()].map(({ descriptor }) => ({
        ...descriptor,
        fields: descriptor.fields.map((field) => ({
          ...field,
          ...(field.options ? { options: field.options.map((option) => ({ ...option })) } : {}),
        })),
      }));
    },
  };
}

export function agentAuthConfigsEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

const builtinProviders: AgentAuthProviderRegistration[] = [
  noCredentialProvider(
    "local-dev",
    "Local development",
    "Use Eve's loopback-only local development identity without a credential.",
    "loopback",
  ),
  noCredentialProvider(
    "none",
    "No authentication",
    "Call the canonical Agent route without a credential.",
    "canonical",
  ),
  {
    method: "basic",
    descriptor: {
      method: "basic",
      label: "HTTP Basic",
      description: "Send a configured username and password using HTTP Basic authentication.",
      credentialScope: "connection",
      interactive: false,
      fields: [
        { key: "username", label: "Username", input: "text", required: true, secret: false, valueType: "string" },
        { key: "password", label: "Password", input: "password", required: true, secret: true, valueType: "string" },
      ],
    },
    credentialScope: "connection",
    authority: "canonical",
    normalizeConfig(input, existing) {
      const next = record(input, "HTTP Basic configuration must be an object.");
      const previous = optionalRecord(existing);
      const username = requiredString(next.username ?? previous?.username, "Basic username is required.");
      if (username.includes(":")) throw new Error("Basic username must not contain a colon.");
      const password = requiredString(next.password ?? previous?.password, "Basic password is required.");
      return { username, password };
    },
    redactConfig(config) {
      const value = optionalRecord(config);
      return {
        username: typeof value?.username === "string" ? value.username : "",
        passwordConfigured: typeof value?.password === "string" && value.password.length > 0,
      };
    },
    async getCredential({ config }) {
      const value = record(config, "Invalid HTTP Basic configuration.");
      const username = requiredString(value.username, "Basic username is required.");
      const password = requiredString(value.password, "Basic password is required.");
      return envelope("canonical", [["authorization", `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`]]);
    },
  },
  {
    method: "bearer",
    descriptor: {
      method: "bearer",
      label: "Bearer token",
      description: "Send an externally issued JWT or opaque access token as a Bearer credential.",
      credentialScope: "connection",
      interactive: false,
      fields: [{ key: "token", label: "Token", input: "password", required: true, secret: true, valueType: "string" }],
    },
    credentialScope: "connection",
    authority: "canonical",
    normalizeConfig(input, existing) {
      const next = record(input, "Bearer configuration must be an object.");
      const previous = optionalRecord(existing);
      return { token: requiredString(next.token ?? previous?.token, "Bearer token is required.") };
    },
    redactConfig(config) {
      const value = optionalRecord(config);
      return { tokenConfigured: typeof value?.token === "string" && value.token.length > 0 };
    },
    async getCredential({ config }) {
      const value = record(config, "Invalid Bearer configuration.");
      const token = requiredString(value.token, "Bearer token is required.").trim();
      if (!token) throw new Error("Bearer token is required.");
      return envelope("canonical", [["authorization", `Bearer ${token}`]]);
    },
  },
  {
    method: "oidc",
    descriptor: {
      method: "oidc",
      label: "OIDC Authorization Code",
      description: "Let each Playground caller authorize with the Agent's OIDC provider using Authorization Code and PKCE.",
      credentialScope: "principal",
      interactive: true,
      fields: [
        { key: "issuer", label: "Issuer", input: "text", required: true, secret: false, valueType: "string" },
        { key: "clientId", label: "Client ID", input: "text", required: true, secret: false, valueType: "string" },
        { key: "clientSecretKey", label: "Project Secret key", input: "text", required: false, secret: false, valueType: "string" },
        { key: "scopes", label: "Scopes", input: "text", required: true, secret: false, valueType: "string-list", defaultValue: "openid offline_access" },
        { key: "audience", label: "Audience", input: "text", required: false, secret: false, valueType: "string" },
        { key: "audienceMode", label: "Audience parameter mode", input: "select", required: false, secret: false, valueType: "string", options: [
          { value: "resource", label: "Resource indicator" },
          { value: "audience", label: "Audience parameter" },
          { value: "both", label: "Both parameters" },
        ] },
        { key: "tokenEndpointAuthMethod", label: "Token endpoint auth method", input: "select", required: true, secret: false, valueType: "string", defaultValue: "none", options: [
          { value: "client_secret_basic", label: "Client secret basic" },
          { value: "client_secret_post", label: "Client secret post" },
          { value: "none", label: "None (public client)" },
        ] },
        { key: "authorizationParams", label: "Additional authorization parameters (JSON)", input: "textarea", required: false, secret: false, valueType: "json-record" },
        { key: "accessTokenVerification", label: "Access token verification", input: "select", required: true, secret: false, valueType: "string", defaultValue: "userinfo", options: [
          { value: "eve-jwt", label: "Eve OIDC JWT verification" },
          { value: "userinfo", label: "OIDC UserInfo" },
        ] },
      ],
    },
    credentialScope: "principal",
    authority: "canonical",
    normalizeConfig(input, existing) {
      return normalizeOidcConfig(input, existing);
    },
    redactConfig(config) {
      const value = optionalRecord(config);
      const secretRef = optionalRecord(value?.clientSecretRef);
      return {
        issuer: value?.issuer,
        clientId: value?.clientId,
        clientSecretKey: secretRef?.key,
        clientSecretConfigured: typeof secretRef?.key === "string" && secretRef.key.length > 0,
        scopes: value?.scopes,
        ...(value?.audience === undefined ? {} : { audience: value.audience, audienceMode: value.audienceMode }),
        tokenEndpointAuthMethod: value?.tokenEndpointAuthMethod,
        authorizationParams: value?.authorizationParams,
        accessTokenVerification: value?.accessTokenVerification,
      };
    },
    async getCredential() {
      throw new Error("OIDC authorization is required before resolving a credential.");
    },
  },
  {
    method: "headers",
    descriptor: {
      method: "headers",
      label: "Custom headers",
      description: "Send configured credential headers for a custom Eve route AuthFn.",
      credentialScope: "connection",
      interactive: false,
      fields: [{ key: "headers", label: "Headers (JSON)", input: "textarea", required: true, secret: true, valueType: "json-record" }],
    },
    credentialScope: "connection",
    authority: "canonical",
    normalizeConfig(input, existing) {
      const next = record(input, "Custom header configuration must be an object.");
      const previous = optionalRecord(existing);
      const configured = record(next.headers ?? previous?.headers, "Custom credential headers must be an object.");
      const parsed = parseAgentCredentialHeaders(Object.entries(configured).map(([name, value]) => [
        name,
        requiredString(value, `Header ${name} must be a string.`),
      ]));
      return {
        headers: Object.fromEntries(parsed
          .map(([name, value]) => [name.toLowerCase(), value] as const)
          .sort(([left], [right]) => left.localeCompare(right))),
      };
    },
    redactConfig(config) {
      const headers = optionalRecord(optionalRecord(config)?.headers);
      return { headerNames: Object.keys(headers ?? {}).map((name) => name.toLowerCase()).sort() };
    },
    async getCredential({ config }) {
      const configured = record(record(config, "Invalid custom header configuration.").headers, "Custom credential headers must be an object.");
      return envelope("canonical", Object.entries(configured).map(([name, value]) => [
        name,
        requiredString(value, `Header ${name} must be a string.`),
      ]));
    },
  },
];

const reservedOidcAuthorizationParameters = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "audience",
  "nonce",
  "redirect_uri",
  "response_type",
  "resource",
  "scope",
  "state",
]);

function normalizeOidcConfig(input: unknown, existing?: unknown): OidcAuthorizationCodeConfig {
  const next = record(input, "OIDC configuration must be an object.");
  const previous = optionalRecord(existing);
  const issuer = normalizeHttpsIssuer(requiredString(next.issuer ?? previous?.issuer, "OIDC issuer is required."));
  const clientId = requiredString(next.clientId ?? previous?.clientId, "OIDC client ID is required.").trim();
  if (!clientId) throw new Error("OIDC client ID is required.");
  const tokenEndpointAuthMethod = oneOf(
    next.tokenEndpointAuthMethod ?? previous?.tokenEndpointAuthMethod ?? "none",
    ["client_secret_basic", "client_secret_post", "none"] as const,
    "Unsupported OIDC token endpoint auth method.",
  );
  const accessTokenVerification = oneOf(
    next.accessTokenVerification ?? previous?.accessTokenVerification ?? "userinfo",
    ["eve-jwt", "userinfo"] as const,
    "Unsupported OIDC access-token verification mode.",
  );
  const secretKeyInput = next.clientSecretKey;
  const previousSecretRef = optionalRecord(previous?.clientSecretRef);
  const secretKey = typeof secretKeyInput === "string" && secretKeyInput.trim()
    ? secretKeyInput.trim()
    : typeof previousSecretRef?.key === "string"
      ? previousSecretRef.key
      : undefined;
  if (secretKey && !/^[A-Z][A-Z0-9_]*$/.test(secretKey)) {
    throw new Error("OIDC Project Secret key must be an uppercase environment variable name.");
  }
  if (tokenEndpointAuthMethod !== "none" && !secretKey) {
    throw new Error(`OIDC ${tokenEndpointAuthMethod} authentication requires a client secret reference.`);
  }
  const configuredScopes = next.scopes ?? previous?.scopes ?? ["openid", "offline_access"];
  if (!Array.isArray(configuredScopes) || configuredScopes.some((scope) => typeof scope !== "string" || !scope.trim())) {
    throw new Error("OIDC scopes must be a list of non-empty strings.");
  }
  const uniqueScopes = new Set(configuredScopes.map((scope) => (scope as string).trim()));
  uniqueScopes.delete("openid");
  const scopes = ["openid", ...[...uniqueScopes].sort()];

  const audienceInput = next.audience ?? previous?.audience;
  const audience = audienceInput === undefined ? undefined : requiredString(audienceInput, "OIDC audience must not be empty.").trim();
  const audienceModeInput = next.audienceMode ?? previous?.audienceMode;
  if (!audience && audienceModeInput !== undefined) throw new Error("OIDC audience mode requires an audience.");
  const audienceMode = audience
    ? oneOf(audienceModeInput ?? "resource", ["resource", "audience", "both"] as const, "Unsupported OIDC audience mode.")
    : undefined;
  if (accessTokenVerification === "eve-jwt" && !audience) {
    throw new Error("OIDC eve-jwt access-token verification requires an audience.");
  }

  const authorizationParamsInput = next.authorizationParams ?? previous?.authorizationParams;
  const authorizationParams = authorizationParamsInput === undefined
    ? undefined
    : normalizeAuthorizationParams(authorizationParamsInput);
  return {
    issuer,
    clientId,
    ...(secretKey ? { clientSecretRef: { kind: "project-secret" as const, key: secretKey } } : {}),
    scopes,
    ...(audience ? { audience, audienceMode } : {}),
    tokenEndpointAuthMethod,
    ...(authorizationParams && Object.keys(authorizationParams).length > 0 ? { authorizationParams } : {}),
    accessTokenVerification,
  };
}

function normalizeHttpsIssuer(value: string): string {
  const issuer = new URL(value);
  if (issuer.protocol !== "https:") throw new Error("OIDC issuer must use HTTPS.");
  if (issuer.username || issuer.password || issuer.search || issuer.hash) {
    throw new Error("OIDC issuer must not contain userinfo, query, or fragment components.");
  }
  issuer.pathname = issuer.pathname.replace(/\/$/, "");
  return issuer.toString().replace(/\/$/, "");
}

function normalizeAuthorizationParams(value: unknown): Record<string, string> {
  const params = record(value, "OIDC authorization parameters must be an object.");
  return Object.fromEntries(Object.entries(params).sort(([left], [right]) => left.localeCompare(right)).map(([key, candidate]) => {
    if (reservedOidcAuthorizationParameters.has(key)) {
      throw new Error(`OIDC authorization parameter ${key} is managed by Eveland.`);
    }
    return [key, requiredString(candidate, `OIDC authorization parameter ${key} must be a string.`)];
  }));
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, message: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(message);
  return value as T[number];
}

function noCredentialProvider(
  method: string,
  label: string,
  description: string,
  authority: "loopback" | "canonical",
): AgentAuthProviderRegistration {
  return {
    method,
    descriptor: { method, label, description, credentialScope: "connection", interactive: false, fields: [] },
    credentialScope: "connection",
    authority,
    normalizeConfig(input) {
      record(input, `${label} configuration must be an object.`);
      return {};
    },
    redactConfig: () => ({}),
    async getCredential() {
      return envelope(authority, []);
    },
  };
}

function validateProvider(
  provider: AgentAuthProviderRegistration,
  existing: Map<string, AgentAuthProviderRegistration>,
): void {
  if (!/^[a-z][a-z0-9-]*$/.test(provider.method)) throw new Error(`Invalid Agent Auth Method: ${provider.method}.`);
  if (existing.has(provider.method)) throw new Error(`Duplicate Agent Auth Method: ${provider.method}.`);
  if (provider.descriptor.method !== provider.method) {
    throw new Error(`Agent Auth descriptor method must match provider ${provider.method}.`);
  }
  if (provider.descriptor.credentialScope !== provider.credentialScope) {
    throw new Error(`Agent Auth descriptor credential scope must match provider ${provider.method}.`);
  }
}

function envelope(authority: "loopback" | "canonical", input: unknown): AgentAuthEnvelope {
  return { version: 1, authority, headers: parseAgentCredentialHeaders(input) };
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(message);
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  const object = optionalRecord(value);
  if (!object) return value;
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, sortValue(object[key])]));
}
