import { httpBasic, routeAuth } from "eve/channels/auth";
import { describe, expect, test } from "vitest";
import {
  createAgentAuthRegistry,
  createOidcProviderDefinition,
  agentAuthConfigsEqual,
  type AgentAuthProviderRegistration,
} from "./registry.js";

describe("Agent Auth provider registry", () => {
  test("keeps provider keys, descriptors, and credential scopes consistent", () => {
    const registry = registryWithOidc();

    expect(registry.listDescriptors().map((descriptor) => descriptor.method)).toEqual([
      "local-dev",
      "none",
      "basic",
      "bearer",
      "vercel-oidc",
      "oidc",
      "headers",
    ]);
    for (const descriptor of registry.listDescriptors()) {
      const provider = registry.get(descriptor.method);
      expect(provider?.method).toBe(descriptor.method);
      expect(provider?.descriptor.method).toBe(descriptor.method);
      expect(provider?.credentialScope).toBe(descriptor.credentialScope);
    }
  });

  test("rejects duplicate, invalid, and internally inconsistent registrations", () => {
    expect(() => createAgentAuthRegistry([registration("none")])).toThrow(/duplicate/i);
    expect(() => createAgentAuthRegistry([registration("Not Valid")])).toThrow(/invalid/i);
    expect(() =>
      createAgentAuthRegistry([
        {
          ...registration("future-auth"),
          descriptor: { ...registration("future-auth").descriptor, method: "different" },
        },
      ]),
    ).toThrow(/descriptor/i);
    expect(() =>
      createAgentAuthRegistry([
        {
          ...registration("future-auth"),
          credentialScope: "principal",
        },
      ]),
    ).toThrow(/credential scope/i);
  });

  test.each([
    ["local-dev", "loopback"],
    ["none", "canonical"],
    ["basic", "canonical"],
    ["bearer", "canonical"],
    ["vercel-oidc", "canonical"],
    ["oidc", "canonical"],
    ["headers", "canonical"],
  ] as const)("resolves %s through %s authority", async (method, authority) => {
    const provider = registryWithOidc().get(method);
    expect(provider?.authority).toBe(authority);
    const config = provider?.normalizeConfig(configFor(method));
    if (provider?.descriptor.interactive) return;
    await expect(provider?.getCredential(context(method, config))).resolves.toMatchObject({
      envelope: { authority },
    });
  });

  test("materializes Basic, Bearer, and custom header credentials", async () => {
    const registry = registryWithOidc();
    await expect(
      resolve(registry, "basic", { username: "alice", password: "sëcret" }),
    ).resolves.toMatchObject({
      headers: [["authorization", "Basic YWxpY2U6c8OrY3JldA=="]],
    });
    await expect(resolve(registry, "bearer", { token: "signed-token" })).resolves.toMatchObject({
      headers: [["authorization", "Bearer signed-token"]],
    });
    await expect(
      resolve(registry, "headers", { headers: { "X-Tenant": "acme", "X-Api-Key": "secret" } }),
    ).resolves.toMatchObject({
      headers: [
        ["x-api-key", "secret"],
        ["x-tenant", "acme"],
      ],
    });
  });

  test("mirrors Eve 0.29.4 Vercel OIDC client headers", async () => {
    const registry = registryWithOidc();

    await expect(resolve(registry, "vercel-oidc", { token: "vercel-oidc-token" })).resolves.toEqual(
      {
        version: 1,
        authority: "canonical",
        headers: [
          ["authorization", "Bearer vercel-oidc-token"],
          ["x-vercel-trusted-oidc-idp-token", "vercel-oidc-token"],
        ],
      },
    );
  });

  test("interoperates with Eve 0.27 HTTP Basic normalization and challenge metadata", async () => {
    const registry = registryWithOidc();
    const credential = await resolve(registry, "basic", {
      username: "ali\u0301ce",
      password: "se\u0301cret",
    });
    const authorized = await routeAuth(
      new Request("https://agent.example/eve/v1/session", {
        headers: Object.fromEntries(credential.headers),
      }),
      httpBasic({ username: "alíce", password: "sécret" }),
    );

    expect(authorized).not.toBeInstanceOf(Response);

    const challenge = await routeAuth(
      new Request("https://agent.example/eve/v1/session"),
      httpBasic({ username: "alice", password: "secret" }),
    );
    expect(challenge).toBeInstanceOf(Response);
    expect((challenge as Response).status).toBe(401);
    expect((challenge as Response).headers.get("www-authenticate")).toBe(
      'Basic realm="eve", charset="UTF-8"',
    );
  });

  test("rejects dangerous custom headers and redacts every configured secret", () => {
    const registry = registryWithOidc();
    expect(() =>
      registry.get("headers")?.normalizeConfig({ headers: { Host: "attacker.example" } }),
    ).toThrow(/credential header/i);
    expect(registry.get("basic")?.redactConfig({ username: "alice", password: "secret" })).toEqual({
      username: "alice",
      passwordConfigured: true,
    });
    expect(registry.get("bearer")?.redactConfig({ token: "secret" })).toEqual({
      tokenConfigured: true,
    });
    expect(registry.get("vercel-oidc")?.redactConfig({ token: "secret" })).toEqual({
      tokenConfigured: true,
    });
    expect(registry.get("headers")?.redactConfig({ headers: { "x-api-key": "secret" } })).toEqual({
      headerNames: ["x-api-key"],
    });
  });

  test("preserves omitted secrets on update and compares normalized config semantically", () => {
    const provider = registryWithOidc().get("basic");
    const existing = provider?.normalizeConfig({ username: "alice", password: "secret" });
    const unchanged = provider?.normalizeConfig({ username: "alice" }, existing);

    expect(unchanged).toEqual(existing);
    expect(agentAuthConfigsEqual(existing, { password: "secret", username: "alice" })).toBe(true);
    expect(agentAuthConfigsEqual(existing, { password: "rotated", username: "alice" })).toBe(false);
  });

  test("normalizes generic OIDC protocol settings without provider-specific defaults", () => {
    const provider = registryWithOidc().get("oidc");

    expect(provider?.descriptor).toMatchObject({
      method: "oidc",
      credentialScope: "principal",
      interactive: true,
    });
    expect(provider?.descriptor.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "tokenEndpointAuthMethod",
          input: "select",
          options: expect.arrayContaining([expect.objectContaining({ value: "none" })]),
        }),
        expect.objectContaining({
          key: "accessTokenVerification",
          input: "select",
          options: expect.arrayContaining([expect.objectContaining({ value: "userinfo" })]),
        }),
      ]),
    );
    expect(
      provider?.normalizeConfig({
        issuer: "https://idp.example/",
        clientId: "eveland-playground",
        clientSecretRef: { kind: "project-secret", key: "OIDC_CLIENT_SECRET" },
        scopes: ["profile", "openid", "profile"],
        audience: "https://agent.example",
        audienceMode: "both",
        tokenEndpointAuthMethod: "client_secret_basic",
        authorizationParams: { prompt: "consent", login_hint: "member@example.com" },
        accessTokenVerification: "eve-jwt",
      }),
    ).toEqual({
      issuer: "https://idp.example",
      clientId: "eveland-playground",
      clientSecretRef: { kind: "project-secret", key: "OIDC_CLIENT_SECRET" },
      scopes: ["openid", "profile"],
      audience: "https://agent.example",
      audienceMode: "both",
      tokenEndpointAuthMethod: "client_secret_basic",
      authorizationParams: { login_hint: "member@example.com", prompt: "consent" },
      accessTokenVerification: "eve-jwt",
    });
  });

  test("rejects unsafe or contradictory generic OIDC settings", () => {
    const provider = registryWithOidc().get("oidc");
    const base = {
      issuer: "https://idp.example",
      clientId: "eveland-playground",
      scopes: ["openid"],
      tokenEndpointAuthMethod: "none",
      accessTokenVerification: "userinfo",
    };

    expect(() => provider?.normalizeConfig({ ...base, issuer: "http://idp.example" })).toThrow(
      /HTTPS/,
    );
    expect(() => provider?.normalizeConfig({ ...base, audienceMode: "resource" })).toThrow(
      /audience/i,
    );
    expect(() =>
      provider?.normalizeConfig({
        ...base,
        tokenEndpointAuthMethod: "client_secret_post",
      }),
    ).toThrow(/client secret/i);
    expect(() =>
      provider?.normalizeConfig({
        ...base,
        authorizationParams: { redirect_uri: "https://attacker.example", state: "fixed" },
      }),
    ).toThrow(/authorization parameter/i);
  });

  test("materializes credentials from current secret references without copying values into config", async () => {
    const registry = createAgentAuthRegistry();
    const resolveSecret = async (reference: { kind: "project-secret"; key: string }) =>
      `${reference.kind}:${reference.key}`;
    const basic = registry.get("basic")!;
    const bearer = registry.get("bearer")!;
    const vercelOidc = registry.get("vercel-oidc")!;
    const headers = registry.get("headers")!;

    expect(basic.descriptor.fields.find((field) => field.key === "password")).toMatchObject({
      secretReferenceKey: "passwordRef",
    });
    expect(bearer.descriptor.fields.find((field) => field.key === "token")).toMatchObject({
      secretReferenceKey: "tokenRef",
    });
    expect(vercelOidc.descriptor.fields.find((field) => field.key === "token")).toMatchObject({
      secretReferenceKey: "tokenRef",
    });

    const basicConfig = basic.normalizeConfig({
      username: "alice",
      passwordRef: { kind: "project-secret", key: "BASIC_PASSWORD" },
    });
    expect(JSON.stringify(basicConfig)).not.toContain("project-secret:BASIC_PASSWORD");
    await expect(
      basic.getCredential(context("basic", basicConfig, resolveSecret)),
    ).resolves.toMatchObject({
      envelope: {
        headers: [["authorization", "Basic YWxpY2U6cHJvamVjdC1zZWNyZXQ6QkFTSUNfUEFTU1dPUkQ="]],
      },
    });

    const bearerConfig = bearer.normalizeConfig({
      tokenRef: { kind: "project-secret", key: "ACCESS_TOKEN" },
    });
    await expect(
      bearer.getCredential(context("bearer", bearerConfig, resolveSecret)),
    ).resolves.toMatchObject({
      envelope: { headers: [["authorization", "Bearer project-secret:ACCESS_TOKEN"]] },
    });

    const vercelOidcConfig = vercelOidc.normalizeConfig({
      tokenRef: { kind: "project-secret", key: "VERCEL_OIDC_TOKEN" },
    });
    await expect(
      vercelOidc.getCredential(context("vercel-oidc", vercelOidcConfig, resolveSecret)),
    ).resolves.toMatchObject({
      envelope: {
        headers: [
          ["authorization", "Bearer project-secret:VERCEL_OIDC_TOKEN"],
          ["x-vercel-trusted-oidc-idp-token", "project-secret:VERCEL_OIDC_TOKEN"],
        ],
      },
    });

    const headerConfig = headers.normalizeConfig({
      headers: { "X-Api-Key": { kind: "project-secret", key: "API_KEY" }, "X-Tenant": "acme" },
    });
    await expect(
      headers.getCredential(context("headers", headerConfig, resolveSecret)),
    ).resolves.toMatchObject({
      envelope: {
        headers: [
          ["x-api-key", "project-secret:API_KEY"],
          ["x-tenant", "acme"],
        ],
      },
    });
  });
});

