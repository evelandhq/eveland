import { createTestStore } from "@evelandhq/db/vitest";
import { describe, expect, test } from "vitest";
import { createOidcAuthorizationCodeProvider, type OidcProtocol } from "./oidc.js";

const appSecretKey = "0123456789abcdef0123456789abcdef";
const config = {
  issuer: "https://idp.example",
  clientId: "eveland-playground",
  clientSecretRef: { kind: "project-secret" as const, key: "OIDC_CLIENT_SECRET" },
  scopes: ["openid", "offline_access"],
  audience: "https://agent.example",
  audienceMode: "resource" as const,
  tokenEndpointAuthMethod: "client_secret_basic" as const,
  authorizationParams: { prompt: "consent" },
  accessTokenVerification: "eve-jwt" as const,
};

describe("generic OIDC Authorization Code provider", () => {
  test("uses PKCE, state, and nonce and activates only the verified caller credential", async () => {
    const { store, connection, snapshot } = await fixture("oidc-verified");
    let authorizationTransaction:
      | { state: string; codeVerifier: string; nonce: string }
      | undefined;
    const provider = createOidcAuthorizationCodeProvider({
      store,
      appSecretKey,
      callbackUrl: "https://eveland.example/agent-auth/oidc/callback",
      resolveClientSecret: async () => "client-secret",
      protocol: protocol({
        async buildAuthorizationUrl(_config, _secret, transaction) {
          authorizationTransaction = transaction;
          return new URL(`https://idp.example/authorize?state=${transaction.state}`);
        },
      }),
      verifyAccessToken: async () => ({ issuer: config.issuer, subject: "agent-access-subject" }),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });

    const interaction = await provider.start({
      connection: snapshot,
      callerPrincipalId: "member-a",
      returnPath: `/projects/${connection.target.projectId}/playground`,
    });
    expect(authorizationTransaction).toMatchObject({ state: interaction.state });
    expect(authorizationTransaction?.codeVerifier).not.toBe(authorizationTransaction?.state);
    expect(authorizationTransaction?.nonce).not.toBe(authorizationTransaction?.state);

    await provider.callback({
      state: interaction.state,
      currentUrl: new URL(`${provider.callbackUrl}?code=code&state=${interaction.state}`),
      callerPrincipalId: "member-a",
      getConnection: async () => snapshot,
    });

    await expect(
      provider.getCredential({ connection: snapshot, callerPrincipalId: "member-a" }),
    ).resolves.toMatchObject({
      envelope: { headers: [["authorization", "Bearer access-token"]] },
      version: { securityRevision: 1, rotationSeq: 0 },
    });
    await expect(
      provider.getCredential({ connection: snapshot, callerPrincipalId: "member-b" }),
    ).resolves.toMatchObject({
      failure: { code: "interaction_required" },
    });
    const stored = await store.getAgentAuthCredential(credentialKey(connection.id, "member-a"));
    expect(stored?.payloadEncrypted).not.toContain("access-token");
    expect(stored?.payloadEncrypted).not.toContain("refresh-token");
  });

  test("atomically consumes transactions and rejects caller or revision mismatches", async () => {
    const { store, connection, snapshot } = await fixture("oidc-transaction");
    const provider = createOidcAuthorizationCodeProvider({
      store,
      appSecretKey,
      callbackUrl: "https://eveland.example/agent-auth/oidc/callback",
      resolveClientSecret: async () => "client-secret",
      protocol: protocol(),
      verifyAccessToken: async () => ({ issuer: config.issuer, subject: "subject" }),
    });
    const start = () =>
      provider.start({
        connection: snapshot,
        callerPrincipalId: "member-a",
        returnPath: `/projects/${connection.target.projectId}/playground`,
      });

    const callerMismatch = await start();
    await expect(
      provider.callback({
        state: callerMismatch.state,
        currentUrl: new URL(`${provider.callbackUrl}?code=code&state=${callerMismatch.state}`),
        callerPrincipalId: "member-b",
        getConnection: async () => snapshot,
      }),
    ).rejects.toThrow(/different caller/i);
    await expect(
      provider.callback({
        state: callerMismatch.state,
        currentUrl: new URL(`${provider.callbackUrl}?code=code&state=${callerMismatch.state}`),
        callerPrincipalId: "member-a",
        getConnection: async () => snapshot,
      }),
    ).rejects.toThrow(/invalid, expired, or already used/i);

    const revisionMismatch = await start();
    await expect(
      provider.callback({
        state: revisionMismatch.state,
        currentUrl: new URL(`${provider.callbackUrl}?code=code&state=${revisionMismatch.state}`),
        callerPrincipalId: "member-a",
        getConnection: async () => ({ ...snapshot, securityRevision: 2 }),
      }),
    ).rejects.toThrow(/Playground authentication changed/i);

    let current = new Date("2029-01-01T00:00:00.000Z");
    const expiringProvider = createOidcAuthorizationCodeProvider({
      store,
      appSecretKey,
      callbackUrl: provider.callbackUrl,
      resolveClientSecret: async () => "client-secret",
      protocol: protocol(),
      verifyAccessToken: async () => ({ issuer: config.issuer, subject: "subject" }),
      now: () => current,
    });
    const expired = await expiringProvider.start({
      connection: snapshot,
      callerPrincipalId: "member-a",
      returnPath: `/projects/${connection.target.projectId}/playground`,
    });
    current = new Date("2029-01-01T00:11:00.000Z");
    await expect(
      expiringProvider.callback({
        state: expired.state,
        currentUrl: new URL(`${provider.callbackUrl}?code=code&state=${expired.state}`),
        callerPrincipalId: "member-a",
        getConnection: async () => snapshot,
      }),
    ).rejects.toThrow(/invalid, expired, or already used/i);

    let currentSnapshot = snapshot;
    const racingProvider = createOidcAuthorizationCodeProvider({
      store,
      appSecretKey,
      callbackUrl: provider.callbackUrl,
      resolveClientSecret: async () => "client-secret",
      protocol: protocol({
        async exchangeAuthorizationCode() {
          currentSnapshot = { ...snapshot, securityRevision: 2 };
          return {
            accessToken: "stale-callback-token",
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
            issuer: config.issuer,
            subject: "id-token-subject",
          };
        },
      }),
      verifyAccessToken: async () => ({ issuer: config.issuer, subject: "subject" }),
    });
    const racing = await racingProvider.start({
      connection: snapshot,
      callerPrincipalId: "member-race",
      returnPath: `/projects/${connection.target.projectId}/playground`,
    });
    await expect(
      racingProvider.callback({
        state: racing.state,
        currentUrl: new URL(`${provider.callbackUrl}?code=code&state=${racing.state}`),
        callerPrincipalId: "member-race",
        getConnection: async () => currentSnapshot,
      }),
    ).rejects.toThrow(/Playground authentication changed/i);
    await expect(
      store.getAgentAuthCredential(credentialKey(connection.id, "member-race")),
    ).resolves.toBeNull();
  });

  test("coalesces refresh, rotates the refresh token, and returns the fenced winner", async () => {
    const { store, connection, snapshot } = await fixture("oidc-refresh");
    let refreshCalls = 0;
    const provider = createOidcAuthorizationCodeProvider({
      store,
      appSecretKey,
      callbackUrl: "https://eveland.example/agent-auth/oidc/callback",
      resolveClientSecret: async () => "client-secret",
      protocol: protocol({
        async exchangeAuthorizationCode() {
          return {
            accessToken: "expired-token",
            refreshToken: "refresh-token",
            expiresAt: new Date("2028-12-31T23:00:00.000Z"),
            issuer: config.issuer,
            subject: "id-token-subject",
          };
        },
        async refresh(_config, _secret, refreshToken, subject) {
          refreshCalls += 1;
          expect(refreshToken).toBe("refresh-token");
          await Promise.resolve();
          return {
            accessToken: "refreshed-token",
            refreshToken: "rotated-refresh-token",
            expiresAt: new Date("2029-01-01T01:00:00.000Z"),
            issuer: config.issuer,
            subject,
          };
        },
      }),
      verifyAccessToken: async () => ({ issuer: config.issuer, subject: "agent-subject" }),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });
    const interaction = await provider.start({
      connection: snapshot,
      callerPrincipalId: "member-a",
      returnPath: `/projects/${connection.target.projectId}/playground`,
    });
    await provider.callback({
      state: interaction.state,
      currentUrl: new URL(`${provider.callbackUrl}?code=code&state=${interaction.state}`),
      callerPrincipalId: "member-a",
      getConnection: async () => snapshot,
    });

    const [first, second] = await Promise.all([
      provider.getCredential({ connection: snapshot, callerPrincipalId: "member-a" }),
      provider.getCredential({ connection: snapshot, callerPrincipalId: "member-a" }),
    ]);
    expect(first).toMatchObject({
      envelope: { headers: [["authorization", "Bearer refreshed-token"]] },
    });
    expect(second).toEqual(first);
    expect(refreshCalls).toBe(1);
    await expect(
      store.getAgentAuthCredential(credentialKey(connection.id, "member-a")),
    ).resolves.toMatchObject({
      rotationSeq: 1,
      refreshLeaseId: null,
    });
  });

  test("fails closed instead of live-looping when the IdP only mints immediately-expiring credentials", async () => {
    const { store, connection, snapshot } = await fixture("oidc-livelock");
    const fixedNow = new Date("2029-01-01T00:00:00.000Z");
    let refreshCalls = 0;
    const provider = createOidcAuthorizationCodeProvider({
      store,
      appSecretKey,
      callbackUrl: "https://eveland.example/agent-auth/oidc/callback",
      resolveClientSecret: async () => "client-secret",
      protocol: protocol({
        async exchangeAuthorizationCode() {
          return {
            accessToken: "expired-token",
            refreshToken: "refresh-token",
            expiresAt: new Date("2028-12-31T23:00:00.000Z"),
            issuer: config.issuer,
            subject: "id-token-subject",
          };
        },
        async refresh(_config, _secret, _refreshToken, subject) {
          refreshCalls += 1;
          // Legal per RFC 6749: every refreshed token is already inside the
          // 30-second expiring-soon window when it arrives.
          return {
            accessToken: `short-lived-${refreshCalls}`,
            refreshToken: "refresh-token",
            expiresAt: new Date(fixedNow.getTime() + 10_000),
            issuer: config.issuer,
            subject,
          };
        },
      }),
      verifyAccessToken: async () => ({ issuer: config.issuer, subject: "agent-subject" }),
      now: () => fixedNow,
    });
    const interaction = await provider.start({
      connection: snapshot,
      callerPrincipalId: "member-a",
      returnPath: `/projects/${connection.target.projectId}/playground`,
    });
    await provider.callback({
      state: interaction.state,
      currentUrl: new URL(`${provider.callbackUrl}?code=code&state=${interaction.state}`),
      callerPrincipalId: "member-a",
      getConnection: async () => snapshot,
    });

    await expect(
      provider.getCredential({ connection: snapshot, callerPrincipalId: "member-a" }),
    ).resolves.toMatchObject({ failure: { code: "provider_unavailable" } });
    // Bounded refresh work, not one network call per recursion forever.
    expect(refreshCalls).toBeLessThanOrEqual(2);
  });

  test("keeps a temporarily unverifiable UserInfo token pending and permanently rejects subject mismatch", async () => {
    const { store, connection } = await fixture("oidc-userinfo");
    const userinfoConfig = {
      ...config,
      clientSecretRef: undefined,
      audience: undefined,
      audienceMode: undefined,
      tokenEndpointAuthMethod: "none" as const,
      accessTokenVerification: "userinfo" as const,
    };
    const snapshot = { ...connection, config: userinfoConfig };
    let userInfoAvailable = false;
    const provider = createOidcAuthorizationCodeProvider({
      store,
      appSecretKey,
      callbackUrl: "https://eveland.example/agent-auth/oidc/callback",
      resolveClientSecret: async () => undefined,
      protocol: protocol({
        async fetchUserInfo() {
          if (!userInfoAvailable) throw new Error("temporary IdP outage");
          return { subject: "id-token-subject" };
        },
      }),
    });
    const interaction = await provider.start({
      connection: snapshot,
      callerPrincipalId: "member-a",
      returnPath: `/projects/${connection.target.projectId}/playground`,
    });
    await provider.callback({
      state: interaction.state,
      currentUrl: new URL(`${provider.callbackUrl}?code=code&state=${interaction.state}`),
      callerPrincipalId: "member-a",
      getConnection: async () => snapshot,
    });
    await expect(
      provider.getCredential({ connection: snapshot, callerPrincipalId: "member-a" }),
    ).resolves.toMatchObject({
      failure: { code: "provider_unavailable" },
    });
    userInfoAvailable = true;
    await expect(
      provider.getCredential({ connection: snapshot, callerPrincipalId: "member-a" }),
    ).resolves.toMatchObject({
      envelope: { headers: [["authorization", "Bearer access-token"]] },
    });

    const rejected = createOidcAuthorizationCodeProvider({
      store,
      appSecretKey,
      callbackUrl: "https://eveland.example/agent-auth/oidc/callback",
      resolveClientSecret: async () => undefined,
      protocol: protocol({
        async fetchUserInfo() {
          throw { code: "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED" };
        },
      }),
    });
    const second = await rejected.start({
      connection: snapshot,
      callerPrincipalId: "member-b",
      returnPath: `/projects/${connection.target.projectId}/playground`,
    });
    await expect(
      rejected.callback({
        state: second.state,
        currentUrl: new URL(`${rejected.callbackUrl}?code=code&state=${second.state}`),
        callerPrincipalId: "member-b",
        getConnection: async () => snapshot,
      }),
    ).rejects.toThrow(/subject/i);
    await expect(
      store.getAgentAuthCredential(credentialKey(connection.id, "member-b")),
    ).resolves.toBeNull();
  });

  test("lets one provider instance refresh while another waits for the rotated credential", async () => {
    const { store, connection, snapshot } = await fixture("oidc-cross-instance");
    let refreshCalls = 0;
    const sharedProtocol = protocol({
      async exchangeAuthorizationCode() {
        return {
          accessToken: "expired-token",
          refreshToken: "refresh-token",
          expiresAt: new Date("2028-12-31T23:00:00.000Z"),
          issuer: config.issuer,
          subject: "id-token-subject",
        };
      },
      async refresh(_config, _secret, _refreshToken, subject) {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          accessToken: "cross-instance-token",
          refreshToken: "rotated-token",
          expiresAt: new Date("2029-01-01T01:00:00.000Z"),
          issuer: config.issuer,
          subject,
        };
      },
    });
    const options = {
      store,
      appSecretKey,
      callbackUrl: "https://eveland.example/agent-auth/oidc/callback",
      resolveClientSecret: async () => "client-secret",
      protocol: sharedProtocol,
      verifyAccessToken: async () => ({ issuer: config.issuer, subject: "agent-subject" }),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
      refreshWaitMs: 2_000,
    };
    const firstProvider = createOidcAuthorizationCodeProvider(options);
    const secondProvider = createOidcAuthorizationCodeProvider(options);
    const interaction = await firstProvider.start({
      connection: snapshot,
      callerPrincipalId: "member-a",
      returnPath: `/projects/${connection.target.projectId}/playground`,
    });
    await firstProvider.callback({
      state: interaction.state,
      currentUrl: new URL(`${firstProvider.callbackUrl}?code=code&state=${interaction.state}`),
      callerPrincipalId: "member-a",
      getConnection: async () => snapshot,
    });

    const [first, second] = await Promise.all([
      firstProvider.getCredential({ connection: snapshot, callerPrincipalId: "member-a" }),
      secondProvider.getCredential({ connection: snapshot, callerPrincipalId: "member-a" }),
    ]);
    expect(first).toMatchObject({
      envelope: { headers: [["authorization", "Bearer cross-instance-token"]] },
    });
    expect(second).toEqual(first);
    expect(refreshCalls).toBe(1);
  });
});

function protocol(overrides: Partial<OidcProtocol> = {}): OidcProtocol {
  return {
    async preflight() {},
    async buildAuthorizationUrl(_config, _secret, transaction) {
      return new URL(`https://idp.example/authorize?state=${transaction.state}`);
    },
    async exchangeAuthorizationCode() {
      return {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        issuer: config.issuer,
        subject: "id-token-subject",
      };
    },
    async refresh() {
      throw new Error("refresh should not run");
    },
    async fetchUserInfo() {
      return { subject: "id-token-subject" };
    },
    ...overrides,
  };
}

async function fixture(name: string) {
  const store = createTestStore();
  const project = await store.createProject({ name, importKind: "zip" });
  const connection = await store.createAgentConnection({
    id: `acon_${name.replaceAll("-", "_")}`,
    target: { kind: "managed-project", projectId: project.id },
    method: "oidc",
    configEncrypted: "sealed-in-api",
  });
  return { store, connection, snapshot: { ...connection, config } };
}

function credentialKey(agentConnectionId: string, scopeSubject: string) {
  return {
    agentConnectionId,
    securityRevision: 1,
    authMethod: "oidc",
    credentialScope: "principal" as const,
    scopeSubject,
    credentialKey: "",
  };
}
