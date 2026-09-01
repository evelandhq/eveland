import { describe, expect, test } from "vitest";
import { createAuthApp, signIn } from "./auth-routes.test-support.js";
import { DEVICE_CODE_GRANT_TYPE } from "@better-auth/oauth-provider";
import { EVELAND_CLI_CLIENT_ID } from "./cli-auth.js";

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

async function requestDeviceCode(app: Awaited<ReturnType<typeof createAuthApp>>["app"]) {
  const response = await app.request("/api/auth/device/code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: EVELAND_CLI_CLIENT_ID, scope: "deploy observe" }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as DeviceCodeResponse;
}

function pollToken(app: Awaited<ReturnType<typeof createAuthApp>>["app"], deviceCode: string) {
  // The token endpoint is strict RFC 6749: form-encoded only.
  return app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: EVELAND_CLI_CLIENT_ID,
    }).toString(),
  });
}

// The RFC 8628 poll interval is real (5s); tests rewind the stored
// lastPolledAt instead of sleeping so consecutive polls do not trip
// slow_down.
async function rewindPollClock(
  auth: Awaited<ReturnType<typeof createAuthApp>>["auth"],
  userCode: string,
) {
  const context = await auth.auth.$context;
  await context.adapter.update({
    model: "deviceCode",
    where: [{ field: "userCode", value: userCode }],
    update: { lastPolledAt: new Date(Date.now() - 60_000) },
  });
}