function registration(method: string): AgentAuthProviderRegistration {
  return {
    method,
    descriptor: {
      method,
      label: method,
      description: method,
      credentialScope: "connection",
      interactive: false,
      fields: [],
    },
    credentialScope: "connection",
    authority: "canonical",
    normalizeConfig: (input) => input,
    redactConfig: () => ({}),
    getCredential: async () => ({ envelope: { version: 1, authority: "canonical", headers: [] } }),
  };
}

function configFor(method: string): unknown {
  if (method === "basic") return { username: "alice", password: "secret" };
  if (method === "bearer") return { token: "secret" };
  if (method === "vercel-oidc") return { token: "vercel-oidc-token" };
  if (method === "headers") return { headers: { "x-api-key": "secret" } };
  if (method === "oidc")
    return {
      issuer: "https://idp.example",
      clientId: "client",
      scopes: ["openid"],
      audience: "https://agent.example",
      tokenEndpointAuthMethod: "none",
      accessTokenVerification: "eve-jwt",
    };
  return {};
}

async function resolve(
  registry: ReturnType<typeof createAgentAuthRegistry>,
  method: string,
  input: unknown,
) {
  const provider = registry.get(method);
  if (!provider) throw new Error(`Missing provider ${method}.`);
  const config = provider.normalizeConfig(input);
  const resolved = await provider.getCredential(context(method, config));
  if ("failure" in resolved) throw new Error(resolved.failure.message);
  return resolved.envelope;
}

function registryWithOidc() {
  return createAgentAuthRegistry([
    {
      ...createOidcProviderDefinition(),
      async getCredential() {
        return {
          failure: {
            code: "interaction_required" as const,
            method: "oidc",
            message: "Authorize this connection.",
          },
        };
      },
    },
  ]);
}

function context(
  method: string,
  config: unknown,
  resolveSecret?: (reference: { kind: "project-secret"; key: string }) => Promise<string>,
) {
  return {
    connection: {
      id: "acon_test",
      target: { kind: "managed-project" as const, projectId: "proj_test" },
      method,
      securityRevision: 1,
      configEncrypted: "sealed",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      config,
    },
    callerPrincipalId: "member_1",
    ...(resolveSecret ? { resolveSecret } : {}),
  };
}
