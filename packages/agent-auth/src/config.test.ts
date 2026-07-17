import { describe, expect, test } from "vitest";
import {
  normalizeAgentAuthConfig,
  normalizeStoredOidcAuthorizationCodeConfig,
  redactAgentAuthConfig,
  resolveJinshujuOidcConfig,
} from "./config.js";

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
    expect(normalized).toHaveProperty("promptConsent", false);
    const redacted = redactAgentAuthConfig("oidc", normalized);
    expect(redacted).not.toHaveProperty("audience");
    expect(redacted).not.toHaveProperty("audienceMode");
  });

  test("only enables the consent prompt when offline access is requested", () => {
    expect(normalizeAgentAuthConfig("oidc", {
      issuer: "https://account.example",
      clientId: "eveland-playground",
    })).toMatchObject({ scopes: ["openid", "offline_access"], promptConsent: true });
    expect(normalizeAgentAuthConfig("oidc", {
      issuer: "https://account.example",
      clientId: "eveland-playground",
      scopes: ["openid", "profile"],
      promptConsent: true,
    })).toHaveProperty("promptConsent", false);
  });

  test("derives token endpoint authentication instead of accepting it as connection config", () => {
    const normalized = normalizeAgentAuthConfig("oidc", {
      issuer: "https://account.example",
      clientId: "eveland-playground",
      clientSecret: "secret_with_underscores__",
      tokenEndpointAuthMethod: "client_secret_post",
      scopes: ["openid", "profile"],
    });

    expect(normalized).not.toHaveProperty("tokenEndpointAuthMethod");
    expect(redactAgentAuthConfig("oidc", normalized)).not.toHaveProperty("tokenEndpointAuthMethod");
    expect(normalizeAgentAuthConfig("oidc", {
      issuer: "https://account.example",
      clientId: "eveland-playground",
      tokenEndpointAuthMethod: "client_secret_basic",
    })).not.toHaveProperty("tokenEndpointAuthMethod");
    expect(normalizeStoredOidcAuthorizationCodeConfig({
      issuer: "https://account.example",
      clientId: "eveland-playground",
      clientSecret: "legacy-secret",
      tokenEndpointAuthMethod: "client_secret_post",
    })).toMatchObject({ legacyTokenEndpointAuthMethod: "client_secret_post" });
    expect(normalizeStoredOidcAuthorizationCodeConfig({
      issuer: "https://account.example",
      clientId: "eveland-playground",
      clientSecret: "legacy-secret",
      tokenEndpointAuthMethod: "none",
    })).toMatchObject({ legacyTokenEndpointAuthMethod: "none" });
  });

  test("builds the server-managed Jinshuju OIDC configuration from environment variables", () => {
    const config = resolveJinshujuOidcConfig({
      JINSHUJU_OIDC_ISSUER: "https://account.example/",
      JINSHUJU_OIDC_CLIENT_ID: "eveland-client",
      JINSHUJU_OIDC_CLIENT_SECRET: "server-only-secret",
      JINSHUJU_OIDC_SCOPES: "openid public profile forms",
    });

    expect(config).toEqual({
      issuer: "https://account.example",
      clientId: "eveland-client",
      clientSecret: "server-only-secret",
      scopes: ["openid", "public", "profile", "forms"],
      promptConsent: false,
    });
    expect(normalizeAgentAuthConfig("jinshuju-oidc", { ignored: "browser-input" })).toEqual({});
    expect(redactAgentAuthConfig("jinshuju-oidc", config)).toEqual({});
  });

  test("uses public-client token authentication when the Jinshuju client secret is absent", () => {
    expect(resolveJinshujuOidcConfig({
      JINSHUJU_OIDC_ISSUER: "https://account.example",
      JINSHUJU_OIDC_CLIENT_ID: "eveland-client",
      JINSHUJU_OIDC_SCOPES: "openid profile",
    })).not.toHaveProperty("tokenEndpointAuthMethod");
  });

  test("rejects an audience mode without an audience and an empty audience", () => {
    const base = { issuer: "https://idp.example", clientId: "client", clientSecret: "secret" };

    expect(() => normalizeAgentAuthConfig("oidc", { ...base, audienceMode: "resource" }))
      .toThrow("OIDC audience mode requires an audience.");
    expect(() => normalizeAgentAuthConfig("oidc", { ...base, audience: "" }))
      .toThrow("OIDC audience must be a non-empty string.");
  });
});
