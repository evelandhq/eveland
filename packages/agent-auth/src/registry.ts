import {
  parseAgentCredentialHeaders,
  type AgentAuthEnvelope,
  type AgentAuthMethodDescriptor,
  type AgentAuthSecretReference,
} from "@eveland/core/agent-auth";
import type { AgentConnection } from "@eveland/core/contracts";

// Eve 0.25.1's Client `vercelOidc` variant sends this Deployment Protection
// header alongside Authorization. It is declared in Eve's client/types module
// but is not re-exported from the public `eve/client` entry point.
const VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER = "x-vercel-trusted-oidc-idp-token";

export type AgentAuthFailure = {
  code: "interaction_required" | "configuration_invalid" | "provider_unavailable" | "credential_rejected" | "retry_required";
  method: string;
  message: string;
  interaction?: { type: "redirect"; url: string };
};

export type AgentAuthConnectionSnapshot = AgentConnection & { config: unknown };

export type AgentCredentialContext = {
  connection: AgentAuthConnectionSnapshot;
  callerPrincipalId: string;
  returnPath?: string;
  resolveSecret?: (reference: AgentAuthSecretReference) => Promise<string>;
};

export type AgentCredentialResolution =
  | { envelope: AgentAuthEnvelope; version?: unknown }
  | { failure: AgentAuthFailure };

export type UnauthorizedRecoveryResult =
  | { action: "retry" }
  | { action: "give_up"; failure: AgentAuthFailure };

export type AgentAuthInteractionHandler = {
  start(context: AgentCredentialContext & { returnPath: string }): Promise<{ authorizationUrl: string }>;
  callback(context: { search: string; callerPrincipalId: string }): Promise<{ returnPath: string }>;
};

export type AgentAuthProviderRegistration = {
  method: string;
  descriptor: AgentAuthMethodDescriptor;
  credentialScope: "connection" | "principal";
  authority: "loopback" | "canonical";
  normalizeConfig(input: unknown, existing?: unknown): unknown;
  redactConfig(config: unknown): Record<string, unknown>;
  preflight?(context: AgentCredentialContext): Promise<void>;
  getCredential(context: AgentCredentialContext): Promise<AgentCredentialResolution>;
  recoverUnauthorized?(context: AgentCredentialContext & {
    rejectedVersion: unknown;
    attempt: 0 | 1;
  }): Promise<UnauthorizedRecoveryResult>;
  interaction?: AgentAuthInteractionHandler;
};

export type OidcAuthorizationCodeConfig = {
  issuer: string;
  clientId: string;
  clientSecretRef?: AgentAuthSecretReference;
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
      return [...providers.values()].sort((left, right) => providerOrder(left.method) - providerOrder(right.method))
        .map(({ descriptor }) => ({
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
        {
          key: "password",
          label: "Password",
          input: "password",
          required: true,
          secret: true,
          valueType: "string",
          secretReferenceKey: "passwordRef",
        },
      ],
    },
    credentialScope: "connection",
    authority: "canonical",
    normalizeConfig(input, existing) {
      const next = record(input, "HTTP Basic configuration must be an object.");
      const previous = optionalRecord(existing);
      const username = requiredString(next.username ?? previous?.username, "Basic username is required.");
      if (username.includes(":")) throw new Error("Basic username must not contain a colon.");
      const referenceInput = next.passwordRef ?? (next.password === undefined ? previous?.passwordRef : undefined);
      if (referenceInput !== undefined) return { username, passwordRef: secretReference(referenceInput) };
      const password = requiredString(next.password ?? previous?.password, "Basic password is required.");
      return { username, password };
    },
    redactConfig(config) {
      const value = optionalRecord(config);
      return {
        username: typeof value?.username === "string" ? value.username : "",
        passwordConfigured:
          (typeof value?.password === "string" && value.password.length > 0) ||
          isSecretReference(value?.passwordRef),
      };
    },
    async getCredential({ connection: { config }, resolveSecret }) {
      const value = record(config, "Invalid HTTP Basic configuration.");
      const username = requiredString(value.username, "Basic username is required.");
      const password = await resolveConfiguredSecret(value, "password", "passwordRef", resolveSecret, "Basic password is required.");
      return { envelope: envelope("canonical", [["authorization", `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`]]) };
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
      fields: [{
        key: "token",
        label: "Token",
        input: "password",
        required: true,
        secret: true,
        valueType: "string",
        secretReferenceKey: "tokenRef",
      }],
    },
    credentialScope: "connection",
    authority: "canonical",
    normalizeConfig(input, existing) {
      const next = record(input, "Bearer configuration must be an object.");
      const previous = optionalRecord(existing);
      const referenceInput = next.tokenRef ?? (next.token === undefined ? previous?.tokenRef : undefined);
      if (referenceInput !== undefined) return { tokenRef: secretReference(referenceInput) };
      return { token: requiredString(next.token ?? previous?.token, "Bearer token is required.") };
    },
    redactConfig(config) {
      const value = optionalRecord(config);
      return {
        tokenConfigured:
          (typeof value?.token === "string" && value.token.length > 0) ||
          isSecretReference(value?.tokenRef),
      };
    },
    async getCredential({ connection: { config }, resolveSecret }) {
      const value = record(config, "Invalid Bearer configuration.");
      const token = (await resolveConfiguredSecret(value, "token", "tokenRef", resolveSecret, "Bearer token is required.")).trim();
      if (!token) throw new Error("Bearer token is required.");
      return { envelope: envelope("canonical", [["authorization", `Bearer ${token}`]]) };
    },
  },
  {
    method: "vercel-oidc",
    descriptor: {
      method: "vercel-oidc",
      label: "Vercel OIDC",
      description: "Send a Vercel-issued OIDC token using Eve 0.25.1's trusted deployment and Agent headers.",
      credentialScope: "connection",
      interactive: false,
      fields: [{
        key: "token",
        label: "Vercel OIDC token",
        input: "password",
        required: true,
        secret: true,
        valueType: "string",
        secretReferenceKey: "tokenRef",
      }],
    },
    credentialScope: "connection",
    authority: "canonical",
    normalizeConfig(input, existing) {
      const next = record(input, "Vercel OIDC configuration must be an object.");
      const previous = optionalRecord(existing);
      const referenceInput = next.tokenRef ?? (next.token === undefined ? previous?.tokenRef : undefined);
      if (referenceInput !== undefined) return { tokenRef: secretReference(referenceInput) };
      return { token: requiredString(next.token ?? previous?.token, "Vercel OIDC token is required.") };
    },
    redactConfig(config) {
      const value = optionalRecord(config);
      return {
        tokenConfigured:
          (typeof value?.token === "string" && value.token.length > 0) ||
          isSecretReference(value?.tokenRef),
      };
    },
    async getCredential({ connection: { config }, resolveSecret }) {
      const value = record(config, "Invalid Vercel OIDC configuration.");
      const token = (await resolveConfiguredSecret(value, "token", "tokenRef", resolveSecret, "Vercel OIDC token is required.")).trim();
      if (!token) throw new Error("Vercel OIDC token is required.");
      return { envelope: envelope("canonical", [
        ["authorization", `Bearer ${token}`],
        [VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER, token],
      ]) };
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
      const parsed = parseAgentCredentialHeaders(Object.entries(configured).map(([name, value]) => [name,
        typeof value === "string" ? value : "secret-reference",
      ]));
      return {
        headers: Object.fromEntries(parsed
          .map(([name]) => [name.toLowerCase(), typeof configured[name] === "string"
            ? configured[name]
            : secretReference(configured[name])] as const)
          .sort(([left], [right]) => left.localeCompare(right))),
      };
    },
    redactConfig(config) {
      const headers = optionalRecord(optionalRecord(config)?.headers);
      return { headerNames: Object.keys(headers ?? {}).map((name) => name.toLowerCase()).sort() };
    },
    async getCredential({ connection: { config }, resolveSecret }) {
      const configured = record(record(config, "Invalid custom header configuration.").headers, "Custom credential headers must be an object.");
      return { envelope: envelope("canonical", await Promise.all(Object.entries(configured).map(async ([name, value]) => [
        name,
        typeof value === "string"
          ? value
          : await resolveSecretReference(secretReference(value), resolveSecret),
      ] as const))) };
    },
  },
];

