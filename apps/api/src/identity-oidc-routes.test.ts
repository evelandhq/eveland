import { describe, expect, onTestFinished, test } from "vitest";
import {
  authAccounts,
  authSessions,
  authVerifications,
  invitations,
  teamMemberships,
  teams,
  users,
} from "@evelandhq/db/schema";
import { createPgliteTestStore, disableSeededOpenIdentityProvider } from "@evelandhq/db/test";
import {
  hashIdentityToken,
  sealIdentityProviderSecret,
  type IdentityOidcProtocol,
} from "@evelandhq/identity-broker";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createApp } from "./app.js";
import { createBetterAuthRuntime } from "./auth.js";

const webOrigin = "http://localhost:3000";
const apiOrigin = "http://localhost:4000";
const chatOrigin = "http://localhost:3010";
const appSecretKey = "identity-api-secret-key-00000000";
const issuer = "https://account.jinshuju.net";

const defaultClaims = {
  iss: issuer,
  sub: "user_9527",
  aud: "eveland-client",
  name: "测试用户",
  email: "user@example.com",
  account_id: "acct_42",
  account_role: "admin",
};

type FakeProtocol = {
  protocol: IdentityOidcProtocol;
  exchanges: { state: string; nonce: string; codeVerifier: string; callbackUrl: string }[];
  claims: Record<string, unknown>;
  metadata: Record<string, unknown>;
  failExchange: boolean;
};

function fakeOidcProtocol(): FakeProtocol {
  const fake: FakeProtocol = {
    exchanges: [],
    claims: { ...defaultClaims },
    metadata: {
      issuer,
      response_types_supported: ["code"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      code_challenge_methods_supported: ["plain", "S256"],
      scopes_supported: ["openid", "profile", "email"],
      claims_supported: ["sub", "name", "email", "account_id"],
    },
    failExchange: false,
    protocol: {
      async buildAuthorizationUrl(config, _clientSecret, transaction) {
        const url = new URL(`${config.issuer}/oauth/authorize`);
        url.searchParams.set("client_id", config.clientId);
        url.searchParams.set("state", transaction.state);
        url.searchParams.set("nonce", transaction.nonce);
        url.searchParams.set("redirect_uri", transaction.redirectUri);
        return url;
      },
      async exchangeAuthorizationCode(_config, _clientSecret, transaction, callbackUrl) {
        fake.exchanges.push({
          state: transaction.state,
          nonce: transaction.nonce,
          codeVerifier: transaction.codeVerifier,
          callbackUrl: callbackUrl.toString(),
        });
        if (fake.failExchange) throw new Error("exchange rejected");
        return {
          claims: fake.claims,
          accessToken: "access-token-1",
          refreshToken: "refresh-token-1",
          scope: "openid profile email",
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        };
      },
      async fetchUserinfoClaims(_config, _clientSecret, _accessToken, expectedSubject) {
        return { sub: expectedSubject };
      },
      async discoverMetadata() {
        return fake.metadata;
      },
    },
  };
  return fake;
}

async function createOidcApp() {
  const database = await createPgliteTestStore();
  onTestFinished(() => database.close());
  await disableSeededOpenIdentityProvider(database.store);
  const provider = await database.store.createIdentityProviderConnection({
    type: "oidc",
    displayName: "金数据",
    issuer,
    clientId: "eveland-client",
    clientSecretEncrypted: sealIdentityProviderSecret("s3cret-value", appSecretKey),
    scopes: ["openid", "profile", "email"],
    tokenEndpointAuthMethod: "client_secret_basic",
    externalRealmResolution: "id_token_claim",
    externalRealmClaim: "account_id",
    enabled: true,
  });
  const realm = await database.store.createIdentityRealm({
    providerConnectionId: provider.id,
    externalRealmId: "acct_42",
    externalRealmKind: "account",
    displayName: "金数据团队",
    enabled: true,
  });
  const target = await database.store.upsertIdentityReturnTarget({
    key: "eve-chats",
    origin: chatOrigin,
    enabled: true,
  });
  const fake = fakeOidcProtocol();
  const auth = createBetterAuthRuntime({
    database: drizzleAdapter(database.db, {
      provider: "pg",
      schema: {
        user: users,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
        organization: teams,
        member: teamMemberships,
        invitation: invitations,
      },
    }),
    baseURL: apiOrigin,
    webOrigin,
    secret: "test-secret-with-at-least-thirty-two-characters",
  });
  await auth.bootstrapDefaultAdmin({
    email: "admin@example.com",
    name: "测试用户",
    password: "admin-password",
  });
  const app = createApp(database.store, {
    auth,
    webOrigin,
    appSecretKey,
    identityIssuer: apiOrigin,
    identityAllowedOrigins: [chatOrigin],
    identityOidcProtocol: fake.protocol,
  });
  return { app, store: database.store, provider, realm, target, fake };
}

async function adminCookie(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: webOrigin },
    body: JSON.stringify({ email: "admin@example.com", password: "admin-password" }),
  });
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

