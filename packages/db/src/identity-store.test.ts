import { describe, expect, onTestFinished, test } from "vitest";

import { sql } from "drizzle-orm";

import { createPgliteTestStore, disableSeededOpenIdentityProvider } from "./test-store.js";
import { createTestStore } from "./vitest-store.js";

describe("Identity provider seed and exclusivity", () => {
  test("starts a new instance on open access with its shared Realm", async () => {
    const store = createTestStore();

    const providers = await store.listIdentityProviderConnections();
    expect(providers.filter((provider) => provider.enabled)).toEqual([
      expect.objectContaining({
        type: "open",
        enabled: true,
        internalRealmKey: null,
        issuer: null,
        clientId: null,
        externalRealmResolution: "open_shared",
      }),
    ]);

    const realms = await store.listIdentityRealms(providers[0]!.id);
    expect(realms).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^irlm_/),
        externalRealmKind: "internal",
        enabled: true,
      }),
    ]);
  });

  test("allows only one enabled Provider across every type", async () => {
    const store = createTestStore();
    await disableSeededOpenIdentityProvider(store);
    await store.createIdentityProviderConnection({
      type: "internal",
      displayName: "Eveland Internal",
      internalRealmKey: "members",
      enabled: true,
    });

    // An enabled OIDC Provider alongside an enabled internal one used to be
    // reachable: the old index only constrained internal rows, which left
    // `/identity/login` answering 503 with no way to tell why.
    await expect(
      store.createIdentityProviderConnection({
        type: "oidc",
        displayName: "Company OIDC",
        issuer: "https://id.example",
        clientId: "chat",
        scopes: ["openid"],
        tokenEndpointAuthMethod: "client_secret_basic",
        externalRealmResolution: "connection",
        enabled: true,
      }),
    ).rejects.toThrow();
  });

  test("enforces exclusivity through a constant index expression, not a pinned column", async () => {
    const database = await createPgliteTestStore();
    onTestFinished(() => database.close());

    const [index] = (
      await database.db.execute(
        sql`select indexdef from pg_indexes where indexname = 'identity_provider_connections_one_enabled_idx'`,
      )
    ).rows as Array<{ indexdef: string }>;

    // Indexing a column that the predicate happens to pin to a single value
    // reads as global uniqueness only by accident; widening the predicate later
    // would silently degrade it to one-enabled-per-type.
    expect(index?.indexdef).toContain("(true)");
    expect(index?.indexdef).toMatch(/WHERE .*enabled/i);
    expect(index?.indexdef).not.toContain("type");
  });
});

