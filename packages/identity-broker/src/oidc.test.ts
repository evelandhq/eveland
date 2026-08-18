import { describe, expect, test } from "vitest";
import { disableSeededOpenIdentityProvider } from "@evelandhq/db/test";
import { createTestStore } from "@evelandhq/db/vitest";

import {
  IdentityBrokerError,
  createIdentityBroker,
  openOidcCredentialValue,
  openIdentityProviderSecret,
  principalClaims,
  sealIdentityProviderSecret,
  type IdentityOidcProtocol,
  type IdentityOidcTokens,
} from "./index.js";

const appSecretKey = "identity-test-secret-key-0000001";
const redirectUri = "https://api.example.com/identity/oidc/callback";

const jinshujuClaims = {
  iss: "https://account.jinshuju.net",
  sub: "user_9527",
  aud: "eveland-client",
  exp: 1_861_920_600,
  iat: 1_861_920_000,
  nonce: "nonce-value",
  name: "测试用户",
  email: "user@example.com",
  picture: "https://cdn.example.com/avatar.png",
  account_id: "acct_42",
  account_role: "admin",
};

type ProtocolOverrides = Partial<IdentityOidcProtocol> & {
  claims?: Record<string, unknown>;
  userinfo?: Record<string, unknown>;
};

function fakeProtocol(overrides: ProtocolOverrides = {}) {
  const calls: {
    authorization: unknown[];
    exchange: unknown[];
    userinfo: unknown[];
    secrets: (string | undefined)[];
  } = { authorization: [], exchange: [], userinfo: [], secrets: [] };
  const tokens: IdentityOidcTokens = {
    claims: overrides.claims ?? jinshujuClaims,
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    scope: "openid profile email",
    accessTokenExpiresAt: new Date("2029-01-01T01:00:00.000Z"),
  };
  const protocol: IdentityOidcProtocol = {
    async buildAuthorizationUrl(config, clientSecret, transaction) {
      calls.authorization.push({ config, transaction });
      calls.secrets.push(clientSecret);
      const url = new URL("https://account.jinshuju.net/oauth/authorize");
      url.searchParams.set("state", transaction.state);
      return url;
    },
    async exchangeAuthorizationCode(config, clientSecret, transaction, callbackUrl) {
      calls.exchange.push({ config, transaction, callbackUrl: callbackUrl.toString() });
      calls.secrets.push(clientSecret);
      return tokens;
    },
    async fetchUserinfoClaims(_config, _clientSecret, accessToken, expectedSubject) {
      calls.userinfo.push({ accessToken, expectedSubject });
      return overrides.userinfo ?? { sub: expectedSubject };
    },
    async discoverMetadata() {
      return { issuer: "https://account.jinshuju.net" };
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => !["claims", "userinfo"].includes(key)),
    ),
  };
  return { protocol, calls };
}

async function oidcConnection(
  store: ReturnType<typeof createTestStore>,
  input: Partial<Parameters<typeof store.createIdentityProviderConnection>[0]> = {},
) {
  await disableSeededOpenIdentityProvider(store);
  return store.createIdentityProviderConnection({
    type: "oidc",
    displayName: "金数据",
    issuer: "https://account.jinshuju.net",
    clientId: "eveland-client",
    clientSecretEncrypted: sealIdentityProviderSecret("s3cret-value", appSecretKey),
    scopes: ["openid", "profile", "email"],
    tokenEndpointAuthMethod: "client_secret_basic",
    externalRealmResolution: "id_token_claim",
    externalRealmClaim: "account_id",
    enabled: true,
    ...input,
  });
}

function makeBroker(store: ReturnType<typeof createTestStore>, protocol?: IdentityOidcProtocol) {
  return createIdentityBroker({
    store,
    issuer: "https://identity.example.com",
    appSecretKey,
    now: () => new Date("2029-01-01T00:00:00.000Z"),
    ...(protocol ? { oidcProtocol: protocol } : {}),
  });
}

