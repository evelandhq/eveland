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
        fields: descriptor.fields.map((field) => ({ ...field })),
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