describe("eveland CLI device authorization", () => {
  test("issues a scoped access token through request -> approve -> poll", async () => {
    const { app, auth } = await createAuthApp();
    const issued = await requestDeviceCode(app);
    expect(issued.verification_uri).toBe("http://localhost:3000/device");
    expect(issued.verification_uri_complete).toContain(issued.user_code);

    // Pending until the user approves in the Dashboard.
    const pending = await pollToken(app, issued.device_code);
    expect(pending.status).toBe(400);
    await expect(pending.json()).resolves.toMatchObject({ error: "authorization_pending" });

    const { cookie } = await signIn(app);
    // The approval page previews the request with the browser session; this
    // GET also claims the code for that session — approve/deny refuse codes
    // no signed-in session has looked at.
    const preview = await app.request(
      `/api/auth/device?user_code=${encodeURIComponent(issued.user_code)}`,
      { headers: { cookie } },
    );
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      user_code: issued.user_code,
      status: "pending",
      client_id: EVELAND_CLI_CLIENT_ID,
      scope: "deploy observe",
    });

    const approve = await app.request("/api/auth/device/approve", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({ userCode: issued.user_code }),
    });
    expect(approve.status).toBe(200);

    await rewindPollClock(auth, issued.user_code);
    const redeemed = await pollToken(app, issued.device_code);
    expect(redeemed.status).toBe(200);
    const tokens = (await redeemed.json()) as {
      access_token: string;
      token_type: string;
      scope: string;
    };
    expect(tokens.token_type.toLowerCase()).toBe("bearer");
    expect(tokens.scope.split(" ").sort()).toEqual(["deploy", "observe"]);

    // The token authenticates the CLI surface and reports its scopes.
    const whoami = await app.request("/api/members/me", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(whoami.status).toBe(200);
    await expect(whoami.json()).resolves.toEqual({
      member: expect.objectContaining({
        email: "admin@example.com",
        tokenScopes: ["deploy", "observe"],
      }),
    });

    // Scope boundary: the token never reaches team administration or the
    // operator surface, even though its owner is an admin.
    for (const path of ["/api/members", "/api/invitations", "/api/system/configuration"]) {
      const blocked = await app.request(path, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      expect(blocked.status).toBe(403);
      await expect(blocked.json()).resolves.toEqual({
        error: "Token scope does not allow this request",
      });
    }

    // Instance policy is readable with any token scope — the deploy
    // preflight fetches the eve window before uploading anything.
    const instance = await app.request("/api/instance", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(instance.status).toBe(200);
    await expect(instance.json()).resolves.toEqual({
      eve: {
        supportedRanges: expect.arrayContaining([expect.stringMatching(/^0\.\d+\.x$/)]),
        expected: expect.stringContaining("0."),
        latestVerified: expect.stringMatching(/^0\.\d+\.\d+$/),
      },
    });

    // A garbage bearer token is unauthenticated, not a scope failure.
    const badToken = await app.request("/api/members/me", {
      headers: { authorization: "Bearer not-a-token" },
    });
    expect(badToken.status).toBe(401);
  });

  test("deny settles the code as access_denied", async () => {
    const { app } = await createAuthApp();
    const issued = await requestDeviceCode(app);
    const { cookie } = await signIn(app);
    // Claim the code for the verifying session before denying.
    expect(
      (
        await app.request(`/api/auth/device?user_code=${encodeURIComponent(issued.user_code)}`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(200);
    const deny = await app.request("/api/auth/device/deny", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({ userCode: issued.user_code }),
    });
    expect(deny.status).toBe(200);

    const denied = await pollToken(app, issued.device_code);
    expect(denied.status).toBe(400);
    await expect(denied.json()).resolves.toMatchObject({ error: "access_denied" });
  });

  test("rejects unknown clients and out-of-policy scopes", async () => {
    const { app } = await createAuthApp();
    const unknownClient = await app.request("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "not-registered" }),
    });
    expect(unknownClient.status).toBeGreaterThanOrEqual(400);

    const badScope = await app.request("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: EVELAND_CLI_CLIENT_ID, scope: "deploy admin" }),
    });
    expect(badScope.status).toBeGreaterThanOrEqual(400);
  });

  test("bounds the device-code table: expired rows swept, oldest unclaimed evicted, claimed exempt", async () => {
    const { app, auth } = await createAuthApp();
    const context = await auth.auth.$context;

    // Expired residue (codes nobody ever polled again) is swept by the next
    // successful code request instead of accumulating forever.
    await context.adapter.create({
      model: "deviceCode",
      data: {
        deviceCode: "stale-device-code",
        userCode: "STALE-CODE",
        expiresAt: new Date(Date.now() - 60_000),
        status: "pending",
      },
    });
    await requestDeviceCode(app);
    const stale = await context.adapter.findOne({
      model: "deviceCode",
      where: [{ field: "userCode", value: "STALE-CODE" }],
    });
    expect(stale).toBeNull();

    // Fill past the cap with unclaimed pending codes; make the second-oldest
    // one CLAIMED (a session looked at it). New requests keep succeeding —
    // refusing at the cap would let 100 anonymous requests lock every login
    // out — and eviction takes the oldest unclaimed codes, never claimed
    // ones, so an in-flight approval survives a flood.
    for (let index = 0; index < 100; index += 1) {
      await context.adapter.create({
        model: "deviceCode",
        data: {
          deviceCode: `filler-device-${index}`,
          userCode: `FILLER-${index}`,
          // Uniform TTL in production means expiry order == issuance order;
          // these fillers expire before the real codes issued in this test,
          // like an attacker's earlier flood would. Lower index = older.
          expiresAt: new Date(Date.now() + 60_000 + index * 100),
          status: "pending",
          ...(index === 1 ? { userId: "user_local_admin" } : {}),
        },
      });
    }
    const admitted = await app.request("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: EVELAND_CLI_CLIENT_ID, scope: "deploy observe" }),
    });
    expect(admitted.status).toBe(200);

    const live = await context.adapter.count({
      model: "deviceCode",
      where: [{ field: "expiresAt", operator: "gt", value: new Date() }],
    });
    expect(live).toBeLessThanOrEqual(100);
    // Oldest unclaimed evicted; the claimed one right after it survives.
    await expect(
      context.adapter.findOne({
        model: "deviceCode",
        where: [{ field: "userCode", value: "FILLER-0" }],
      }),
    ).resolves.toBeNull();
    await expect(
      context.adapter.findOne({
        model: "deviceCode",
        where: [{ field: "userCode", value: "FILLER-1" }],
      }),
    ).resolves.not.toBeNull();
  });

  test("rate-limits unauthenticated code requests per forwarded source", async () => {
    const { app } = await createAuthApp();
    const request = (address: string) =>
      app.request("/api/auth/device/code", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": address,
        },
        body: JSON.stringify({ client_id: EVELAND_CLI_CLIENT_ID }),
      });
    for (let index = 0; index < 10; index += 1) {
      expect((await request("203.0.113.9")).status).toBe(200);
    }
    const throttled = await request("203.0.113.9");
    expect(throttled.status).toBe(429);
    await expect(throttled.json()).resolves.toMatchObject({ error: "slow_down" });
    // A different source is unaffected.
    expect((await request("203.0.113.10")).status).toBe(200);
  });

  test("keeps the rest of the oauth provider surface unroutable", async () => {
    const { app } = await createAuthApp();
    for (const path of [
      "/api/auth/oauth2/register",
      "/api/auth/oauth2/authorize",
      "/api/auth/oauth2/introspect",
      "/api/auth/oauth2/revoke",
      "/api/auth/oauth2/userinfo",
      "/api/auth/device/token",
    ]) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: "{}",
      });
      expect(response.status).toBe(404);
    }
  });
});
