import { createPublicKey, verify } from "node:crypto";
import { describe, expect, test } from "vitest";
import { disableSeededOpenIdentityProvider } from "@evelandhq/db/test";
import { createTestStore } from "@evelandhq/db/vitest";

import { IdentityBrokerError, createIdentityBroker, hashIdentityToken } from "./index.js";

const appSecretKey = "identity-test-secret-key-0000001";

describe("Identity Broker", () => {
  test("finalizes a provider-neutral identity into a separate hashed session", async () => {
    const store = createTestStore();
    const { connection, realm } = await configuredIdentity(store);
    const broker = createIdentityBroker({
      store,
      issuer: "https://identity.example.com",
      appSecretKey,
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });

    const result = await broker.finalizeIdentity({
      providerConnectionId: connection.id,
      providerSecurityRevision: connection.securityRevision,
      identity: {
        externalRealmId: "members",
        externalRealmKind: "internal",
        externalSubject: "user_123",
        displayName: "测试用户",
        email: "user@example.com",
      },
    });

    expect(result.sessionToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(result.session.tokenHash).toBe(hashIdentityToken(result.sessionToken));
    expect(result.session.tokenHash).not.toContain(result.sessionToken);
    expect(result.session.activeIdentityRealmId).toBe(realm.id);
    expect(result.principal).toMatchObject({
      id: expect.stringMatching(/^iprn_/),
      externalSubject: "user_123",
      displayName: "测试用户",
    });
  });

  test("refuses a weak APP_SECRET_KEY at construction like every other sealed-envelope home", () => {
    expect(() =>
      createIdentityBroker({
        store: createTestStore(),
        issuer: "https://identity.example.com",
        appSecretKey: "too-short",
      }),
    ).toThrow(/APP_SECRET_KEY must be 32 bytes or a base64 encoded 32-byte value/);
  });

  test("rejects an unknown or disabled external Realm before creating a session", async () => {
    const store = createTestStore();
    const { connection } = await configuredIdentity(store);
    const broker = createIdentityBroker({
      store,
      issuer: "https://identity.example.com",
      appSecretKey,
    });

    await expect(
      broker.finalizeIdentity({
        providerConnectionId: connection.id,
        providerSecurityRevision: connection.securityRevision,
        identity: {
          externalRealmId: "browser-supplied-realm",
          externalRealmKind: "internal",
          externalSubject: "user_123",
        },
      }),
    ).rejects.toMatchObject({
      code: "identity_realm_not_allowed",
      status: 403,
    });
  });

  test("issues a short ES256 project-bound Caller Token without Project grants", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "caller-agent", importKind: "zip" });
    const { connection, realm } = await configuredIdentity(store);
    const broker = createIdentityBroker({
      store,
      issuer: "https://identity.example.com",
      appSecretKey,
      now: () => new Date("2029-01-01T00:00:00.000Z"),
      callerTokenTtlSeconds: 60,
    });
    const finalized = await broker.finalizeIdentity({
      providerConnectionId: connection.id,
      providerSecurityRevision: connection.securityRevision,
      identity: {
        externalRealmId: "members",
        externalRealmKind: "internal",
        externalSubject: "user_123",
        displayName: "测试用户",
        email: "user@example.com",
      },
    });

    const issued = await broker.issueCallerToken({
      sessionToken: finalized.sessionToken,
      projectId: project.id,
    });
    const [encodedHeader, encodedPayload, encodedSignature] = issued.token.split(".");
    const header = decodeJson(encodedHeader!);
    const payload = decodeJson(encodedPayload!);
    const jwks = await broker.getJwks();
    const publicKey = createPublicKey({
      key: jwks.keys[0]!,
      format: "jwk",
    });

    expect(header).toMatchObject({ alg: "ES256", typ: "JWT", kid: expect.any(String) });
    expect(payload).toMatchObject({
      iss: "https://identity.example.com",
      sub: finalized.principal.id,
      aud: `eveland:project:${project.id}`,
      principal_type: "user",
      realm_id: realm.id,
      name: "测试用户",
      email: "user@example.com",
      iat: 1861920000,
      nbf: 1861920000,
      exp: 1861920060,
      jti: expect.any(String),
    });
    expect(payload).not.toHaveProperty("external_subject");
    expect(payload).not.toHaveProperty("provider");
    expect(
      verify(
        "sha256",
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(encodedSignature!, "base64url"),
      ),
    ).toBe(true);
    expect(issued.expiresAt).toBe("2029-01-01T00:01:00.000Z");
  });

  test("fails closed when a session, Realm, or provider is no longer active", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "revoked-agent", importKind: "zip" });
    const { connection, realm } = await configuredIdentity(store);
    const broker = createIdentityBroker({
      store,
      issuer: "https://identity.example.com",
      appSecretKey,
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });
    const finalized = await broker.finalizeIdentity({
      providerConnectionId: connection.id,
      providerSecurityRevision: connection.securityRevision,
      identity: {
        externalRealmId: "members",
        externalRealmKind: "internal",
        externalSubject: "user_123",
      },
    });
    await store.updateIdentityRealm(realm.id, {
      displayName: realm.displayName,
      enabled: false,
    });

    await expect(
      broker.issueCallerToken({
        sessionToken: finalized.sessionToken,
        projectId: project.id,
      }),
    ).rejects.toBeInstanceOf(IdentityBrokerError);
    await expect(
      broker.issueCallerToken({
        sessionToken: finalized.sessionToken,
        projectId: project.id,
      }),
    ).rejects.toMatchObject({ code: "identity_session_invalid", status: 401 });
  });

  test("allows only registered origins and relative return paths", async () => {
    const store = createTestStore();
    await store.upsertIdentityReturnTarget({
      key: "eve-chats",
      origin: "https://chat.example.com",
      enabled: true,
    });
    const broker = createIdentityBroker({
      store,
      issuer: "https://identity.example.com",
      appSecretKey,
    });

    await expect(broker.resolveReturnTarget("eve-chats", "/agents/agent_123")).resolves.toBe(
      "https://chat.example.com/agents/agent_123",
    );
    await expect(
      broker.resolveReturnTarget("eve-chats", "https://evil.example"),
    ).rejects.toMatchObject({ code: "identity_return_target_invalid" });
    await expect(broker.resolveReturnTarget("unknown", "/")).rejects.toMatchObject({
      code: "identity_return_target_invalid",
    });
  });
});

