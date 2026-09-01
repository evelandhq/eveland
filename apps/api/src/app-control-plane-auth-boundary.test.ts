import type { AuthPrincipal } from "@evelandhq/core/contracts";
import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import {
  createDeviceCodeRateLimiter,
  registerControlPlaneAuthBoundary,
} from "./app-control-plane-auth-boundary.js";

test("device-code rate limiter has a hard source capacity with O(1) LRU eviction", () => {
  let clock = 0;
  const allow = createDeviceCodeRateLimiter(() => clock);

  // Per-source window: 10 pass, the 11th is refused, and the window slides.
  for (let index = 0; index < 10; index += 1) expect(allow("10.0.0.1")).toBe(true);
  expect(allow("10.0.0.1")).toBe(false);
  clock += 10 * 60_000 + 1;
  expect(allow("10.0.0.1")).toBe(true);

  // Capacity is a hard bound, not a scan trigger: flooding with more unique
  // keys than the table holds evicts the least-recently-active sources
  // instead of growing memory. An evicted source starts a fresh window
  // rather than carrying history — degrade open by design, and filling the
  // table now requires real address diversity (the gateway owns the key).
  for (let index = 0; index < 10; index += 1) allow("10.0.0.2");
  expect(allow("10.0.0.2")).toBe(false);
  for (let index = 0; index < 4_600; index += 1) allow(`flood-${index}`);
  for (let index = 0; index < 10; index += 1) expect(allow("10.0.0.2")).toBe(true);
});
import { registerMemberRoutes } from "./app-member-routes.js";
import { registerSystemDiagnosticsRoutes } from "./app-system-diagnostics-routes.js";
import { createAuthTestContext, signIn } from "./auth-routes.test-support.js";

test("composes the exact public auth surface before the protected control plane", async () => {
  const { auth, store } = await createAuthTestContext();
  const app = new Hono<{ Variables: { principal: AuthPrincipal } }>();
  const configurationDiagnostics = vi.fn(async () => ({ components: [] }));

  registerControlPlaneAuthBoundary({ app, auth });
  registerMemberRoutes({
    app,
    auth,
    webOrigin: "http://localhost:3000",
  });
  registerSystemDiagnosticsRoutes({
    app,
    store,
    configurationDiagnostics,
    gatewayHealth: async () => ({
      status: "healthy",
      message: "Gateway is healthy.",
      observedAt: "2026-08-01T00:00:00.000Z",
    }),
  });
  app.get("/protected-probe", (c) => c.json({ email: c.get("principal").email }));

  expect((await app.request("/api/auth/get-session")).status).toBe(200);
  // The device-authorization family is routable (better-auth answers 400 for
  // the missing parameters, not the allowlist's 404).
  for (const routable of [
    { path: "/api/auth/device", init: undefined },
    {
      path: "/api/auth/device/code",
      init: {
        method: "POST" as const,
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    },
    {
      path: "/api/auth/oauth2/token",
      init: {
        method: "POST" as const,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      },
    },
  ]) {
    expect((await app.request(routable.path, routable.init)).status, routable.path).not.toBe(404);
  }
  expect(
    (
      await app.request("/api/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request("/api/invitations/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request("/api/password-reset/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request("/api/password-reset/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(400);

  for (const path of [
    "/api/auth/sign-up/email",
    "/api/auth/change-password",
    "/api/auth/update-user",
    "/api/auth/organization/remove-member",
    "/api/auth/forget-password",
    "/api/auth/reset-password",
  ]) {
    expect(
      (
        await app.request(path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:3000",
          },
          body: "{}",
        })
      ).status,
    ).toBe(404);
  }

  const anonymousControlRequests: Array<{
    path: string;
    init?: RequestInit;
  }> = [
    { path: "/api/members/me" },
    {
      path: "/profile",
      init: {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not-json",
      },
    },
    {
      path: "/profile/password",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      },
    },
    { path: "/members" },
    {
      path: "/members/user_test",
      init: {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not-json",
      },
    },
    { path: "/members/user_test", init: { method: "DELETE" } },
    {
      path: "/members/user_test/password-reset",
      init: { method: "POST" },
    },
    { path: "/invitations" },
    {
      path: "/invitations",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      },
    },
    {
      path: "/invitations/invitation_test/resend",
      init: { method: "POST" },
    },
    {
      path: "/invitations/invitation_test",
      init: { method: "DELETE" },
    },
    { path: "/system/configuration" },
    { path: "/protected-probe" },
  ];
  for (const { path, init } of anonymousControlRequests) {
    const response = await app.request(path, init);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required",
    });
  }
  expect(configurationDiagnostics).not.toHaveBeenCalled();

  const { cookie } = await signIn(app);
  await expect(
    (await app.request("/api/members/me", { headers: { cookie } })).json(),
  ).resolves.toEqual({
    member: expect.objectContaining({
      email: "admin@example.com",
      role: "admin",
    }),
  });
  expect((await app.request("/api/members", { headers: { cookie } })).status).toBe(200);
  expect(
    (
      await app.request("/api/system/configuration", {
        headers: { cookie },
      })
    ).status,
  ).toBe(200);
  expect(configurationDiagnostics).toHaveBeenCalledOnce();
  await expect(
    (await app.request("/protected-probe", { headers: { cookie } })).json(),
  ).resolves.toEqual({ email: "admin@example.com" });

  const signOut = await app.request("/api/auth/sign-out", {
    method: "POST",
    headers: { cookie, origin: "http://localhost:3000" },
  });
  expect(signOut.status).toBe(200);
  expect((await app.request("/protected-probe", { headers: { cookie } })).status).toBe(401);
});
