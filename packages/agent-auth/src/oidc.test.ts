import { describe, expect, test, vi } from "vitest";
import { createMemoryStore } from "@eveland/db";
import { ResponseBodyError } from "openid-client";
import { sealAgentAuthConfig } from "./config.js";
import { createOidcAuthorizationCodeProvider, selectOidcTokenEndpointAuthMethod } from "./oidc.js";

const appSecretKey = "0123456789abcdef0123456789abcdef";

describe("OIDC Agent Auth provider", () => {
  test("preserves explicit public-client authentication for a legacy Connection with a secret", () => {
    expect(selectOidcTokenEndpointAuthMethod({
      issuer: "https://idp.example",
      clientId: "legacy-client",
      clientSecret: "legacy-unused-secret",
      scopes: ["openid"],
      promptConsent: true,
      legacyTokenEndpointAuthMethod: "none",
    })).toBe("none");
  });

  test("accepts an Agent access-token subject that differs from the caller and ID-token subject", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "oidc-agent", importKind: "zip" });
    const connectionId = "acon_oidc_test";
    const config = {
      issuer: "https://idp.example",
      clientId: "eveland-playground",
      audience: "https://agent.example",
      scopes: ["openid", "offline_access"],
    };
    const connection = await store.createAgentConnection({
      id: connectionId,
      target: { kind: "managed-project", projectId: project.id },
      method: "oidc",
      configEncrypted: sealAgentAuthConfig(config, appSecretKey, {
        agentConnectionId: connectionId,
        method: "oidc",
        securityRevision: 1,
      }),
    });
    const provider = createOidcAuthorizationCodeProvider({
      store,
      appSecretKey,
      callbackUrl: "https://eveland.example/agent-auth/oidc/callback",
      protocol: {
        async preflight() {},
        async buildAuthorizationUrl(_config, transaction) {
          return new URL(`https://idp.example/authorize?state=${encodeURIComponent(transaction.state)}`);
        },
        async exchangeAuthorizationCode() {
          return {
            accessToken: "verified-agent-access-token",
            refreshToken: "agent-refresh-token",
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
            issuer: "https://idp.example",
            subject: "id-token-user-42",
          };
        },
        async refresh() {
          throw new Error("refresh should not run");
        },
        async fetchUserInfo() {
          throw new Error("fetchUserInfo should not run");
        },
      },
      verifyAccessToken: async () => ({ issuer: "https://idp.example", subject: "access-token-agent-user-42" }),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });
    const snapshot = { ...connection, config };

    const interaction = await provider.start({
      connection: snapshot,
      callerPrincipalId: "eveland-member-a",
      returnPath: `/projects/${project.id}/playground`,
    });
    const callback = await provider.callback({
      state: interaction.state,
      currentUrl: new URL(`${provider.callbackUrl}?code=authorization-code&state=${encodeURIComponent(interaction.state)}`),
      callerPrincipalId: "eveland-member-a",
      getConnection: async () => snapshot,
    });
    const callerACredential = await provider.registration.getCredential({
      target: { agentConnectionId: connection.id, callerPrincipalId: "eveland-member-a" },
      connection: snapshot,
      config,
    });
    const callerBCredential = await provider.registration.getCredential({
      target: { agentConnectionId: connection.id, callerPrincipalId: "eveland-member-b" },
      connection: snapshot,
      config,
    });

    expect(callback).toEqual({ returnPath: `/projects/${project.id}/playground` });
    expect(callerACredential).toEqual({
      credential: {
        kind: "headers",
        headers: [["authorization", "Bearer verified-agent-access-token"]],
      },
      version: { securityRevision: 1, rotationSeq: 0 },
    });
    expect(callerBCredential).toMatchObject({ code: "interaction_required" });
    const reauthorization = await provider.start({
      connection: snapshot,
      callerPrincipalId: "eveland-member-a",
      returnPath: `/projects/${project.id}/playground`,
    });
    await provider.callback({
      state: reauthorization.state,
      currentUrl: new URL(`${provider.callbackUrl}?code=new-code&state=${encodeURIComponent(reauthorization.state)}`),
      callerPrincipalId: "eveland-member-a",
      getConnection: async () => snapshot,
    });
    const terminalRecovery = await provider.registration.recoverUnauthorized!({
      target: { agentConnectionId: connection.id, callerPrincipalId: "eveland-member-a" },
      connection: snapshot,
      config,
      attempt: 1,
      rejectedVersion: { securityRevision: 1, rotationSeq: 0 },
    });
    expect(terminalRecovery).toMatchObject({ action: "give_up", failure: { code: "retry_required" } });
    const storedCredential = await store.getAgentAuthCredential({
      agentConnectionId: connection.id,
      securityRevision: 1,
      authMethod: "oidc",
      credentialScope: "principal",
      scopeSubject: "eveland-member-a",
      credentialKey: "",
    });
    expect(storedCredential).toMatchObject({ rotationSeq: 1 });
    expect(storedCredential?.payloadEncrypted).not.toContain("verified-agent-access-token");
    expect(storedCredential?.payloadEncrypted).not.toContain("agent-refresh-token");
  });

  test("refreshes an expired credential under a fenced lease before returning it", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "refresh-oidc-agent", importKind: "zip" });
    const connectionId = "acon_oidc_refresh";
    const config = {
      issuer: "https://idp.example",
      clientId: "eveland-playground",
      audience: "https://agent.example",
      audienceMode: "resource" as const,
      scopes: ["openid", "offline_access"],
      promptConsent: true,
    };
    const connection = await store.createAgentConnection({
      id: connectionId,
      target: { kind: "managed-project", projectId: project.id },
      method: "oidc",
      configEncrypted: sealAgentAuthConfig(config, appSecretKey, {
        agentConnectionId: connectionId,
        method: "oidc",
        securityRevision: 1,
      }),
    });
    let refreshCalls = 0;
    const provider = createOidcAuthorizationCodeProvider({
      store,
      appSecretKey,
      callbackUrl: "https://eveland.example/agent-auth/oidc/callback",
      protocol: {
        async preflight() {},
        async buildAuthorizationUrl(_config, transaction) {
          return new URL(`https://idp.example/authorize?state=${transaction.state}`);
        },
        async exchangeAuthorizationCode() {
          return {
            accessToken: "expired-access-token",
            refreshToken: "rotating-refresh-token",
            expiresAt: new Date("2028-12-31T23:00:00.000Z"),
            issuer: "https://idp.example",
            subject: "id-token-user-refresh",
          };
        },
        async refresh(_config, refreshToken, subject) {
          refreshCalls += 1;
          expect(refreshToken).toBe("rotating-refresh-token");
          expect(subject).toBe("id-token-user-refresh");
          return {
            accessToken: "refreshed-access-token",
            refreshToken: "rotated-refresh-token",
            expiresAt: new Date("2029-01-01T01:00:00.000Z"),
            issuer: "https://idp.example",
            subject,
          };
        },
        async fetchUserInfo() {
          throw new Error("fetchUserInfo should not run");
        },
      },
      verifyAccessToken: async () => ({ issuer: "https://idp.example", subject: "access-token-agent-user-refresh" }),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });
    const snapshot = { ...connection, config };
    const interaction = await provider.start({
      connection: snapshot,
      callerPrincipalId: "eveland-member-refresh",
      returnPath: `/projects/${project.id}/playground`,
    });
    await provider.callback({
      state: interaction.state,
      currentUrl: new URL(`${provider.callbackUrl}?code=authorization-code&state=${interaction.state}`),
      callerPrincipalId: "eveland-member-refresh",
      getConnection: async () => snapshot,
    });

    const status = await provider.registration.inspect!({
      target: { agentConnectionId: connection.id, callerPrincipalId: "eveland-member-refresh" },
      connection: snapshot,
      config,
    });
    expect(status).toEqual({ state: "credential_available" });
    expect(refreshCalls).toBe(0);

    const credential = await provider.registration.getCredential({
      target: { agentConnectionId: connection.id, callerPrincipalId: "eveland-member-refresh" },
      connection: snapshot,
      config,
    });

    expect(credential).toEqual({
      credential: {
        kind: "headers",
        headers: [["authorization", "Bearer refreshed-access-token"]],
      },
      version: { securityRevision: 1, rotationSeq: 1 },
    });
    expect(refreshCalls).toBe(1);
    await expect(store.getAgentAuthCredential({
      agentConnectionId: connection.id,
      securityRevision: 1,
      authMethod: "oidc",
      credentialScope: "principal",
      scopeSubject: "eveland-member-refresh",
      credentialKey: "",
    })).resolves.toMatchObject({ rotationSeq: 1, refreshLeaseId: null });
  });

  test("keeps the winning credential decryptable when two callbacks complete concurrently", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "concurrent-oidc-agent", importKind: "zip" });
    const connectionId = "acon_oidc_concurrent";
    const config = {
      issuer: "https://idp.example",
      clientId: "eveland-playground",
      audience: "https://agent.example",
      scopes: ["openid"],
    };
    const connection = await store.createAgentConnection({
      id: connectionId,
      target: { kind: "managed-project", projectId: project.id },
      method: "oidc",
      configEncrypted: sealAgentAuthConfig(config, appSecretKey, {
        agentConnectionId: connectionId,
        method: "oidc",
        securityRevision: 1,
      }),
    });
    let exchanges = 0;
    const provider = createOidcAuthorizationCodeProvider({
      store,
      appSecretKey,
      callbackUrl: "https://eveland.example/agent-auth/oidc/callback",
      protocol: {
        async preflight() {},
        async buildAuthorizationUrl(_config, transaction) {
          return new URL(`https://idp.example/authorize?state=${transaction.state}`);
        },
        async exchangeAuthorizationCode() {
          exchanges += 1;
          return {
            accessToken: `concurrent-access-token-${exchanges}`,
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
            issuer: "https://idp.example",
            subject: "agent-user-concurrent",
          };
        },
        async refresh() {
          throw new Error("refresh should not run");
        },
        async fetchUserInfo() {
          throw new Error("fetchUserInfo should not run");
        },
      },
      verifyAccessToken: async () => ({ issuer: "https://idp.example", subject: "agent-user-concurrent" }),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });
    const snapshot = { ...connection, config };
    const [first, second] = await Promise.all([
      provider.start({ connection: snapshot, callerPrincipalId: "member-a", returnPath: `/projects/${project.id}/playground` }),
      provider.start({ connection: snapshot, callerPrincipalId: "member-a", returnPath: `/projects/${project.id}/playground` }),
    ]);

    await Promise.all([first, second].map((interaction) => provider.callback({
      state: interaction.state,
      currentUrl: new URL(`${provider.callbackUrl}?code=authorization-code&state=${interaction.state}`),
      callerPrincipalId: "member-a",
      getConnection: async () => snapshot,
    })));

    const credential = await provider.registration.getCredential({
      target: { agentConnectionId: connection.id, callerPrincipalId: "member-a" },
      connection: snapshot,
      config,
    });
    expect(credential).toMatchObject({
      credential: { kind: "headers", headers: [["authorization", expect.stringMatching(/^Bearer concurrent-access-token-/)]] },
      version: { securityRevision: 1, rotationSeq: 1 },
    });
  });

  test("requests authorization again when an expired refresh grant is invalid", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "invalid-grant-agent", importKind: "zip" });
    const connectionId = "acon_oidc_invalid_grant";
    const config = {
      issuer: "https://idp.example",
      clientId: "eveland-playground",
      audience: "https://agent.example",
      scopes: ["openid", "offline_access"],
    };
    const connection = await store.createAgentConnection({
      id: connectionId,
      target: { kind: "managed-project", projectId: project.id },
      method: "oidc",
      configEncrypted: sealAgentAuthConfig(config, appSecretKey, {
        agentConnectionId: connectionId,
        method: "oidc",
        securityRevision: 1,
      }),
    });
    const provider = createOidcAuthorizationCodeProvider({
      store,
      appSecretKey,
      callbackUrl: "https://eveland.example/agent-auth/oidc/callback",
      protocol: {
        async preflight() {},
        async buildAuthorizationUrl(_config, transaction) {
          return new URL(`https://idp.example/authorize?state=${transaction.state}`);
        },
        async exchangeAuthorizationCode() {
          return {
            accessToken: "expired-access-token",
            refreshToken: "invalid-refresh-token",
            expiresAt: new Date("2028-12-31T23:00:00.000Z"),
            issuer: "https://idp.example",
            subject: "agent-user-invalid-grant",
          };
        },
        async refresh() {
          throw new ResponseBodyError("invalid_grant", {
            cause: { error: "invalid_grant" },
            response: new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
          });
        },
        async fetchUserInfo() {
          throw new Error("fetchUserInfo should not run");
        },
      },
      verifyAccessToken: async (_token, _config, expected) => expected,
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });
    const snapshot = { ...connection, config };
    const interaction = await provider.start({
      connection: snapshot,
      callerPrincipalId: "member-a",
      returnPath: `/projects/${project.id}/playground`,
    });
    await provider.callback({
      state: interaction.state,
      currentUrl: new URL(`${provider.callbackUrl}?code=authorization-code&state=${interaction.state}`),
      callerPrincipalId: "member-a",
      getConnection: async () => snapshot,
    });

    const credential = await provider.registration.getCredential({
      target: { agentConnectionId: connection.id, callerPrincipalId: "member-a" },
      connection: snapshot,
      config,
      interaction: { returnPath: `/projects/${project.id}/playground` },
    });

    expect(credential).toMatchObject({ code: "interaction_required", interaction: { type: "redirect" } });
  });

  test("activates a pending token whose access-token subject differs from the ID-token subject", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "pending-verification-agent", importKind: "zip" });
    const connectionId = "acon_oidc_pending_verification";
    const config = {
      issuer: "https://idp.example",
      clientId: "eveland-playground",
      audience: "https://agent.example",
      scopes: ["openid"],
    };
    const connection = await store.createAgentConnection({
      id: connectionId,
      target: { kind: "managed-project", projectId: project.id },
      method: "oidc",
      configEncrypted: sealAgentAuthConfig(config, appSecretKey, {
        agentConnectionId: connectionId,
        method: "oidc",
        securityRevision: 1,
      }),
    });
    let verifyCalls = 0;
    const provider = createOidcAuthorizationCodeProvider({
      store,
      appSecretKey,
      callbackUrl: "https://eveland.example/agent-auth/oidc/callback",
      protocol: {
        async preflight() {},
        async buildAuthorizationUrl(_config, transaction) {
          return new URL(`https://idp.example/authorize?state=${transaction.state}`);
        },
        async exchangeAuthorizationCode() {
          return {
            accessToken: "candidate-access-token",
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
            issuer: "https://idp.example",
            subject: "id-token-user-pending",
          };
        },
        async refresh() {
          throw new Error("refresh should not run");
        },
        async fetchUserInfo() {
          throw new Error("fetchUserInfo should not run");
        },
      },
      verifyAccessToken: async () => {
        verifyCalls += 1;
        if (verifyCalls < 3) throw new Error("JWKS endpoint unavailable");
        return { issuer: "https://idp.example", subject: "access-token-agent-user-pending" };
      },
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });
    const snapshot = { ...connection, config };
    const interaction = await provider.start({
      connection: snapshot,
      callerPrincipalId: "member-a",
      returnPath: `/projects/${project.id}/playground`,
    });
    await provider.callback({
      state: interaction.state,
      currentUrl: new URL(`${provider.callbackUrl}?code=authorization-code&state=${interaction.state}`),
      callerPrincipalId: "member-a",
      getConnection: async () => snapshot,
    });

    const unavailable = await provider.registration.getCredential({
      target: { agentConnectionId: connection.id, callerPrincipalId: "member-a" },
      connection: snapshot,
      config,
    });
    const verified = await provider.registration.getCredential({
      target: { agentConnectionId: connection.id, callerPrincipalId: "member-a" },
      connection: snapshot,
      config,
    });

    expect(unavailable).toMatchObject({ code: "provider_unavailable" });
    expect(verified).toEqual({
      credential: { kind: "headers", headers: [["authorization", "Bearer candidate-access-token"]] },
      version: { securityRevision: 1, rotationSeq: 1 },
    });
  });

  test("verifies an audience-less opaque access token through the UserInfo endpoint", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "oidc-userinfo", importKind: "zip" });
    const connectionId = "acon_oidc_userinfo";
    const config = {
      issuer: "https://account.example",
      clientId: "eveland-playground",
      scopes: ["openid", "profile"],
    };
    const connection = await store.createAgentConnection({
      id: connectionId,
      target: { kind: "managed-project", projectId: project.id },
      method: "oidc",
      configEncrypted: sealAgentAuthConfig(config, appSecretKey, {
        agentConnectionId: connectionId,
        method: "oidc",
        securityRevision: 1,
      }),
    });
    const fetchUserInfoCalls: Array<{ accessToken: string; expectedSubject: string }> = [];
    const provider = createOidcAuthorizationCodeProvider({
      store,
      appSecretKey,
      callbackUrl: "https://eveland.example/agent-auth/oidc/callback",
      protocol: {
        async preflight() {},
        async buildAuthorizationUrl(oidcConfig, transaction) {
          expect(oidcConfig).not.toHaveProperty("audience");
          return new URL(`https://account.example/authorize?state=${encodeURIComponent(transaction.state)}`);
        },
        async exchangeAuthorizationCode() {
          return {
            accessToken: "opaque-access-token",
            refreshToken: "opaque-refresh-token",
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
            issuer: "https://account.example",
            subject: "jinshuju-user-42",
          };
        },
        async refresh() {
          throw new Error("refresh should not run");
        },
        async fetchUserInfo(_config, accessToken, expectedSubject) {
          fetchUserInfoCalls.push({ accessToken, expectedSubject });
          if (accessToken !== "opaque-access-token") return { outcome: "rejected", message: "Unknown access token." };
          return { outcome: "ok", subject: expectedSubject };
        },
      },
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });
    const snapshot = { ...connection, config };

    const interaction = await provider.start({
      connection: snapshot,
      callerPrincipalId: "eveland-member-a",
      returnPath: `/projects/${project.id}/playground`,
    });
    const callback = await provider.callback({
      state: interaction.state,
      currentUrl: new URL(`${provider.callbackUrl}?code=authorization-code&state=${encodeURIComponent(interaction.state)}`),
      callerPrincipalId: "eveland-member-a",
      getConnection: async () => snapshot,
    });
    const credential = await provider.registration.getCredential({
      target: { agentConnectionId: connection.id, callerPrincipalId: "eveland-member-a" },
      connection: snapshot,
      config,
    });

    expect(callback).toEqual({ returnPath: `/projects/${project.id}/playground` });
    // OIDC Core 5.3.2: the UserInfo subject must be compared against the ID-token subject.
    expect(fetchUserInfoCalls).toEqual([{ accessToken: "opaque-access-token", expectedSubject: "jinshuju-user-42" }]);
    expect(credential).toEqual({
      credential: { kind: "headers", headers: [["authorization", "Bearer opaque-access-token"]] },
      version: { securityRevision: 1, rotationSeq: 0 },
    });
  });

  test("fails the callback when the UserInfo endpoint definitively rejects the audience-less token", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "oidc-userinfo-rejected", importKind: "zip" });
    const connectionId = "acon_oidc_userinfo_rejected";
    const config = {
      issuer: "https://account.example",
      clientId: "eveland-playground",
      scopes: ["openid"],
    };
    const connection = await store.createAgentConnection({
      id: connectionId,
      target: { kind: "managed-project", projectId: project.id },
      method: "oidc",
      configEncrypted: sealAgentAuthConfig(config, appSecretKey, {
        agentConnectionId: connectionId,
        method: "oidc",
        securityRevision: 1,
      }),
    });
    const provider = createOidcAuthorizationCodeProvider({
      store,
      appSecretKey,
      callbackUrl: "https://eveland.example/agent-auth/oidc/callback",
      protocol: {
        async preflight() {},
        async buildAuthorizationUrl(_config, transaction) {
          return new URL(`https://account.example/authorize?state=${encodeURIComponent(transaction.state)}`);
        },
        async exchangeAuthorizationCode() {
          return {
            accessToken: "token-for-someone-else",
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
            issuer: "https://account.example",
            subject: "jinshuju-user-42",
          };
        },
        async refresh() {
          throw new Error("refresh should not run");
        },
        async fetchUserInfo() {
          return { outcome: "rejected", message: "The UserInfo subject does not match the authorized user." };
        },
      },
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });
    const snapshot = { ...connection, config };

    const interaction = await provider.start({
      connection: snapshot,
      callerPrincipalId: "eveland-member-a",
      returnPath: `/projects/${project.id}/playground`,
    });

    await expect(provider.callback({
      state: interaction.state,
      currentUrl: new URL(`${provider.callbackUrl}?code=authorization-code&state=${encodeURIComponent(interaction.state)}`),
      callerPrincipalId: "eveland-member-a",
      getConnection: async () => snapshot,
    })).rejects.toThrow("The UserInfo subject does not match the authorized user.");
    await expect(store.getAgentAuthCredential({
      agentConnectionId: connection.id,
      securityRevision: 1,
      authMethod: "oidc",
      credentialScope: "principal",
      scopeSubject: "eveland-member-a",
      credentialKey: "",
    })).resolves.toBeNull();
  });

  test("keeps an audience-less credential pending while UserInfo is unavailable, then activates it", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "oidc-userinfo-pending", importKind: "zip" });
    const connectionId = "acon_oidc_userinfo_pending";
    const config = {
      issuer: "https://account.example",
      clientId: "eveland-playground",
      scopes: ["openid"],
    };
    const connection = await store.createAgentConnection({
      id: connectionId,
      target: { kind: "managed-project", projectId: project.id },
      method: "oidc",
      configEncrypted: sealAgentAuthConfig(config, appSecretKey, {
        agentConnectionId: connectionId,
        method: "oidc",
        securityRevision: 1,
      }),
    });
    let userInfoAvailable = false;
    const provider = createOidcAuthorizationCodeProvider({
      store,
      appSecretKey,
      callbackUrl: "https://eveland.example/agent-auth/oidc/callback",
      protocol: {
        async preflight() {},
        async buildAuthorizationUrl(_config, transaction) {
          return new URL(`https://account.example/authorize?state=${encodeURIComponent(transaction.state)}`);
        },
        async exchangeAuthorizationCode() {
          return {
            accessToken: "opaque-access-token",
            refreshToken: "opaque-refresh-token",
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
            issuer: "https://account.example",
            subject: "jinshuju-user-42",
          };
        },
        async refresh() {
          throw new Error("refresh should not run");
        },
        async fetchUserInfo(_config, _accessToken, expectedSubject) {
          if (!userInfoAvailable) throw new Error("userinfo endpoint unreachable");
          return { outcome: "ok", subject: expectedSubject };
        },
      },
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });
    const snapshot = { ...connection, config };

    const interaction = await provider.start({
      connection: snapshot,
      callerPrincipalId: "eveland-member-a",
      returnPath: `/projects/${project.id}/playground`,
    });
    await provider.callback({
      state: interaction.state,
      currentUrl: new URL(`${provider.callbackUrl}?code=authorization-code&state=${encodeURIComponent(interaction.state)}`),
      callerPrincipalId: "eveland-member-a",
      getConnection: async () => snapshot,
    });
    const unavailable = await provider.registration.getCredential({
      target: { agentConnectionId: connection.id, callerPrincipalId: "eveland-member-a" },
      connection: snapshot,
      config,
    });
    userInfoAvailable = true;
    const activated = await provider.registration.getCredential({
      target: { agentConnectionId: connection.id, callerPrincipalId: "eveland-member-a" },
      connection: snapshot,
      config,
    });

    expect(unavailable).toMatchObject({ code: "provider_unavailable" });
    expect(activated).toEqual({
      credential: { kind: "headers", headers: [["authorization", "Bearer opaque-access-token"]] },
      version: { securityRevision: 1, rotationSeq: 1 },
    });
  });
});