async function configuredIdentity(store: ReturnType<typeof createTestStore>) {
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
    displayName: "Members",
    enabled: true,
  });
  return { connection, realm };
}

function decodeJson(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("Platform Caller Token minting", () => {
  test("mints a long-lived shared-Principal token under open access", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "open-mint", importKind: "zip" });
    const broker = createIdentityBroker({
      store,
      issuer: "https://identity.example.com",
      appSecretKey,
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });

    const first = await broker.issueOpenModeCallerToken({ projectId: project.id });
    const second = await broker.issueOpenModeCallerToken({ projectId: project.id });

    const claims = decodeClaims(first.token);
    expect(claims).toMatchObject({
      aud: `eveland:project:${project.id}`,
      principal_type: "user",
      sub: expect.stringMatching(/^iprn_/),
      realm_id: expect.stringMatching(/^irlm_/),
    });
    // Open access carries no identity to revoke, so a short lifetime buys
    // nothing; the long one is what keeps an Identity outage invisible.
    expect((claims.exp as number) - (claims.iat as number)).toBe(20 * 60);
    // Every caller shares one Principal -- a second mint must not fork it.
    expect(decodeClaims(second.token).sub).toBe(claims.sub);
    expect(decodeClaims(second.token).realm_id).toBe(claims.realm_id);
  });

  test("materializes the shared identity for an instance that switched to open access", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "switched", importKind: "zip" });
    // No seeded Realm: this instance created its open Provider through the UI.
    await disableSeededOpenIdentityProvider(store);
    const provider = await store.createIdentityProviderConnection({
      type: "open",
      displayName: "Open for all",
      enabled: true,
    });
    const broker = createIdentityBroker({
      store,
      issuer: "https://identity.example.com",
      appSecretKey,
    });

    const minted = await broker.issueOpenModeCallerToken({ projectId: project.id });

    const realms = await store.listIdentityRealms(provider.id);
    expect(realms).toEqual([
      expect.objectContaining({ externalRealmId: "open-shared", enabled: true }),
    ]);
    expect(decodeClaims(minted.token).realm_id).toBe(realms[0]!.id);
  });

  test("refuses anonymous minting once open access is switched off", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "internal-only", importKind: "zip" });
    await configuredIdentity(store);
    const broker = createIdentityBroker({
      store,
      issuer: "https://identity.example.com",
      appSecretKey,
    });

    // The Gateway reads this as "stop injecting", so it must not be reported
    // as a transient fault it should retry through.
    await expect(broker.issueOpenModeCallerToken({ projectId: project.id })).rejects.toMatchObject({
      code: "identity_open_access_inactive",
      status: 409,
    });
  });

  test("mints for the signed-in control-plane user under Eveland Internal", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "internal-mint", importKind: "zip" });
    const { realm } = await configuredIdentity(store);
    const broker = createIdentityBroker({
      store,
      issuer: "https://identity.example.com",
      appSecretKey,
    });

    const minted = await broker.mintPlatformCallerToken({
      projectId: project.id,
      controlPlaneUser: {
        externalSubject: "user_a",
        displayName: "测试用户",
        email: "user-a@example.com",
      },
    });

    const claims = decodeClaims(minted.token);
    expect(claims).toMatchObject({
      realm_id: realm.id,
      name: "测试用户",
      email: "user-a@example.com",
    });
    // Eveland Internal names a real person, so it keeps the short lifetime.
    expect((claims.exp as number) - (claims.iat as number)).toBe(60);
    // The Playground has the user authenticated to the control plane already;
    // a second long-lived Identity Session row would be state nobody reads.
    const principal = await store.getIdentityPrincipal(claims.sub as string);
    expect(principal?.externalSubject).toBe("user_a");
  });
});

function decodeClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}