export function createOidcProviderDefinition(): Omit<AgentAuthProviderRegistration, "getCredential"> {
  return {
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
        {
          key: "clientSecret",
          label: "Client secret",
          input: "password",
          required: false,
          secret: true,
          valueType: "string",
          secretReferenceKey: "clientSecretRef",
        },
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
        clientSecretConfigured: typeof secretRef?.key === "string" && secretRef.key.length > 0,
        scopes: value?.scopes,
        ...(value?.audience === undefined ? {} : { audience: value.audience, audienceMode: value.audienceMode }),
        tokenEndpointAuthMethod: value?.tokenEndpointAuthMethod,
        authorizationParams: value?.authorizationParams,
        accessTokenVerification: value?.accessTokenVerification,
      };
    },
  };
}

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
  const legacySecretKey = typeof next.clientSecretKey === "string" && next.clientSecretKey.trim()
    ? next.clientSecretKey.trim()
    : undefined;
  const referenceInput = next.clientSecretRef
    ?? (legacySecretKey ? { kind: "project-secret", key: legacySecretKey } : undefined)
    ?? (next.clientSecretRef === undefined && next.clientSecretKey === undefined ? previous?.clientSecretRef : undefined);
  const clientSecretRef = referenceInput === undefined ? undefined : secretReference(referenceInput);
  if (tokenEndpointAuthMethod !== "none" && !clientSecretRef) {
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
    ...(clientSecretRef ? { clientSecretRef } : {}),
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
      return { envelope: envelope(authority, []) };
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

function providerOrder(method: string): number {
  const order = ["local-dev", "none", "basic", "bearer", "vercel-oidc", "oidc", "headers"];
  const index = order.indexOf(method);
  return index === -1 ? order.length : index;
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

function secretReference(value: unknown): AgentAuthSecretReference {
  const candidate = record(value, "Agent Auth secret reference must be an object.");
  if (candidate.kind !== "project-secret") {
    throw new Error("Agent Auth secret reference kind is invalid.");
  }
  const key = requiredString(candidate.key, "Agent Auth secret reference key is required.");
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("Agent Auth secret reference key is invalid.");
  return { kind: candidate.kind, key };
}

function isSecretReference(value: unknown): boolean {
  try {
    secretReference(value);
    return true;
  } catch {
    return false;
  }
}

async function resolveConfiguredSecret(
  config: Record<string, unknown>,
  inlineKey: string,
  referenceKey: string,
  resolver: ((reference: AgentAuthSecretReference) => Promise<string>) | undefined,
  missingMessage: string,
): Promise<string> {
  if (config[referenceKey] !== undefined) return resolveSecretReference(secretReference(config[referenceKey]), resolver);
  return requiredString(config[inlineKey], missingMessage);
}

async function resolveSecretReference(
  reference: AgentAuthSecretReference,
  resolver: ((reference: AgentAuthSecretReference) => Promise<string>) | undefined,
): Promise<string> {
  if (!resolver) throw new Error("Agent Auth secret reference resolver is unavailable.");
  return resolver(reference);
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
