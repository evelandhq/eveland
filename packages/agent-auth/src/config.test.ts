import { describe, expect, test } from "vitest";
import { normalizeAgentAuthConfig, redactAgentAuthConfig } from "./config.js";

describe("OIDC Agent Auth config", () => {
  test("keeps the audience-bound contract when an audience is configured", () => {
    const normalized = normalizeAgentAuthConfig("oidc", {
      issuer: "https://idp.example/",
      clientId: "eveland-playground",
      clientSecret: "secret",
      audience: "https://agent.example",
      scopes: ["openid", "profile"],
    });

    expect(normalized).toMatchObject({
      issuer: "https://idp.example",
      audience: "https://agent.example",
      audienceMode: "resource",
    });
    expect(redactAgentAuthConfig("oidc", normalized)).toMatchObject({
      audience: "https://agent.example",
      audienceMode: "resource",
      clientSecretConfigured: true,
    });
  });

  test("accepts an audience-less configuration for providers without audience binding", () => {
    const normalized = normalizeAgentAuthConfig("oidc", {
      issuer: "https://account.example",
      clientId: "eveland-playground",
      clientSecret: "secret",
      scopes: ["openid", "profile"],
    });

    expect(normalized).not.toHaveProperty("audience");
    expect(normalized).not.toHaveProperty("audienceMode");
    const redacted = redactAgentAuthConfig("oidc", normalized);
    expect(redacted).not.toHaveProperty("audience");
    expect(redacted).not.toHaveProperty("audienceMode");
  });

  test("rejects an audience mode without an audience and an empty audience", () => {
    const base = { issuer: "https://idp.example", clientId: "client", clientSecret: "secret" };

    expect(() => normalizeAgentAuthConfig("oidc", { ...base, audienceMode: "resource" }))
      .toThrow("OIDC audience mode requires an audience.");
    expect(() => normalizeAgentAuthConfig("oidc", { ...base, audience: "" }))
      .toThrow("OIDC audience must be a non-empty string.");
  });
});
