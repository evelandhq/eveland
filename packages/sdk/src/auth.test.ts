import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { describe, expect, test, vi } from "vitest";
import {
  httpBasic,
  UnauthenticatedError,
  localDev,
  routeAuth,
} from "eve/channels/auth";

import {
  evelandIdentity,
  parseEvelandAuthenticationChallenge,
} from "./auth.js";

const issuer = "https://identity.eveland.example";
const projectId = "proj_agent";

describe("evelandIdentity", () => {
  test("maps a valid project-bound Caller Token to an Eve user principal", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
      now: () => new Date("2029-01-01T00:00:30.000Z"),
    });

    await expect(auth(request(fixture.token()))).resolves.toEqual({
      authenticator: "eveland-identity",
      issuer,
      subject: "iprn_user",
      principalId: `${issuer}:iprn_user`,
      principalType: "user",
      attributes: {
        realmId: "irlm_members",
        name: "测试用户",
        email: "user@example.com",
      },
    });
  });

  test("accepts a Caller Token from an allowed realm and rejects other realms", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
      now: () => new Date("2029-01-01T00:00:30.000Z"),
      allowedRealms: ["irlm_members"],
    });

    await expect(auth(request(fixture.token()))).resolves.toMatchObject({
      attributes: expect.objectContaining({ realmId: "irlm_members" }),
    });
    // The broker mints a structurally valid token for any enabled realm, so
    // this one verifies -- only the Agent's own allowlist rejects it.
    await expect(
      auth(request(fixture.token({ realm_id: "irlm_contractors" }))),
    ).resolves.toBeNull();
  });

  test("reads the realm allowlist from EVELAND_ALLOWED_REALM_IDS", async () => {
    const previous = process.env.EVELAND_ALLOWED_REALM_IDS;
    process.env.EVELAND_ALLOWED_REALM_IDS = " irlm_staff , irlm_members ";
    try {
      const fixture = tokenFixture();
      const auth = evelandIdentity({
        issuer,
        projectId,
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        fetch: fixture.fetch,
        now: () => new Date("2029-01-01T00:00:30.000Z"),
      });

      await expect(auth(request(fixture.token()))).resolves.toMatchObject({
        attributes: expect.objectContaining({ realmId: "irlm_members" }),
      });
      await expect(
        auth(request(fixture.token({ realm_id: "irlm_contractors" }))),
      ).resolves.toBeNull();
    } finally {
      if (previous === undefined) delete process.env.EVELAND_ALLOWED_REALM_IDS;
      else process.env.EVELAND_ALLOWED_REALM_IDS = previous;
    }
  });

  test("accepts every realm when no allowlist is configured", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
      now: () => new Date("2029-01-01T00:00:30.000Z"),
    });

    await expect(
      auth(request(fixture.token({ realm_id: "irlm_contractors" }))),
    ).resolves.toMatchObject({
      attributes: expect.objectContaining({ realmId: "irlm_contractors" }),
    });
  });

  test("accepts a Caller Token whose IdP supplied no display name", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
      now: () => new Date("2029-01-01T00:00:30.000Z"),
    });

    // Eveland omits the claim when the IdP supplies no display name. Refusing
    // a cryptographically valid, correctly-audienced token over a cosmetic
    // claim turned those users into a silent 401 with nothing to diagnose.
    const principal = await auth(request(fixture.token({ name: undefined })));

    expect(principal).toMatchObject({
      subject: "iprn_user",
      principalType: "user",
      attributes: { realmId: "irlm_members", email: "user@example.com" },
    });
    expect(principal?.attributes).not.toHaveProperty("name");
  });

  test("still rejects a Caller Token whose name claim is the wrong type", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
      now: () => new Date("2029-01-01T00:00:30.000Z"),
    });

    await expect(
      auth(request(fixture.token({ name: 42 }))),
    ).resolves.toBeNull();
  });

  test("rejects a Caller Token carrying a raw external Realm value", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
      now: () => new Date("2029-01-01T00:00:30.000Z"),
    });

    await expect(
      auth(request(fixture.token({ realm_id: "github-org-123" }))),
    ).resolves.toBeNull();
  });

  test("rejects a Caller Token carrying a non-Eveland principal id", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
    });

    await expect(
      auth(request(fixture.token({ sub: "github-user-123" }))),
    ).resolves.toBeNull();
  });

  test("rejects malformed optional profile claims instead of dropping them", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
    });

    await expect(
      auth(request(fixture.token({ email: 123 }))),
    ).resolves.toBeNull();
  });

  test("fails closed when a Caller Token reaches an unconfigured Agent", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer: "",
      projectId: "",
      jwksUrl: "",
      fetch: fixture.fetch,
    });

    await expect(auth(request(fixture.token()))).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  test("fails closed when Eveland signing keys are unavailable", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => {
        throw new Error("network unavailable");
      },
    });

    await expect(auth(request(fixture.token()))).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  test("fails closed when a matching Eveland signing key is malformed", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () =>
        Response.json({
          keys: [{ kid: "key-1", kty: "EC", alg: "ES256", use: "sig" }],
        }),
    });

    await expect(auth(request(fixture.token()))).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  test("caches verified signing keys between requests", async () => {
    const fixture = tokenFixture();
    const fetchJwks = vi.fn(fixture.fetch);
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fetchJwks,
      now: () => new Date("2029-01-01T00:00:30.000Z"),
    });

    await expect(auth(request(fixture.token()))).resolves.toMatchObject({
      subject: "iprn_user",
    });
    await expect(auth(request(fixture.token()))).resolves.toMatchObject({
      subject: "iprn_user",
    });
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  test("refreshes cached signing keys when a rotated kid appears", async () => {
    const first = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const rotated = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = (key: KeyObject, kid: string) => ({
      ...key.export({ format: "jwk" }),
      kid,
      alg: "ES256",
      use: "sig",
    });
    const fetchJwks = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ keys: [jwk(first.publicKey, "key-1")] }))
      .mockResolvedValueOnce(
        Response.json({
          keys: [
            jwk(first.publicKey, "key-1"),
            jwk(rotated.publicKey, "key-2"),
          ],
        }),
      );
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fetchJwks,
      now: () => new Date("2029-01-01T00:00:30.000Z"),
    });
    const claims = {
      iss: issuer,
      sub: "iprn_user",
      aud: `eveland:project:${projectId}`,
      principal_type: "user",
      realm_id: "irlm_members",
      name: "测试用户",
      iat: 1_700_000_000,
      nbf: 1_700_000_000,
      exp: 2_000_000_000,
      jti: "jti-rotation",
    };

    await expect(
      auth(request(signedToken(first.privateKey, "key-1", claims))),
    ).resolves.toMatchObject({ subject: "iprn_user" });
    await expect(
      auth(request(signedToken(rotated.privateKey, "key-2", claims))),
    ).resolves.toMatchObject({ subject: "iprn_user" });
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  test("rejects a Caller Token issued in the future", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
      now: () => new Date("2029-01-01T00:00:30.000Z"),
    });

    await expect(
      auth(request(fixture.token({ iat: 2_000_000_000 }))),
    ).resolves.toBeNull();
  });

  test("rejects a Caller Token without a replay-trace identifier", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
    });

    await expect(
      auth(request(fixture.token({ jti: undefined }))),
    ).resolves.toBeNull();
  });

  test("requires the complete Caller Token time window", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
    });

    await expect(
      auth(request(fixture.token({ nbf: undefined }))),
    ).resolves.toBeNull();
  });

  test("rejects a token whose protected header is not an ES256 JWT", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
    });

    await expect(
      auth(request(fixture.token({}, { typ: "JOSE" }))),
    ).resolves.toBeNull();
  });

  test("lets an explicit localDev fallback handle unrecognized credentials", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
    });

    await expect(
      routeAuth(
        request("not-a-jwt", "http://localhost/eve/v1/session"),
        [auth, localDev()],
      ),
    ).resolves.toMatchObject({
      authenticator: "local-dev",
      principalType: "local-dev",
    });
  });

  test("advertises an Eveland continuation without suppressing Basic fallback", async () => {
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
    });

    const result = await routeAuth(
      new Request("https://agent.example/eve/v1/session", { method: "POST" }),
      [
        auth,
        httpBasic(
          { username: "agent", password: "secret" },
          { realm: "agent" },
        ),
      ],
    );

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate");
    expect(challenge).toContain('Basic realm="agent"');
    expect(parseEvelandAuthenticationChallenge(challenge)).toEqual({
      kind: "eveland",
      url: `${issuer}/identity/login`,
      projectId,
      displayName: "Eveland",
    });
  });
});

function tokenFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const kid = "key-1";
  return {
    fetch: async () =>
      Response.json({
        keys: [
          {
            ...publicKey.export({ format: "jwk" }),
            kid,
            alg: "ES256",
            use: "sig",
          },
        ],
      }),
    token: (
      overrides: Record<string, unknown> = {},
      headerOverrides: Record<string, unknown> = {},
    ) =>
      signedToken(privateKey, kid, {
        iss: issuer,
        sub: "iprn_user",
        aud: `eveland:project:${projectId}`,
        principal_type: "user",
        realm_id: "irlm_members",
        name: "测试用户",
        email: "user@example.com",
        iat: 1_700_000_000,
        nbf: 1_700_000_000,
        exp: 2_000_000_000,
        jti: "jti-1",
        ...overrides,
      }, headerOverrides),
  };
}

function signedToken(
  privateKey: KeyObject,
  kid: string,
  claims: Record<string, unknown>,
  headerOverrides: Record<string, unknown> = {},
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", typ: "JWT", kid, ...headerOverrides }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(input), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${input}.${signature}`;
}

function request(
  token: string,
  url = "https://agent.example/eve/v1/session",
): Request {
  return new Request(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}
