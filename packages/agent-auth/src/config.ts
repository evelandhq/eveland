import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { isReservedCredentialHeader } from "@eveland/core/agent-auth";

export type AgentAuthConfigBinding = {
  agentConnectionId: string;
  method: string;
  securityRevision: number;
};

export type OidcAuthorizationCodeConfig = {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post" | "none";
  audience: string;
  audienceMode: "resource" | "audience" | "both";
  scopes: string[];
  promptConsent: boolean;
};

type AgentAuthConfigEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
};

export function sealAgentAuthConfig(config: unknown, appSecretKey: string, binding: AgentAuthConfigBinding): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveAgentAuthKey(appSecretKey), iv);
  cipher.setAAD(bindingAad(binding));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
  const envelope: AgentAuthConfigEnvelope = {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return JSON.stringify(envelope);
}

export function openAgentAuthConfig(value: string, appSecretKey: string, binding: AgentAuthConfigBinding): unknown {
  const envelope = parseEnvelope(value);
  const decipher = createDecipheriv("aes-256-gcm", deriveAgentAuthKey(appSecretKey), Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(bindingAad(binding));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as unknown;
}

export function normalizeAgentAuthConfig(method: string, value: unknown): Record<string, unknown> {
  const config = record(value, "Agent Auth config must be an object.");
  if (method === "local-dev" || method === "none") return {};
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
  if (method === "local-dev" || method === "none") return {};
  if (method === "bearer") return { tokenConfigured: typeof config.token === "string" && config.token.length > 0 };
  if (method === "basic") {
    return {
      username: typeof config.username === "string" ? config.username : "",
      passwordConfigured: typeof config.password === "string" && config.password.length > 0,
    };
  }
  if (method === "headers") {
    const headers = record(config.headers, "Custom credential headers must be an object.");
    return { headerNames: Object.keys(headers).map((name) => name.toLowerCase()).sort() };
  }
  if (method === "oidc") {
    const oidc = config as unknown as OidcAuthorizationCodeConfig;
    return {
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      clientSecretConfigured: typeof oidc.clientSecret === "string" && oidc.clientSecret.length > 0,
      tokenEndpointAuthMethod: oidc.tokenEndpointAuthMethod,
      audience: oidc.audience,
      audienceMode: oidc.audienceMode,
      scopes: oidc.scopes,
      promptConsent: oidc.promptConsent,
    };
  }
  return {};
}

export function normalizeOidcAuthorizationCodeConfig(config: Record<string, unknown>): OidcAuthorizationCodeConfig {
  const issuer = requiredString(config.issuer, "OIDC issuer is required.").replace(/\/$/, "");
  const clientId = requiredString(config.clientId, "OIDC client ID is required.");
  const audience = requiredString(config.audience, "OIDC audience is required.");
  const tokenEndpointAuthMethod = config.tokenEndpointAuthMethod ?? (config.clientSecret ? "client_secret_basic" : "none");
  if (tokenEndpointAuthMethod !== "client_secret_basic" && tokenEndpointAuthMethod !== "client_secret_post" && tokenEndpointAuthMethod !== "none") {
    throw new Error("Unsupported OIDC token endpoint authentication method.");
  }
  const clientSecret = config.clientSecret === undefined ? undefined : requiredString(config.clientSecret, "OIDC client secret must not be empty.");
  if (tokenEndpointAuthMethod !== "none" && !clientSecret) throw new Error("OIDC client secret is required for the selected token endpoint authentication method.");
  const audienceMode = config.audienceMode ?? "resource";
  if (audienceMode !== "resource" && audienceMode !== "audience" && audienceMode !== "both") {
    throw new Error("Unsupported OIDC audience mode.");
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
    tokenEndpointAuthMethod,
    audience,
    audienceMode,
    scopes,
    promptConsent: config.promptConsent === undefined ? true : config.promptConsent === true,
  };
}

function deriveAgentAuthKey(appSecretKey: string): Buffer {
  return createHmac("sha256", normalizeAppSecretKey(appSecretKey)).update("eveland:agent-auth-config:v1").digest();
}

function normalizeAppSecretKey(value: string): Buffer {
  const utf8 = Buffer.from(value, "utf8");
  if (utf8.length === 32) return utf8;
  const base64 = Buffer.from(value, "base64");
  if (base64.length === 32) return base64;
  throw new Error("APP_SECRET_KEY must be 32 bytes or a base64 encoded 32-byte value.");
}

function bindingAad(binding: AgentAuthConfigBinding): Buffer {
  return Buffer.from(JSON.stringify(["eveland-agent-auth-config", binding.agentConnectionId, binding.method, binding.securityRevision]));
}

function parseEnvelope(value: string): AgentAuthConfigEnvelope {
  const parsed = JSON.parse(value) as Partial<AgentAuthConfigEnvelope>;
  if (
    parsed.version !== 1 ||
    parsed.algorithm !== "aes-256-gcm" ||
    typeof parsed.iv !== "string" ||
    typeof parsed.authTag !== "string" ||
    typeof parsed.ciphertext !== "string"
  ) {
    throw new Error("Invalid Agent Auth config envelope.");
  }
  return parsed as AgentAuthConfigEnvelope;
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
