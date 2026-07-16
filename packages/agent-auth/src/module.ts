import type { AgentAuthMethodDescriptor } from "@eveland/core/agent-auth";
import { assertAllowedAgentCredentialHeader } from "./config.js";

export type AgentAuthTarget = {
  agentConnectionId: string;
  callerPrincipalId: string;
};

export type AgentRequestTarget = {
  pathname: string;
  searchParams?: Record<string, string>;
};

export type AgentRequestInit = {
  method?: "GET" | "POST";
  body?: Uint8Array | null;
  contentType?: string | null;
  accept?: string | null;
  signal?: AbortSignal;
};

export type AgentTransportTarget = {
  kind: "managed-project";
  projectId: string;
};

export type AgentConnectionSnapshot = {
  id: string;
  target: AgentTransportTarget;
  method: string;
  config: unknown;
  securityRevision: number;
};

export type AgentRequestCredential =
  | { kind: "none" }
  | { kind: "headers"; headers: Array<[string, string]> };

export type AgentCredentialVersion = {
  securityRevision: number;
  rotationSeq: number | null;
};

export type AgentCredentialResolution = {
  credential: AgentRequestCredential;
  version: AgentCredentialVersion;
};

export type AgentAuthTransportRequest = {
  target: AgentTransportTarget;
  authority: "loopback" | "canonical";
  credential: AgentRequestCredential;
  request: AgentRequestTarget;
  init: AgentRequestInit;
};

export type AgentConnectionReader = {
  getAgentConnection(id: string): Promise<AgentConnectionSnapshot | null>;
};

export type AgentAuthTransport = {
  request(input: AgentAuthTransportRequest): Promise<Response>;
};

export type AgentAuthMethodRegistration = {
  method: string;
  credentialScope: "connection" | "principal";
  authority: "loopback" | "canonical";
  getCredential(input: {
    target: AgentAuthTarget;
    connection: AgentConnectionSnapshot;
    config: unknown;
    interaction?: { returnPath: string };
  }): Promise<AgentRequestCredential | AgentCredentialResolution | AgentAuthFailure>;
  recoverUnauthorized?(input: {
    target: AgentAuthTarget;
    connection: AgentConnectionSnapshot;
    config: unknown;
    attempt: 0 | 1;
    rejectedVersion: AgentCredentialVersion;
  }): Promise<
    | { action: "retry" }
    | { action: "give_up"; failure: AgentAuthFailure }
  >;
  inspect?(input: {
    target: AgentAuthTarget;
    connection: AgentConnectionSnapshot;
    config: unknown;
    interaction?: { returnPath: string };
  }): Promise<AgentAuthStatus>;
};

export type AgentAuthFailure = {
  code:
    | "configuration_required"
    | "interaction_required"
    | "credential_rejected"
    | "forbidden"
    | "configuration_invalid"
    | "provider_unavailable"
    | "upstream_unavailable"
    | "retry_required";
  method: string;
  message: string;
  interaction?: { type: "redirect"; url: string };
};

export type AgentAuthResult = Response | AgentAuthFailure;

export type AgentAuthStatus =
  | { state: "not_required" }
  | { state: "credential_available" }
  | { state: "interaction_required"; interaction?: { type: "redirect"; url: string } }
  | { state: "misconfigured"; message: string };

export type AgentAuthModule = {
  request(
    target: AgentAuthTarget,
    request: AgentRequestTarget,
    init: AgentRequestInit,
    interaction?: { returnPath: string },
  ): Promise<AgentAuthResult>;
  status(target: AgentAuthTarget, interaction?: { returnPath: string }): Promise<AgentAuthStatus>;
};