describe("Identity store", () => {
  test("stores type-specific provider configuration and security revisions", async () => {
    const store = createTestStore();
    await disableSeededOpenIdentityProvider(store);
    const connection = await store.createIdentityProviderConnection({
      type: "internal",
      displayName: "Eveland Internal",
      internalRealmKey: "eveland-members",
      enabled: false,
    });

    expect(connection).toMatchObject({
      id: expect.stringMatching(/^idpc_/),
      type: "internal",
      displayName: "Eveland Internal",
      internalRealmKey: "eveland-members",
      issuer: null,
      clientId: null,
      clientSecretEncrypted: null,
      enabled: false,
      securityRevision: 1,
    });

    const enabled = await store.updateIdentityProviderConnection({
      id: connection.id,
      expectedSecurityRevision: 1,
      displayName: "Eveland Internal",
      enabled: true,
      securityChanged: false,
    });
    const changed = await store.updateIdentityProviderConnection({
      id: connection.id,
      expectedSecurityRevision: 1,
      displayName: "Internal Members",
      enabled: true,
      securityChanged: true,
    });

    expect(enabled).toMatchObject({ enabled: true, securityRevision: 1 });
    expect(changed).toMatchObject({
      displayName: "Internal Members",
      securityRevision: 2,
    });
    await expect(
      store.updateIdentityProviderConnection({
        id: connection.id,
        expectedSecurityRevision: 2,
        displayName: "Invalid Realm Rewrite",
        internalRealmKey: "other-realm",
        enabled: true,
        securityChanged: true,
      }),
    ).rejects.toThrow(/realm key.*immutable/i);

    const secondInternal = await store.createIdentityProviderConnection({
      type: "internal",
      displayName: "Second Internal",
      internalRealmKey: "second-members",
      enabled: false,
    });
    await expect(
      store.updateIdentityProviderConnection({
        id: secondInternal.id,
        expectedSecurityRevision: 1,
        displayName: secondInternal.displayName,
        enabled: true,
        securityChanged: false,
      }),
    ).rejects.toThrow();
  });

  test("uniquely maps provider Realms and Realm subjects to Principals", async () => {
    const store = createTestStore();
    await disableSeededOpenIdentityProvider(store);
    const connection = await store.createIdentityProviderConnection({
      type: "internal",
      displayName: "Eveland Internal",
      internalRealmKey: "members",
      enabled: true,
    });
    const realm = await store.createIdentityRealm({
      providerConnectionId: connection.id,
      externalRealmId: "members",
      externalRealmKind: "internal",
      displayName: "Eveland Members",
      enabled: true,
    });
    const sameRealm = await store.createIdentityRealm({
      providerConnectionId: connection.id,
      externalRealmId: "members",
      externalRealmKind: "internal",
      displayName: "Duplicate",
      enabled: true,
    });
    const first = await store.upsertIdentityPrincipal({
      identityRealmId: realm.id,
      externalSubject: "user_123",
      displayName: "Test User",
      email: "test@example.com",
      claims: { locale: "zh-CN" },
    });
    const updated = await store.upsertIdentityPrincipal({
      identityRealmId: realm.id,
      externalSubject: "user_123",
      displayName: "Updated User",
      email: "updated@example.com",
      claims: {},
    });

    expect(realm.id).toMatch(/^irlm_/);
    expect(sameRealm.id).toBe(realm.id);
    expect(updated).toMatchObject({
      id: first.id,
      identityRealmId: realm.id,
      externalSubject: "user_123",
      displayName: "Updated User",
    });
  });

  test("looks up hashed Identity sessions and enforces expiry and revocation", async () => {
    const store = createTestStore();
    const { connection, realm, principal } = await identityFixture(store);
    const session = await store.createIdentitySession({
      tokenHash: "sha256:session-one",
      identityPrincipalId: principal.id,
      activeIdentityRealmId: realm.id,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });

    await expect(
      store.getActiveIdentitySession("sha256:session-one", new Date("2029-01-01T00:00:00.000Z")),
    ).resolves.toMatchObject({
      id: session.id,
      identityPrincipalId: principal.id,
      activeIdentityRealmId: realm.id,
    });
    await expect(
      store.getActiveIdentitySession("sha256:session-one", new Date("2031-01-01T00:00:00.000Z")),
    ).resolves.toBeNull();
    await store.revokeIdentitySession(session.id, new Date("2029-02-01T00:00:00.000Z"));
    await expect(
      store.getActiveIdentitySession("sha256:session-one", new Date("2029-03-01T00:00:00.000Z")),
    ).resolves.toBeNull();
    await expect(store.getIdentityProviderConnection(connection.id)).resolves.not.toBeNull();
  });

  test("atomically consumes provider-neutral login transactions and cleans expiry", async () => {
    const store = createTestStore();
    await disableSeededOpenIdentityProvider(store);
    const connection = await store.createIdentityProviderConnection({
      type: "internal",
      displayName: "Internal",
      internalRealmKey: "members",
      enabled: true,
    });
    const target = await store.upsertIdentityReturnTarget({
      key: "eve-chats",
      origin: "https://chat.example.com",
      enabled: true,
    });
    await store.createIdentityLoginTransaction({
      stateHash: "sha256:state",
      providerConnectionId: connection.id,
      providerSecurityRevision: 1,
      returnTargetId: target.id,
      returnPath: "/agents/agent_123",
      nonceHash: null,
      pkceVerifierEncrypted: null,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });

    await expect(
      store.consumeIdentityLoginTransaction("sha256:state", new Date("2029-01-01T00:00:00.000Z")),
    ).resolves.toMatchObject({
      providerConnectionId: connection.id,
      returnTargetId: target.id,
      returnPath: "/agents/agent_123",
    });
    await expect(
      store.consumeIdentityLoginTransaction("sha256:state", new Date("2029-01-01T00:00:00.000Z")),
    ).resolves.toBeNull();

    await store.createIdentityLoginTransaction({
      stateHash: "sha256:expired",
      providerConnectionId: connection.id,
      providerSecurityRevision: 1,
      returnTargetId: target.id,
      returnPath: "/",
      nonceHash: null,
      pkceVerifierEncrypted: null,
      expiresAt: new Date("2028-01-01T00:00:00.000Z"),
    });
    await expect(
      store.deleteExpiredIdentityLoginTransactions(new Date("2029-01-01T00:00:00.000Z"), 10),
    ).resolves.toBe(1);
  });

  test("fences OIDC credential refresh and rotates signing keys", async () => {
    const store = createTestStore();
    await disableSeededOpenIdentityProvider(store);
    const connection = await store.createIdentityProviderConnection({
      type: "oidc",
      displayName: "OIDC",
      issuer: "https://id.example",
      clientId: "chat",
      clientSecretEncrypted: "encrypted-secret",
      scopes: ["openid"],
      authorizationParameters: {},
      tokenEndpointAuthMethod: "client_secret_basic",
      externalRealmResolution: "id_token_claim",
      externalRealmClaim: "account_id",
      enabled: true,
    });
    const realm = await store.createIdentityRealm({
      providerConnectionId: connection.id,
      externalRealmId: "account-1",
      externalRealmKind: "account",
      displayName: "Account 1",
      enabled: true,
    });
    const principal = await store.upsertIdentityPrincipal({
      identityRealmId: realm.id,
      externalSubject: "user-1",
      displayName: "User",
      email: null,
      claims: {},
    });
    const credential = await store.putIdentityOidcCredential({
      identityPrincipalId: principal.id,
      providerConnectionId: connection.id,
      accessTokenEncrypted: "access-v1",
      refreshTokenEncrypted: "refresh-v1",
      scope: "openid",
      accessTokenExpiresAt: new Date("2029-01-01T00:00:00.000Z"),
    });
    const rotated = await store.rotateIdentityOidcCredential({
      identityPrincipalId: principal.id,
      providerConnectionId: connection.id,
      expectedRotationSeq: credential.rotationSeq,
      accessTokenEncrypted: "access-v2",
      refreshTokenEncrypted: "refresh-v2",
      scope: "openid profile",
      accessTokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    const stale = await store.rotateIdentityOidcCredential({
      identityPrincipalId: principal.id,
      providerConnectionId: connection.id,
      expectedRotationSeq: credential.rotationSeq,
      accessTokenEncrypted: "stale",
      refreshTokenEncrypted: null,
      scope: "openid",
      accessTokenExpiresAt: null,
    });

    expect(rotated).toMatchObject({ accessTokenEncrypted: "access-v2", rotationSeq: 1 });
    expect(stale).toBeNull();

    const firstKey = await store.createIdentitySigningKey({
      algorithm: "ES256",
      publicJwk: { kty: "EC", kid: "key-1" },
      privateKeyEncrypted: "private-1",
      status: "active",
      notBefore: new Date("2028-01-01T00:00:00.000Z"),
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    const secondKey = await store.createIdentitySigningKey({
      algorithm: "ES256",
      publicJwk: { kty: "EC", kid: "key-2" },
      privateKeyEncrypted: "private-2",
      status: "active",
      notBefore: new Date("2029-01-01T00:00:00.000Z"),
      expiresAt: new Date("2031-01-01T00:00:00.000Z"),
    });
    const keys = await store.listIdentitySigningKeys();

    expect(keys.find((key) => key.id === firstKey.id)?.status).toBe("retiring");
    expect(keys.find((key) => key.id === secondKey.id)?.status).toBe("active");
  });

  test("revokes provider state after a security-sensitive connection change", async () => {
    const store = createTestStore();
    const { connection, realm, principal } = await identityFixture(store);
    const target = await store.upsertIdentityReturnTarget({
      key: "eve-chats",
      origin: "https://chat.example.com",
      enabled: true,
    });
    const session = await store.createIdentitySession({
      tokenHash: "sha256:old-session",
      identityPrincipalId: principal.id,
      activeIdentityRealmId: realm.id,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    await store.createIdentityLoginTransaction({
      stateHash: "sha256:old-state",
      providerConnectionId: connection.id,
      providerSecurityRevision: 1,
      returnTargetId: target.id,
      returnPath: "/",
      nonceHash: null,
      pkceVerifierEncrypted: null,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });

    await store.updateIdentityProviderConnection({
      id: connection.id,
      expectedSecurityRevision: 1,
      displayName: "Internal renamed",
      enabled: true,
      securityChanged: true,
    });

    await expect(
      store.getActiveIdentitySession("sha256:old-session", new Date("2029-01-01T00:00:00.000Z")),
    ).resolves.toBeNull();
    await expect(
      store.consumeIdentityLoginTransaction(
        "sha256:old-state",
        new Date("2029-01-01T00:00:00.000Z"),
      ),
    ).resolves.toBeNull();
    expect(session.revokedAt).toBeNull();
  });
});

async function identityFixture(store: ReturnType<typeof createTestStore>) {
  await disableSeededOpenIdentityProvider(store);
  const connection = await store.createIdentityProviderConnection({
    type: "internal",
    displayName: "Internal",
    internalRealmKey: "members",
    enabled: true,
  });
  const realm = await store.createIdentityRealm({
    providerConnectionId: connection.id,
    externalRealmId: "members",
    externalRealmKind: "internal",
    displayName: "Members",
    enabled: true,
  });
  const principal = await store.upsertIdentityPrincipal({
    identityRealmId: realm.id,
    externalSubject: "user_123",
    displayName: "Test User",
    email: "test@example.com",
    claims: {},
  });
  return { connection, realm, principal };
}
