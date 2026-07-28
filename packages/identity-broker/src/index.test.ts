import { createPublicKey, verify } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createTestStore } from "@eveland/db/vitest";

import {
  IdentityBrokerError,
  createIdentityBroker,
  hashIdentityToken,
} from "./index.js";

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

  test("rejects an unknown or disabled external Realm before creating a session", async () => {
    const store = createTestStore();
    const { connection } = await configuredIdentity(store);
    const broker = createIdentityBroker({
      store,
      issuer: "https://identity.example.com",
      appSecretKey,
    });

    await expect(broker.finalizeIdentity({
      providerConnectionId: connection.id,
      providerSecurityRevision: connection.securityRevision,
      identity: {
        externalRealmId: "browser-supplied-realm",
        externalRealmKind: "internal",
        externalSubject: "user_123",
      },
    })).rejects.toMatchObject({
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
    expect(verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(encodedSignature!, "base64url"),
    )).toBe(true);
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

    await expect(broker.issueCallerToken({
      sessionToken: finalized.sessionToken,
      projectId: project.id,
    })).rejects.toBeInstanceOf(IdentityBrokerError);
    await expect(broker.issueCallerToken({
      sessionToken: finalized.sessionToken,
      projectId: project.id,
    })).rejects.toMatchObject({ code: "identity_session_invalid", status: 401 });
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

    await expect(broker.resolveReturnTarget("eve-chats", "/agents/agent_123"))
      .resolves.toBe("https://chat.example.com/agents/agent_123");
    await expect(broker.resolveReturnTarget("eve-chats", "https://evil.example"))
      .rejects.toMatchObject({ code: "identity_return_target_invalid" });
    await expect(broker.resolveReturnTarget("unknown", "/"))
      .rejects.toMatchObject({ code: "identity_return_target_invalid" });
  });
});

async function configuredIdentity(store: ReturnType<typeof createTestStore>) {
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