export function createAgentAuthModule(input: {
  connectionReader: AgentConnectionReader;
  transport: AgentAuthTransport;
  registrations?: AgentAuthMethodRegistration[];
}): AgentAuthModule {
  const registrations = new Map<string, AgentAuthMethodRegistration>();
  for (const registration of [localDevRegistration, noneRegistration, bearerRegistration, basicRegistration, headersRegistration, ...(input.registrations ?? [])]) {
    if (!/^[a-z][a-z0-9-]*$/.test(registration.method)) throw new Error(`Invalid Agent Auth Method: ${registration.method}.`);
    if (registrations.has(registration.method)) throw new Error(`Duplicate Agent Auth Method: ${registration.method}.`);
    registrations.set(registration.method, registration);
  }

  return {
    async request(target, request, init, interaction) {
      const connection = await input.connectionReader.getAgentConnection(target.agentConnectionId);
      if (!connection) throw new Error("Agent Connection not found.");
      const registration = registrations.get(connection.method);
      if (!registration) throw new Error(`Unsupported Agent Auth Method: ${connection.method}.`);
      const resolved = await resolveCredential(registration, target, connection, interaction);
      if (isAgentAuthFailure(resolved)) return resolved;
      let response = await input.transport.request({
        target: connection.target,
        authority: registration.authority,
        credential: resolved.credential,
        request,
        init,
      });
      if (response.status === 403) {
        await discardResponse(response);
        return forbiddenFailure(connection.method);
      }
      if (response.status !== 401) return response;
      await discardResponse(response);
      if (!registration.recoverUnauthorized) return credentialRejectedFailure(connection.method);

      const firstRecovery = await registration.recoverUnauthorized({
        target,
        connection,
        config: connection.config,
        attempt: 0,
        rejectedVersion: resolved.version,
      });
      if (firstRecovery.action === "give_up") return firstRecovery.failure;
      const retryResolved = await resolveCredential(registration, target, connection, interaction);
      if (isAgentAuthFailure(retryResolved)) return retryResolved;
      response = await input.transport.request({
        target: connection.target,
        authority: registration.authority,
        credential: retryResolved.credential,
        request,
        init,
      });
      if (response.status === 403) {
        await discardResponse(response);
        return forbiddenFailure(connection.method);
      }
      if (response.status !== 401) return response;
      await discardResponse(response);
      const finalRecovery = await registration.recoverUnauthorized({
        target,
        connection,
        config: connection.config,
        attempt: 1,
        rejectedVersion: retryResolved.version,
      });
      return finalRecovery.action === "give_up"
        ? finalRecovery.failure
        : credentialRejectedFailure(connection.method);
    },
    async status(target, interaction) {
      try {
        const connection = await input.connectionReader.getAgentConnection(target.agentConnectionId);
        if (!connection) return { state: "misconfigured", message: "Agent Connection not found." };
        const registration = registrations.get(connection.method);
        if (!registration) return { state: "misconfigured", message: `Unsupported Agent Auth Method: ${connection.method}.` };
        if (registration.inspect) return await registration.inspect({ target, connection, config: connection.config, interaction });
        const result = await registration.getCredential({ target, connection, config: connection.config, interaction });
        if (isAgentAuthFailure(result)) {
          return result.code === "interaction_required"
            ? { state: "interaction_required", ...(result.interaction ? { interaction: result.interaction } : {}) }
            : { state: "misconfigured", message: result.message };
        }
        const credential = isCredentialResolution(result) ? result.credential : result;
        return credential.kind === "none" ? { state: "not_required" } : { state: "credential_available" };
      } catch (error) {
        return {
          state: "misconfigured",
          message: error instanceof Error ? error.message : "Invalid Agent Auth configuration.",
        };
      }
    },
  };
}

async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function resolveCredential(
  registration: AgentAuthMethodRegistration,
  target: AgentAuthTarget,
  connection: AgentConnectionSnapshot,
  interaction?: { returnPath: string },
): Promise<AgentCredentialResolution | AgentAuthFailure> {
  try {
    const result = await registration.getCredential({ target, connection, config: connection.config, interaction });
    if (isAgentAuthFailure(result)) return result;
    return isCredentialResolution(result)
      ? result
      : {
          credential: result,
          version: { securityRevision: connection.securityRevision, rotationSeq: null },
        };
  } catch (error) {
    return {
      code: "configuration_invalid",
      method: connection.method,
      message: error instanceof Error ? error.message : "Invalid Agent Auth configuration.",
    };
  }
}

function credentialRejectedFailure(method: string): AgentAuthFailure {
  return { code: "credential_rejected", method, message: "The Agent rejected the configured credential." };
}

function forbiddenFailure(method: string): AgentAuthFailure {
  return { code: "forbidden", method, message: "The Agent credential is not allowed to access this route." };
}

// Structural on purpose: `value instanceof Response` is unreliable under
// @hono/node-server, which replaces the global Response class at serve time.
export function isAgentAuthFailure(value: AgentAuthResult): value is AgentAuthFailure;
export function isAgentAuthFailure(
  value: AgentRequestCredential | AgentCredentialResolution | AgentAuthFailure,
): value is AgentAuthFailure;
export function isAgentAuthFailure(value: unknown): value is AgentAuthFailure {
  return typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string";
}