describe("OIDC login", () => {
  test("begins a login with per-transaction state, nonce, and PKCE verifier", async () => {
    const store = createTestStore();
    const connection = await oidcConnection(store);
    const { protocol, calls } = fakeProtocol();
    const broker = makeBroker(store, protocol);

    const first = await broker.beginOidcLogin({ providerConnectionId: connection.id, redirectUri });
    const second = await broker.beginOidcLogin({
      providerConnectionId: connection.id,
      redirectUri,
    });

    expect(first.state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(first.nonce).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(first.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(second.state).not.toBe(first.state);
    expect(second.nonce).not.toBe(first.nonce);
    expect(first.providerSecurityRevision).toBe(connection.securityRevision);
    expect(new URL(first.authorizationUrl).searchParams.get("state")).toBe(first.state);
    // The sealed client secret reaches the protocol opened, and only there.
    expect(calls.secrets).toEqual(["s3cret-value", "s3cret-value"]);
  });

  test("completes an id_token_claim login into a registered Realm with filtered claims", async () => {
    const store = createTestStore();
    const connection = await oidcConnection(store);
    const realm = await store.createIdentityRealm({
      providerConnectionId: connection.id,
      externalRealmId: "acct_42",
      externalRealmKind: "account",
      displayName: "金数据团队",
      enabled: true,
    });
    const { protocol, calls } = fakeProtocol();
    const broker = makeBroker(store, protocol);

    const begun = await broker.beginOidcLogin({ providerConnectionId: connection.id, redirectUri });
    const finalized = await broker.completeOidcLogin({
      providerConnectionId: connection.id,
      providerSecurityRevision: begun.providerSecurityRevision,
      transaction: {
        redirectUri,
        state: begun.state,
        nonce: begun.nonce,
        codeVerifier: begun.codeVerifier,
      },
      callbackUrl: new URL(`${redirectUri}?code=abc&state=${begun.state}`),
    });

    expect(finalized.realm.id).toBe(realm.id);
    expect(finalized.principal).toMatchObject({
      externalSubject: "user_9527",
      displayName: "测试用户",
      email: "user@example.com",
    });
    expect(finalized.principal.claims).toMatchObject({
      account_id: "acct_42",
      account_role: "admin",
      picture: "https://cdn.example.com/avatar.png",
    });
    expect(finalized.principal.claims).not.toHaveProperty("nonce");
    expect(finalized.principal.claims).not.toHaveProperty("aud");
    expect(finalized.session.activeIdentityRealmId).toBe(realm.id);
    // id_token_claim resolution never calls UserInfo.
    expect(calls.userinfo).toHaveLength(0);

    const credential = await store.getIdentityOidcCredential(finalized.principal.id, connection.id);
    expect(credential).not.toBeNull();
    expect(openOidcCredentialValue(credential!.accessTokenEncrypted, appSecretKey)).toBe(
      "access-token-1",
    );
    expect(openOidcCredentialValue(credential!.refreshTokenEncrypted!, appSecretKey)).toBe(
      "refresh-token-1",
    );
    expect(credential!.scope).toBe("openid profile email");
  });

  test("rejects a login whose Realm claim is not registered", async () => {
    const store = createTestStore();
    const connection = await oidcConnection(store);
    const { protocol } = fakeProtocol();
    const broker = makeBroker(store, protocol);
    const begun = await broker.beginOidcLogin({ providerConnectionId: connection.id, redirectUri });

    await expect(
      broker.completeOidcLogin({
        providerConnectionId: connection.id,
        providerSecurityRevision: begun.providerSecurityRevision,
        transaction: {
          redirectUri,
          state: begun.state,
          nonce: begun.nonce,
          codeVerifier: begun.codeVerifier,
        },
        callbackUrl: new URL(`${redirectUri}?code=abc&state=${begun.state}`),
      }),
    ).rejects.toMatchObject({ code: "identity_realm_not_allowed", status: 403 });
  });

  test("resolves connection-wide Realm resolution to the single enabled Realm", async () => {
    const store = createTestStore();
    const connection = await oidcConnection(store, {
      externalRealmResolution: "connection",
      externalRealmClaim: null,
    });
    const realm = await store.createIdentityRealm({
      providerConnectionId: connection.id,
      externalRealmId: "everyone",
      externalRealmKind: "tenant",
      displayName: "Everyone",
      enabled: true,
    });
    await store.createIdentityRealm({
      providerConnectionId: connection.id,
      externalRealmId: "disabled-realm",
      externalRealmKind: "tenant",
      displayName: "Disabled",
      enabled: false,
    });
    const { protocol } = fakeProtocol();
    const broker = makeBroker(store, protocol);
    const begun = await broker.beginOidcLogin({ providerConnectionId: connection.id, redirectUri });

    const finalized = await broker.completeOidcLogin({
      providerConnectionId: connection.id,
      providerSecurityRevision: begun.providerSecurityRevision,
      transaction: {
        redirectUri,
        state: begun.state,
        nonce: begun.nonce,
        codeVerifier: begun.codeVerifier,
      },
      callbackUrl: new URL(`${redirectUri}?code=abc&state=${begun.state}`),
    });

    expect(finalized.realm.id).toBe(realm.id);
  });

  test("refuses connection-wide resolution when the Realm allowlist is ambiguous", async () => {
    const store = createTestStore();
    const connection = await oidcConnection(store, {
      externalRealmResolution: "connection",
      externalRealmClaim: null,
    });
    for (const externalRealmId of ["one", "two"]) {
      await store.createIdentityRealm({
        providerConnectionId: connection.id,
        externalRealmId,
        externalRealmKind: "tenant",
        displayName: externalRealmId,
        enabled: true,
      });
    }
    const { protocol } = fakeProtocol();
    const broker = makeBroker(store, protocol);
    const begun = await broker.beginOidcLogin({ providerConnectionId: connection.id, redirectUri });

    await expect(
      broker.completeOidcLogin({
        providerConnectionId: connection.id,
        providerSecurityRevision: begun.providerSecurityRevision,
        transaction: {
          redirectUri,
          state: begun.state,
          nonce: begun.nonce,
          codeVerifier: begun.codeVerifier,
        },
        callbackUrl: new URL(`${redirectUri}?code=abc&state=${begun.state}`),
      }),
    ).rejects.toMatchObject({ code: "identity_realm_not_allowed", status: 403 });
  });

  test("resolves a userinfo_claim Realm from the UserInfo response", async () => {
    const store = createTestStore();
    const connection = await oidcConnection(store, {
      externalRealmResolution: "userinfo_claim",
      externalRealmClaim: "org_id",
    });
    const realm = await store.createIdentityRealm({
      providerConnectionId: connection.id,
      externalRealmId: "org_abc",
      externalRealmKind: "organization",
      displayName: "Org ABC",
      enabled: true,
    });
    const { protocol, calls } = fakeProtocol({
      userinfo: { sub: "user_9527", org_id: "org_abc" },
    });
    const broker = makeBroker(store, protocol);
    const begun = await broker.beginOidcLogin({ providerConnectionId: connection.id, redirectUri });

    const finalized = await broker.completeOidcLogin({
      providerConnectionId: connection.id,
      providerSecurityRevision: begun.providerSecurityRevision,
      transaction: {
        redirectUri,
        state: begun.state,
        nonce: begun.nonce,
        codeVerifier: begun.codeVerifier,
      },
      callbackUrl: new URL(`${redirectUri}?code=abc&state=${begun.state}`),
    });

    expect(finalized.realm.id).toBe(realm.id);
    expect(calls.userinfo).toEqual([
      { accessToken: "access-token-1", expectedSubject: "user_9527" },
    ]);
  });

  test("accepts a numeric Realm claim the way 金数据-style account ids arrive", async () => {
    const store = createTestStore();
    const connection = await oidcConnection(store);
    const realm = await store.createIdentityRealm({
      providerConnectionId: connection.id,
      externalRealmId: "31337",
      externalRealmKind: "account",
      displayName: "Numeric account",
      enabled: true,
    });
    const { protocol } = fakeProtocol({ claims: { ...jinshujuClaims, account_id: 31337 } });
    const broker = makeBroker(store, protocol);
    const begun = await broker.beginOidcLogin({ providerConnectionId: connection.id, redirectUri });

    const finalized = await broker.completeOidcLogin({
      providerConnectionId: connection.id,
      providerSecurityRevision: begun.providerSecurityRevision,
      transaction: {
        redirectUri,
        state: begun.state,
        nonce: begun.nonce,
        codeVerifier: begun.codeVerifier,
      },
      callbackUrl: new URL(`${redirectUri}?code=abc&state=${begun.state}`),
    });

    expect(finalized.realm.id).toBe(realm.id);
  });

  test("fails the login when the provider's security revision moved mid-flight", async () => {
    const store = createTestStore();
    const connection = await oidcConnection(store);
    const { protocol } = fakeProtocol();
    const broker = makeBroker(store, protocol);
    const begun = await broker.beginOidcLogin({ providerConnectionId: connection.id, redirectUri });
    await store.updateIdentityProviderConnection({
      id: connection.id,
      expectedSecurityRevision: connection.securityRevision,
      displayName: connection.displayName,
      clientSecretEncrypted: sealIdentityProviderSecret("rotated", appSecretKey),
      enabled: true,
      securityChanged: true,
    });

    await expect(
      broker.completeOidcLogin({
        providerConnectionId: connection.id,
        providerSecurityRevision: begun.providerSecurityRevision,
        transaction: {
          redirectUri,
          state: begun.state,
          nonce: begun.nonce,
          codeVerifier: begun.codeVerifier,
        },
        callbackUrl: new URL(`${redirectUri}?code=abc&state=${begun.state}`),
      }),
    ).rejects.toMatchObject({ code: "identity_provider_invalid", status: 401 });
  });

  test("maps every exchange failure onto one dead-login error", async () => {
    const store = createTestStore();
    const connection = await oidcConnection(store);
    const { protocol } = fakeProtocol({
      exchangeAuthorizationCode: async () => {
        throw new Error("nonce mismatch");
      },
    });
    const broker = makeBroker(store, protocol);
    const begun = await broker.beginOidcLogin({ providerConnectionId: connection.id, redirectUri });

    await expect(
      broker.completeOidcLogin({
        providerConnectionId: connection.id,
        providerSecurityRevision: begun.providerSecurityRevision,
        transaction: {
          redirectUri,
          state: begun.state,
          nonce: begun.nonce,
          codeVerifier: begun.codeVerifier,
        },
        callbackUrl: new URL(`${redirectUri}?code=abc&state=${begun.state}`),
      }),
    ).rejects.toMatchObject({ code: "identity_oidc_exchange_failed", status: 401 });
  });

  test("rejects an ID token without a subject", async () => {
    const store = createTestStore();
    const connection = await oidcConnection(store);
    const { sub: _sub, ...withoutSubject } = jinshujuClaims;
    const { protocol } = fakeProtocol({ claims: withoutSubject });
    const broker = makeBroker(store, protocol);
    const begun = await broker.beginOidcLogin({ providerConnectionId: connection.id, redirectUri });

    await expect(
      broker.completeOidcLogin({
        providerConnectionId: connection.id,
        providerSecurityRevision: begun.providerSecurityRevision,
        transaction: {
          redirectUri,
          state: begun.state,
          nonce: begun.nonce,
          codeVerifier: begun.codeVerifier,
        },
        callbackUrl: new URL(`${redirectUri}?code=abc&state=${begun.state}`),
      }),
    ).rejects.toMatchObject({ code: "identity_oidc_claims_invalid", status: 401 });
  });

  test("fails closed when no OIDC protocol is configured", async () => {
    const store = createTestStore();
    const connection = await oidcConnection(store);
    const broker = makeBroker(store);

    await expect(
      broker.beginOidcLogin({ providerConnectionId: connection.id, redirectUri }),
    ).rejects.toMatchObject({ code: "identity_provider_unavailable", status: 503 });
    await expect(
      broker.beginOidcLogin({ providerConnectionId: connection.id, redirectUri }),
    ).rejects.toBeInstanceOf(IdentityBrokerError);
  });

  test("refuses to begin against a disabled or non-OIDC provider", async () => {
    const store = createTestStore();
    const disabled = await oidcConnection(store, { enabled: false });
    const { protocol } = fakeProtocol();
    const broker = makeBroker(store, protocol);

    await expect(
      broker.beginOidcLogin({ providerConnectionId: disabled.id, redirectUri }),
    ).rejects.toMatchObject({ code: "identity_provider_invalid", status: 401 });
  });
});

describe("sealed identity secrets", () => {
  test("round-trips the provider secret and keeps contexts separate", () => {
    const sealed = sealIdentityProviderSecret("s3cret-value", appSecretKey);
    expect(sealed).not.toContain("s3cret-value");
    expect(openIdentityProviderSecret(sealed, appSecretKey)).toBe("s3cret-value");
    // A credential sealed under the other context must not open here.
    expect(() => openOidcCredentialValue(sealed, appSecretKey)).toThrow();
  });
});

describe("principal claims filter", () => {
  test("keeps person attributes and drops protocol plumbing and oversized values", () => {
    expect(
      principalClaims({
        ...jinshujuClaims,
        roles: ["admin", "editor"],
        mixed: ["ok", 42],
        huge: "x".repeat(3_000),
        object: { nested: true },
        count: 7,
      }),
    ).toEqual({
      sub: "user_9527",
      name: "测试用户",
      email: "user@example.com",
      picture: "https://cdn.example.com/avatar.png",
      account_id: "acct_42",
      account_role: "admin",
      roles: ["admin", "editor"],
    });
  });
});