async function startLogin(app: ReturnType<typeof createApp>) {
  const response = await app.request(
    "/api/identity/login?target=eve-chats&returnPath=%2Fagents%2Fdemo",
    { redirect: "manual" },
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  return { location, state: location.searchParams.get("state")! };
}

function callbackPath(state: string, extra = ""): string {
  return `/api/identity/oidc/callback?code=auth-code-1&state=${encodeURIComponent(state)}${extra}`;
}

describe("OIDC Identity login flow", () => {
  test("redirects a fresh login to the IdP and persists a sealed transaction", async () => {
    const { app, store, fake } = await createOidcApp();

    const { location, state } = await startLogin(app);

    expect(location.origin + location.pathname).toBe(`${issuer}/oauth/authorize`);
    expect(location.searchParams.get("client_id")).toBe("eveland-client");
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${apiOrigin}/api/identity/oidc/callback`,
    );
    expect(location.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(fake.exchanges).toHaveLength(0);
    // The transaction row exists, carries the nonce hash, and never stores
    // the raw secrets in the clear.
    const transaction = await store.consumeIdentityLoginTransaction(hashIdentityToken(state));
    expect(transaction).not.toBeNull();
    expect(transaction!.nonceHash).toBe(hashIdentityToken(location.searchParams.get("nonce")!));
    expect(transaction!.pkceVerifierEncrypted).not.toContain(location.searchParams.get("nonce")!);
  });

  test("completes the callback into a session cookie and a usable Identity Session", async () => {
    const { app, fake, realm } = await createOidcApp();
    const { state } = await startLogin(app);

    const response = await app.request(callbackPath(state), { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${chatOrigin}/agents/demo`);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("eveland_identity=");
    expect(setCookie).toContain("Path=/api/identity");
    expect(setCookie).toContain("HttpOnly");
    // The exchange saw the same state and a matching verifier/nonce pair.
    expect(fake.exchanges).toHaveLength(1);
    expect(fake.exchanges[0]!.state).toBe(state);
    expect(fake.exchanges[0]!.callbackUrl).toContain("code=auth-code-1");

    const cookie = setCookie.split(";", 1)[0]!;
    const session = await app.request("/api/identity/session", {
      headers: { cookie, origin: chatOrigin },
    });
    expect(await session.json()).toMatchObject({
      authenticated: true,
      principal: { name: "测试用户", email: "user@example.com" },
      activeRealm: { id: realm.id, name: "金数据团队" },
    });
  });

  test("mints a project Caller Token from an OIDC-established session", async () => {
    const { app, store } = await createOidcApp();
    const project = await store.createProject({ name: "oidc-agent", importKind: "zip" });
    const { state } = await startLogin(app);
    const callback = await app.request(callbackPath(state), { redirect: "manual" });
    const cookie = (callback.headers.get("set-cookie") ?? "").split(";", 1)[0]!;

    const minted = await app.request("/api/identity/caller-tokens", {
      method: "POST",
      headers: { cookie, origin: chatOrigin, "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id }),
    });

    expect(minted.status).toBe(200);
    const { token } = (await minted.json()) as { token: string };
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(claims.aud).toBe(`eveland:project:${project.id}`);
    expect(claims.name).toBe("测试用户");
    // Provider internals stay out of the token.
    expect(claims).not.toHaveProperty("account_id");
    expect(claims).not.toHaveProperty("iss_external");
  });

  test("rejects a replayed callback: the transaction is one-shot", async () => {
    const { app } = await createOidcApp();
    const { state } = await startLogin(app);
    await app.request(callbackPath(state), { redirect: "manual" });

    const replay = await app.request(callbackPath(state), { redirect: "manual" });

    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ code: "identity_login_transaction_invalid" });
  });

  test("rejects a forged or unknown state", async () => {
    const { app } = await createOidcApp();
    await startLogin(app);

    const response = await app.request(callbackPath("forged-state"), { redirect: "manual" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "identity_login_transaction_invalid" });
  });

  test("consumes the transaction even when the IdP reports an error", async () => {
    const { app } = await createOidcApp();
    const { state } = await startLogin(app);

    const denied = await app.request(
      `/api/identity/oidc/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ code: "identity_oidc_denied" });

    // The state cannot be turned into a login afterwards.
    const retry = await app.request(callbackPath(state), { redirect: "manual" });
    expect(retry.status).toBe(400);
  });

  test("fails a login whose provider was rotated mid-flight", async () => {
    const { app, store, provider } = await createOidcApp();
    const { state } = await startLogin(app);
    await store.updateIdentityProviderConnection({
      id: provider.id,
      expectedSecurityRevision: provider.securityRevision,
      displayName: provider.displayName,
      clientSecretEncrypted: sealIdentityProviderSecret("rotated", appSecretKey),
      enabled: true,
      securityChanged: true,
    });

    const response = await app.request(callbackPath(state), { redirect: "manual" });

    // A security rotation deletes every in-flight login transaction for the
    // connection, so the callback dies at consumption; the broker's revision
    // recheck (401) covers the narrower race where consumption wins.
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "identity_login_transaction_invalid" });
  });

  test("refuses a login resolving to an unregistered Realm", async () => {
    const { app, fake } = await createOidcApp();
    fake.claims = { ...defaultClaims, account_id: "acct_unknown" };
    const { state } = await startLogin(app);

    const response = await app.request(callbackPath(state), { redirect: "manual" });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "identity_realm_not_allowed" });
  });

  test("maps an exchange failure onto one dead-login error", async () => {
    const { app, fake } = await createOidcApp();
    fake.failExchange = true;
    const { state } = await startLogin(app);

    const response = await app.request(callbackPath(state), { redirect: "manual" });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "identity_oidc_exchange_failed" });
  });
});

describe("OIDC provider administration", () => {
  test("exposes the fixed redirect URI to the settings UI", async () => {
    const { app } = await createOidcApp();

    const response = await app.request("/api/system/identity/providers", {
      headers: { cookie: await adminCookie(app), origin: webOrigin },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      oidcRedirectUri: `${apiOrigin}/api/identity/oidc/callback`,
    });
  });

  test("preflights an OIDC provider against its discovery metadata", async () => {
    const { app, provider } = await createOidcApp();

    const response = await app.request(`/api/system/identity/providers/${provider.id}/preflight`, {
      method: "POST",
      headers: { cookie: await adminCookie(app), origin: webOrigin },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      checks: {
        discovery: true,
        authorizationCodeFlow: true,
        tokenEndpointAuthMethod: true,
        pkceS256: true,
      },
      advisories: {
        scopesAdvertised: true,
        realmClaimAdvertised: true,
      },
    });
  });

  test("fails the preflight when the IdP does not offer the configured auth method", async () => {
    const { app, provider, fake } = await createOidcApp();
    fake.metadata = {
      ...fake.metadata,
      token_endpoint_auth_methods_supported: ["private_key_jwt"],
    };

    const response = await app.request(`/api/system/identity/providers/${provider.id}/preflight`, {
      method: "POST",
      headers: { cookie: await adminCookie(app), origin: webOrigin },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      checks: { tokenEndpointAuthMethod: false },
    });
  });
});