function isCredentialResolution(
  value: AgentRequestCredential | AgentCredentialResolution,
): value is AgentCredentialResolution {
  return "credential" in value;
}

const builtinMethodDescriptors: AgentAuthMethodDescriptor[] = [
  {
    method: "local-dev",
    label: "Local development",
    description: "Use Eve's loopback-only local development identity without a credential.",
    credentialScope: "connection",
    interactive: false,
    fields: [],
  },
  {
    method: "none",
    label: "No authentication",
    description: "Call the canonical Agent route without a credential.",
    credentialScope: "connection",
    interactive: false,
    fields: [],
  },
  {
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
  {
    method: "bearer",
    label: "Bearer token",
    description: "Send a configured JWT or access token as a Bearer credential.",
    credentialScope: "connection",
    interactive: false,
    fields: [{ key: "token", label: "Token", input: "password", required: true, secret: true, valueType: "string" }],
  },
  {
    method: "oidc",
    label: "OIDC",
    description: "Let each Playground caller authorize with the Agent's identity provider using Authorization Code and PKCE.",
    credentialScope: "principal",
    interactive: true,
    fields: [
      { key: "issuer", label: "Issuer", input: "text", required: true, secret: false, valueType: "string" },
      { key: "clientId", label: "Client ID", input: "text", required: true, secret: false, valueType: "string" },
      { key: "clientSecret", label: "Client secret", input: "password", required: false, secret: true, valueType: "string" },
      { key: "audience", label: "Audience", input: "text", required: true, secret: false, valueType: "string" },
      { key: "scopes", label: "Scopes", input: "text", required: true, secret: false, valueType: "string-list" },
    ],
  },
  {
    method: "headers",
    label: "Custom headers",
    description: "Send configured credential headers for a custom Eve route AuthFn.",
    credentialScope: "connection",
    interactive: false,
    fields: [{ key: "headers", label: "Headers (JSON)", input: "textarea", required: true, secret: true, valueType: "json-record" }],
  },
];

export function listAgentAuthMethodDescriptors(): AgentAuthMethodDescriptor[] {
  return builtinMethodDescriptors.map((descriptor) => ({
    ...descriptor,
    fields: descriptor.fields.map((field) => ({ ...field })),
  }));
}

const localDevRegistration: AgentAuthMethodRegistration = {
  method: "local-dev",
  credentialScope: "connection",
  authority: "loopback",
  async getCredential() {
    return { kind: "none" };
  },
};

const noneRegistration: AgentAuthMethodRegistration = {
  method: "none",
  credentialScope: "connection",
  authority: "canonical",
  async getCredential() {
    return { kind: "none" };
  },
};

const bearerRegistration: AgentAuthMethodRegistration = {
  method: "bearer",
  credentialScope: "connection",
  authority: "canonical",
  async getCredential({ config }) {
    const token = readString(config, "token").trim();
    if (!token) throw new Error("Bearer token is required.");
    return { kind: "headers", headers: [["authorization", `Bearer ${token}`]] };
  },
};

const basicRegistration: AgentAuthMethodRegistration = {
  method: "basic",
  credentialScope: "connection",
  authority: "canonical",
  async getCredential({ config }) {
    const username = readString(config, "username");
    const password = readString(config, "password");
    if (!username || username.includes(":")) throw new Error("Basic username must be non-empty and must not contain a colon.");
    if (!password) throw new Error("Basic password is required.");
    const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    return { kind: "headers", headers: [["authorization", `Basic ${token}`]] };
  },
};

const headersRegistration: AgentAuthMethodRegistration = {
  method: "headers",
  credentialScope: "connection",
  authority: "canonical",
  async getCredential({ config }) {
    const configured = readRecord(config, "headers");
    const headers = new Headers();
    for (const [name, value] of Object.entries(configured)) {
      if (typeof value !== "string") throw new Error(`Agent credential header ${name} must be a string.`);
      assertAllowedAgentCredentialHeader(name);
      headers.set(name, value);
    }
    return { kind: "headers", headers: [...headers.entries()].sort(([left], [right]) => left.localeCompare(right)) };
  },
};

function readString(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Agent Auth configuration.");
  const candidate = (value as Record<string, unknown>)[key];
  if (typeof candidate !== "string") throw new Error(`Agent Auth configuration field ${key} must be a string.`);
  return candidate;
}

function readRecord(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Agent Auth configuration.");
  const candidate = (value as Record<string, unknown>)[key];
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error(`Agent Auth configuration field ${key} must be an object.`);
  }
  return candidate as Record<string, unknown>;
}
