import { describe, expect, test } from "vitest";

import {
  callerTokenAudience,
  normalizeIdentityProviderConnection,
  parseCallerTokenAudience,
  type ResolvedExternalIdentity,
} from "./identity.js";

describe("identity contracts", () => {
  test("normalizes an Internal provider without accepting OIDC fields", () => {
    expect(
      normalizeIdentityProviderConnection({
        type: "internal",
        displayName: " Eveland Internal ",
        internalRealmKey: " eveland-members ",
        enabled: true,
        issuer: "https://ignored.example",
      }),
    ).toEqual({
      type: "internal",
      displayName: "Eveland Internal",
      internalRealmKey: "eveland-members",
      enabled: true,
    });
  });

  test("rejects an Internal provider without a stable Realm key", () => {
    expect(() =>
      normalizeIdentityProviderConnection({
        type: "internal",
        displayName: "Eveland Internal",
        internalRealmKey: " ",
        enabled: false,
      }),
    ).toThrow(/realm key/i);
  });

  test("normalizes protocol-level OIDC configuration", () => {
    expect(
      normalizeIdentityProviderConnection({
        type: "oidc",
        displayName: "Company OIDC",
        issuer: "https://id.example/",
        clientId: " chat ",
        clientSecretConfigured: true,
        scopes: ["openid", " profile ", "openid"],
        authorizationParameters: { prompt: " select_account " },
        tokenEndpointAuthMethod: "client_secret_post",
        externalRealmResolution: "id_token_claim",
        externalRealmClaim: "account_id",
        enabled: false,
      }),
    ).toEqual({
      type: "oidc",
      displayName: "Company OIDC",
      issuer: "https://id.example",
      clientId: "chat",
      clientSecretConfigured: true,
      scopes: ["openid", "profile"],
      authorizationParameters: { prompt: "select_account" },
      tokenEndpointAuthMethod: "client_secret_post",
      externalRealmResolution: "id_token_claim",
      externalRealmClaim: "account_id",
      enabled: false,
    });
  });

  test("requires HTTPS OIDC issuer and a Realm claim for claim resolution", () => {
    expect(() =>
      normalizeIdentityProviderConnection({
        type: "oidc",
        displayName: "OIDC",
        issuer: "http://id.example",
        clientId: "chat",
        scopes: ["openid"],
        tokenEndpointAuthMethod: "none",
        externalRealmResolution: "id_token_claim",
        enabled: false,
      }),
    ).toThrow(/https/i);
  });

  test("builds and parses only project-bound caller-token audiences", () => {
    expect(callerTokenAudience("proj_abc123")).toBe("eveland:project:proj_abc123");
    expect(parseCallerTokenAudience("eveland:project:proj_abc123")).toBe("proj_abc123");
    expect(parseCallerTokenAudience("eveland:project:")).toBeNull();
    expect(parseCallerTokenAudience("other:proj_abc123")).toBeNull();
  });

  test("keeps provider-native concepts only on the adapter result", () => {
    const identity: ResolvedExternalIdentity = {
      externalRealmId: "account-123",
      externalRealmKind: "account",
      externalSubject: "user-456",
      displayName: "Test User",
      email: "user@example.com",
    };

    expect(identity).toEqual(
      expect.objectContaining({
        externalRealmId: "account-123",
        externalSubject: "user-456",
      }),
    );
  });
});
