import { describe, expect, test } from "vitest";
import { createAgentAuthRegistry, agentAuthConfigsEqual, type AgentAuthProviderRegistration } from "./registry.js";

describe("Agent Auth provider registry", () => {
  test("keeps provider keys, descriptors, and credential scopes consistent", () => {
    const registry = createAgentAuthRegistry();

    expect(registry.listDescriptors().map((descriptor) => descriptor.method)).toEqual([
      "local-dev",
      "none",
      "basic",
      "bearer",
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
    expect(() => createAgentAuthRegistry([{
      ...registration("future-auth"),
      descriptor: { ...registration("future-auth").descriptor, method: "different" },
    }])).toThrow(/descriptor/i);
    expect(() => createAgentAuthRegistry([{
      ...registration("future-auth"),
      credentialScope: "principal",
    }])).toThrow(/credential scope/i);
  });

  test.each([
    ["local-dev", "loopback"],
    ["none", "canonical"],
    ["basic", "canonical"],
    ["bearer", "canonical"],
    ["headers", "canonical"],
  ] as const)("resolves %s through %s authority", async (method, authority) => {
    const provider = createAgentAuthRegistry().get(method);
    expect(provider?.authority).toBe(authority);
    const config = provider?.normalizeConfig(configFor(method));
    await expect(provider?.getCredential({ config, callerPrincipalId: "member_1" })).resolves.toMatchObject({ authority });
  });

  test("materializes Basic, Bearer, and custom header credentials", async () => {
    const registry = createAgentAuthRegistry();
    await expect(resolve(registry, "basic", { username: "alice", password: "sëcret" })).resolves.toMatchObject({
      headers: [["authorization", "Basic YWxpY2U6c8OrY3JldA=="]],
    });
    await expect(resolve(registry, "bearer", { token: "signed-token" })).resolves.toMatchObject({
      headers: [["authorization", "Bearer signed-token"]],
    });
    await expect(resolve(registry, "headers", { headers: { "X-Tenant": "acme", "X-Api-Key": "secret" } })).resolves.toMatchObject({
      headers: [["x-api-key", "secret"], ["x-tenant", "acme"]],
    });
  });

  test("rejects dangerous custom headers and redacts every configured secret", () => {
    const registry = createAgentAuthRegistry();
    expect(() => registry.get("headers")?.normalizeConfig({ headers: { Host: "attacker.example" } })).toThrow(/credential header/i);
    expect(registry.get("basic")?.redactConfig({ username: "alice", password: "secret" })).toEqual({
      username: "alice",
      passwordConfigured: true,
    });
    expect(registry.get("bearer")?.redactConfig({ token: "secret" })).toEqual({ tokenConfigured: true });
    expect(registry.get("headers")?.redactConfig({ headers: { "x-api-key": "secret" } })).toEqual({
      headerNames: ["x-api-key"],
    });
  });

  test("preserves omitted secrets on update and compares normalized config semantically", () => {
    const provider = createAgentAuthRegistry().get("basic");
    const existing = provider?.normalizeConfig({ username: "alice", password: "secret" });
    const unchanged = provider?.normalizeConfig({ username: "alice" }, existing);

    expect(unchanged).toEqual(existing);
    expect(agentAuthConfigsEqual(existing, { password: "secret", username: "alice" })).toBe(true);
    expect(agentAuthConfigsEqual(existing, { password: "rotated", username: "alice" })).toBe(false);
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
    getCredential: async () => ({ version: 1, authority: "canonical", headers: [] }),
  };
}

function configFor(method: string): unknown {
  if (method === "basic") return { username: "alice", password: "secret" };
  if (method === "bearer") return { token: "secret" };
  if (method === "headers") return { headers: { "x-api-key": "secret" } };
  return {};
}

async function resolve(registry: ReturnType<typeof createAgentAuthRegistry>, method: string, input: unknown) {
  const provider = registry.get(method);
  if (!provider) throw new Error(`Missing provider ${method}.`);
  const config = provider.normalizeConfig(input);
  return provider.getCredential({ config, callerPrincipalId: "member_1" });
}
