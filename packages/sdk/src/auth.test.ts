import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { describe, expect, test, vi } from "vitest";
import { httpBasic, routeAuth } from "eve/channels/auth";

import { evelandIdentity, parseEvelandAuthenticationChallenge } from "./auth.js";

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

    await expect(auth(request(fixture.token({ name: 42 })))).resolves.toBeNull();
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

    await expect(auth(request(fixture.token({ realm_id: "github-org-123" })))).resolves.toBeNull();
  });

  test("rejects a Caller Token carrying a non-Eveland principal id", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
    });

    await expect(auth(request(fixture.token({ sub: "github-user-123" })))).resolves.toBeNull();
  });

  test("rejects malformed optional profile claims instead of dropping them", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
    });

    await expect(auth(request(fixture.token({ email: 123 })))).resolves.toBeNull();
  });

  // Every infrastructure failure below declines rather than throws. Throwing
  // aborts Eve's whole auth walk, so `[evelandIdentity(), httpBasic()]` could
  // never reach Basic while Eveland was degraded. Declining silently is only
  // diagnosable through the log, so each case asserts the reason was recorded.
  test("declines and reports why when a Caller Token reaches an unconfigured Agent", async () => {
    const fixture = tokenFixture();
    const logger = vi.fn();
    const auth = evelandIdentity({
      issuer: "",
      projectId: "",
      jwksUrl: "",
      fetch: fixture.fetch,
      logger,
    });

    await expect(auth(request(fixture.token()))).resolves.toBeNull();
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("not configured"),
      expect.objectContaining({
        missing: ["EVELAND_IDENTITY_ISSUER", "EVELAND_PROJECT_ID", "EVELAND_IDENTITY_JWKS_URL"],
      }),
    );
  });

  test("declines and reports why when the Eveland key set is unreachable", async () => {
    const fixture = tokenFixture();
    const logger = vi.fn();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => {
        throw new Error("network unavailable");
      },
      logger,
    });

    await expect(auth(request(fixture.token()))).resolves.toBeNull();
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("could not be fetched"),
      expect.objectContaining({
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        error: "network unavailable",
      }),
    );
  });

  test("declines and reports the status when the Eveland key set errors", async () => {
    const fixture = tokenFixture();
    const logger = vi.fn();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => new Response("upstream failure", { status: 503 }),
      logger,
    });

    await expect(auth(request(fixture.token()))).resolves.toBeNull();
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("error status"),
      expect.objectContaining({ status: 503 }),
    );
  });

  test("declines and reports why when the Eveland key set is not a key set", async () => {
    const fixture = tokenFixture();
    const logger = vi.fn();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => Response.json({ keys: "not-an-array" }),
      logger,
    });

    await expect(auth(request(fixture.token()))).resolves.toBeNull();
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("malformed"),
      expect.objectContaining({ jwksUrl: `${issuer}/.well-known/jwks.json` }),
    );
  });

  test("declines and reports both sides when a token is bound to another Project", async () => {
    const fixture = tokenFixture();
    const logger = vi.fn();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
      now: () => new Date("2029-01-01T00:00:30.000Z"),
      logger,
    });

    // A Caller Token is audience-bound to one Project, and the Gateway mints
    // one per Project. Getting that keying wrong rejects every token here, and
    // an audience mismatch is indistinguishable from "not our token" -- so the
    // log has to name what the two sides expected.
    const otherProject = await auth(request(fixture.token({ aud: "eveland:project:proj_other" })));

    expect(otherProject).toBeNull();
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("failed verification"),
      expect.objectContaining({
        expectedAudience: `eveland:project:${projectId}`,
        tokenAudience: "eveland:project:proj_other",
        expectedIssuer: issuer,
      }),
    );
  });

  test("declines and reports the kid when a matching Eveland signing key is malformed", async () => {
    const fixture = tokenFixture();
    const logger = vi.fn();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () =>
        Response.json({
          keys: [{ kid: "key-1", kty: "EC", alg: "ES256", use: "sig" }],
        }),
      logger,
    });

    await expect(auth(request(fixture.token()))).resolves.toBeNull();
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("could not be imported"),
      expect.objectContaining({ kid: "key-1" }),
    );
  });

  test("keeps authenticating from cached signing keys while Eveland is unreachable", async () => {
    const fixture = tokenFixture();
    const logger = vi.fn();
    let current = new Date("2029-01-01T00:00:30.000Z").getTime();
    let reachable = true;
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => {
        if (!reachable) throw new Error("network unavailable");
        return fixture.fetch();
      },
      now: () => new Date(current),
      logger,
    });

    await expect(auth(request(fixture.token()))).resolves.toMatchObject({
      subject: "iprn_user",
    });

    // The Identity service goes down and the fresh window lapses: the cached
    // key set has to carry every already-authenticated user through it.
    reachable = false;
    current += 5 * 60_000;
    await expect(auth(request(fixture.token()))).resolves.toMatchObject({
      subject: "iprn_user",
    });
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("Continuing with cached signing keys"),
      expect.objectContaining({ jwksUrl: `${issuer}/.well-known/jwks.json` }),
    );

    // The grace window is bounded: once it lapses the stale keys are dropped
    // rather than trusted indefinitely.
    current += 60 * 60_000;
    await expect(auth(request(fixture.token()))).resolves.toBeNull();
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("No usable cached signing keys remain"),
      expect.objectContaining({ jwksUrl: `${issuer}/.well-known/jwks.json` }),
    );
  });

  test("backs off instead of refetching a failing key set on every request", async () => {
    const fixture = tokenFixture();
    let current = new Date("2029-01-01T00:00:30.000Z").getTime();
    let reachable = true;
    const fetchJwks = vi.fn(async () => {
      if (!reachable) throw new Error("network unavailable");
      return fixture.fetch();
    });
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fetchJwks,
      now: () => new Date(current),
      logger: () => {},
    });

    await expect(auth(request(fixture.token()))).resolves.toMatchObject({
      subject: "iprn_user",
    });
    reachable = false;
    current += 5 * 60_000;

    // One failed refresh, then two more requests inside the backoff floor.
    await auth(request(fixture.token()));
    await auth(request(fixture.token()));
    await auth(request(fixture.token()));
    expect(fetchJwks).toHaveBeenCalledTimes(2);
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
          keys: [jwk(first.publicKey, "key-1"), jwk(rotated.publicKey, "key-2")],
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

    await expect(auth(request(fixture.token({ iat: 2_000_000_000 })))).resolves.toBeNull();
  });

  test("rejects a Caller Token without a replay-trace identifier", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
    });

    await expect(auth(request(fixture.token({ jti: undefined })))).resolves.toBeNull();
  });

  test("requires the complete Caller Token time window", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
    });

    await expect(auth(request(fixture.token({ nbf: undefined })))).resolves.toBeNull();
  });

  test("rejects a token whose protected header is not an ES256 JWT", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
    });

    await expect(auth(request(fixture.token({}, { typ: "JOSE" })))).resolves.toBeNull();
  });

  test("lets an explicit fallback handle unrecognized credentials", async () => {
    const fixture = tokenFixture();
    const auth = evelandIdentity({
      issuer,
      projectId,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: fixture.fetch,
    });

    // The fallback is httpBasic rather than localDev: from Eve 0.30, localDev()
    // admits nothing unless the process is `eve dev`, so it could no longer
    // show that the walk continued. What matters here is that a credential
    // this AuthFn does not recognize reaches the next one and authenticates
    // there, instead of ending the walk.
    const basic = Buffer.from("agent:secret").toString("base64");
    await expect(
      routeAuth(
        new Request("https://agent.example/eve/v1/session", {
          method: "POST",
          headers: { authorization: `Basic ${basic}` },
        }),
        [auth, httpBasic({ username: "agent", password: "secret" }, { realm: "agent" })],
      ),
    ).resolves.toMatchObject({
      authenticator: "http-basic",
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
      [auth, httpBasic({ username: "agent", password: "secret" }, { realm: "agent" })],
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
      signedToken(
        privateKey,
        kid,
        {
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
        },
        headerOverrides,
      ),
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

function request(token: string, url = "https://agent.example/eve/v1/session"): Request {
  return new Request(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}
